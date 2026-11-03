"""Invitation acceptance: success, replay, invalid/expired/revoked tokens, duplicates,
concurrency and failures of the Auth Service or the database.

The Auth Service is replaced by a stateful fake that follows the real internal contract
(service key, idempotent account creation, conflicts, password policy).
"""
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

import app.activation as activation
from app.activation import get_internal_auth_client
from app.auth import get_auth_client
from app.main import app
from app.models import Organization, OrganizationInvitation

from conftest import fake_auth_client, token_from_message

ACTIVATION_KEY = "test-activation-key"
AUTH_KEY = "test-auth-key"
SUPER_ADMIN = {"id": "1", "email": "root@example.org", "full_name": "Root", "role": "super-admin", "is_active": True}
ADMIN = {"Authorization": "Bearer admin-token"}
KEY = {"X-Internal-Key": ACTIVATION_KEY}
GOOD_PASSWORD = "Str0ng!Passphrase"
ADMIN_EMAIL = "owner@acme.example"


class FakeAuthService:
    """Mimics POST /internal/organization-admins of the real Auth Service."""

    def __init__(self):
        self.users = {}  # email -> {"org": ..., "password": ..., "name": ...}
        self.calls = []  # (json body, headers) of account-creation calls
        self.prechecks = []  # json bodies of precheck calls
        self.updates = []  # json bodies of update calls
        self.deletes = []  # json bodies of delete calls
        self.demo = True  # does the "Auth Service" accept demo (weak) passwords?
        self.mode = None  # "down" | "500"
        self.delay = 0.0
        self._lock = threading.Lock()

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        is_precheck = request.url.path.endswith("/precheck")
        with self._lock:
            if is_precheck:
                self.prechecks.append(body)
            elif request.url.path.endswith("/update"):
                self.updates.append(body)
            elif request.url.path.endswith("/delete"):
                self.deletes.append(body)
            else:
                self.calls.append((body, dict(request.headers)))
        if self.delay:
            time.sleep(self.delay)
        if self.mode == "down":
            raise httpx.ConnectError("connection refused")
        if self.mode == "500":
            return httpx.Response(500, json={"detail": "boom"})
        if request.headers.get("x-internal-key") != AUTH_KEY:
            return httpx.Response(401, json={"detail": "Invalid service credentials"})
        if is_precheck:
            existing = self.users.get(body["email"])
            if existing is None:
                state = "available"
            elif existing["org"] == body["organization_id"]:
                state = "already_administrator"
            else:
                state = "email_taken"
            return httpx.Response(200, json={"state": state})
        if request.url.path.endswith("/update"):
            with self._lock:
                key = next((e for e in (body["email"], body.get("new_email")) if e in self.users
                            and self.users[e]["org"] == body["organization_id"]), None)
                if key is None:
                    return httpx.Response(404, json={"detail": {"code": "not_found", "message": "Administrator account not found."}})
                target = body.get("new_email")
                if target and target != key and target in self.users:
                    return httpx.Response(409, json={"detail": {"code": "email_taken", "message": "An account with this email address already exists."}})
                record = self.users.pop(key)
                if body.get("new_full_name"):
                    record["name"] = body["new_full_name"]
                self.users[target or key] = record
            return httpx.Response(200, json={"email": target or key})
        if request.url.path.endswith("/delete"):
            with self._lock:
                record = self.users.get(body["email"])
                deleted = bool(record and record["org"] == body["organization_id"])
                if deleted:
                    del self.users[body["email"]]
            return httpx.Response(200, json={"deleted": deleted})
        if body.get("allow_weak_password") and not self.demo:
            return httpx.Response(403, json={"detail": {"code": "demo_disabled", "message": "Demo passwords are not enabled."}})
        if len(body["password"]) < (8 if body.get("allow_weak_password") else 12):
            return httpx.Response(422, json={"detail": {
                "code": "weak_password", "message": "Password must contain: at least 12 characters.",
                "problems": ["at least 12 characters"]}})
        with self._lock:
            existing = self.users.get(body["email"])
            if existing is None:
                self.users[body["email"]] = {"org": body["organization_id"], "password": body["password"],
                                             "name": body["full_name"]}
                return httpx.Response(201, json={"created": True})
        if existing["org"] == body["organization_id"] and existing["password"] == body["password"]:
            return httpx.Response(200, json={"created": False})
        code = "account_exists" if existing["org"] == body["organization_id"] else "email_taken"
        return httpx.Response(409, json={"detail": {"code": code, "message": "An account already exists."}})


@pytest.fixture
def fake_auth():
    return FakeAuthService()


@pytest.fixture
def client(smtp, fake_auth, monkeypatch):
    monkeypatch.setenv("ACTIVATION_API_KEY", ACTIVATION_KEY)
    monkeypatch.setenv("AUTH_INTERNAL_API_KEY", AUTH_KEY)
    super_admin_check = fake_auth_client({"admin-token": (200, SUPER_ADMIN)})
    internal = httpx.Client(transport=httpx.MockTransport(fake_auth.handler), base_url="http://auth-service:8000")
    app.dependency_overrides[get_auth_client] = lambda: super_admin_check
    app.dependency_overrides[get_internal_auth_client] = lambda: internal
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_auth_client, None)
    app.dependency_overrides.pop(get_internal_auth_client, None)


def invite(client, smtp, slug="acme", email=ADMIN_EMAIL):
    """Create an organization and invite its primary admin; returns (organization json, plaintext token)."""
    org = client.post("/api/v1/organizations", headers=ADMIN, json={
        "name": "Acme Imports", "slug": slug, "country_code": "DE", "contact_email": "ops@acme.example",
        "primary_admin_email": email}).json()
    assert client.post(f"/api/v1/organizations/{org['id']}/invitations", headers=ADMIN).status_code == 201
    return org, token_from_message(smtp.messages[-1])


def lookup(client, token, headers=KEY):
    return client.post("/internal/invitations/lookup", json={"token": token}, headers=headers)


def accept(client, token, password=GOOD_PASSWORD, name="Olivia Owner", headers=KEY, **extra):
    return client.post("/internal/invitations/accept",
                       json={"token": token, "full_name": name, "password": password, **extra}, headers=headers)


def invitations(session_factory):
    with session_factory() as db:
        return db.scalars(select(OrganizationInvitation).order_by(OrganizationInvitation.created_at)).all()


def code_of(response):
    return response.json()["detail"]["code"]


# --- service authentication -------------------------------------------------
@pytest.mark.parametrize("call", [lookup, accept], ids=["lookup", "accept"])
def test_internal_endpoints_require_the_service_key(client, smtp, fake_auth, session_factory, call, monkeypatch):
    _, token = invite(client, smtp)
    assert call(client, token, headers={}).status_code == 401
    assert call(client, token, headers={"X-Internal-Key": "wrong"}).status_code == 401
    assert call(client, token, headers=ADMIN).status_code == 401  # a Super Admin bearer token is not a service key
    monkeypatch.delenv("ACTIVATION_API_KEY")
    assert call(client, token).status_code == 503  # fails closed when unconfigured
    assert fake_auth.calls == [] and invitations(session_factory)[0].accepted_at is None


def test_internal_endpoints_are_hidden_from_the_public_api_docs(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert not [p for p in paths if p.startswith("/internal")]


# --- lookup -----------------------------------------------------------------
def test_lookup_shows_only_the_organization_name_and_invited_email(client, smtp):
    _, token = invite(client, smtp)
    response = lookup(client, token)
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"organization_name", "email", "full_name", "expires_at"}
    assert (body["organization_name"], body["email"]) == ("Acme Imports", ADMIN_EMAIL)
    assert token not in response.text


def test_lookup_does_not_consume_the_token(client, smtp):
    _, token = invite(client, smtp)
    for _ in range(3):
        assert lookup(client, token).status_code == 200
    assert accept(client, token).status_code == 201


# --- successful activation --------------------------------------------------
def test_activation_creates_the_account_and_marks_the_invitation_accepted(client, smtp, fake_auth, session_factory):
    org, token = invite(client, smtp)
    response = accept(client, token)
    assert response.status_code == 201
    assert response.json() == {"organization_name": "Acme Imports", "email": ADMIN_EMAIL}

    (body, headers) = fake_auth.calls[0]
    assert set(body) == {"organization_id", "full_name", "email", "password"}  # no role is ever sent
    assert body["organization_id"] == org["id"] and body["email"] == ADMIN_EMAIL
    assert body["full_name"] == "Olivia Owner"
    assert headers["x-internal-key"] == AUTH_KEY
    assert len(fake_auth.users) == 1

    (invitation,) = invitations(session_factory)
    assert invitation.accepted_at is not None and invitation.revoked_at is None


def test_nothing_secret_is_stored_returned_or_logged(client, smtp, session_factory, caplog):
    caplog.set_level(logging.DEBUG)
    _, token = invite(client, smtp)
    lookup_response = lookup(client, token)
    response = accept(client, token)
    assert "accepted for organization" in caplog.text  # control: logging is really captured

    with session_factory() as db:
        stored = [str(v) for row in db.scalars(select(OrganizationInvitation)) for v in vars(row).values()]
        stored += [str(v) for row in db.scalars(select(Organization)) for v in vars(row).values()]
    for secret in (token, GOOD_PASSWORD):
        assert not any(secret in value for value in stored)
        assert secret not in response.text and secret not in lookup_response.text
        assert secret not in caplog.text


def test_callers_cannot_choose_the_organization_email_or_role(client, smtp, fake_auth):
    org, token = invite(client, smtp)
    response = accept(client, token, organization_id="00000000-0000-4000-8000-000000000000",
                      email="attacker@evil.example", role="super-admin", is_active=True)
    assert response.status_code == 201
    (body, _) = fake_auth.calls[0]
    assert body["organization_id"] == org["id"] and body["email"] == ADMIN_EMAIL
    assert "role" not in body and "is_active" not in body
    assert list(fake_auth.users) == [ADMIN_EMAIL]


# --- invalid / expired / revoked / reused tokens ----------------------------
@pytest.mark.parametrize("bad", ["", "short", "x" * 500, "a b c d e f g h i j k l m n", "' OR 1=1 --", "../../etc/passwd",
                                 "A" * 43])
@pytest.mark.parametrize("call", [lookup, accept], ids=["lookup", "accept"])
def test_unknown_or_malformed_tokens_are_rejected(client, fake_auth, call, bad):
    response = call(client, bad)
    assert response.status_code == 404 and code_of(response) == "invalid"
    assert fake_auth.calls == []


def test_expired_token_is_rejected(client, smtp, fake_auth, session_factory):
    _, token = invite(client, smtp)
    with session_factory() as db:
        db.scalars(select(OrganizationInvitation)).one().expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.commit()
    for call in (lookup, accept):
        response = call(client, token)
        assert response.status_code == 410 and code_of(response) == "expired"
    assert fake_auth.calls == [] and fake_auth.users == {}


def test_revoked_token_is_rejected_and_the_replacement_works(client, smtp, fake_auth):
    org, old_token = invite(client, smtp)
    assert client.post(f"/api/v1/organizations/{org['id']}/invitations/resend", headers=ADMIN).status_code == 201
    new_token = token_from_message(smtp.messages[-1])
    for call in (lookup, accept):
        response = call(client, old_token)
        assert response.status_code == 410 and code_of(response) == "revoked"
    assert fake_auth.calls == []
    assert accept(client, new_token).status_code == 201


def test_a_used_token_cannot_be_replayed(client, smtp, fake_auth):
    _, token = invite(client, smtp)
    assert accept(client, token).status_code == 201
    for call in (lookup, accept):
        response = call(client, token)
        assert response.status_code == 410 and code_of(response) == "used"
    replay = accept(client, token, password="An0ther!Passphrase")
    assert replay.status_code == 410
    assert len(fake_auth.calls) == 1  # the Auth Service was never asked again
    assert fake_auth.users[ADMIN_EMAIL]["password"] == GOOD_PASSWORD


def test_no_further_invitations_after_activation(client, smtp):
    org, token = invite(client, smtp)
    accept(client, token)
    assert client.post(f"/api/v1/organizations/{org['id']}/invitations", headers=ADMIN).status_code == 409
    assert client.post(f"/api/v1/organizations/{org['id']}/invitations/resend", headers=ADMIN).status_code == 409


# --- duplicates and validation from the Auth Service ------------------------
def test_existing_account_with_the_same_email_is_a_conflict_and_can_be_retried(client, smtp, fake_auth, session_factory):
    _, token = invite(client, smtp)
    fake_auth.users[ADMIN_EMAIL] = {"org": "some-other-org", "password": "x" * 12, "name": "Someone"}
    response = accept(client, token)
    assert response.status_code == 409 and code_of(response) == "email_taken"
    assert invitations(session_factory)[0].accepted_at is None  # still pending: nothing was consumed


def test_weak_password_is_rejected_without_consuming_the_token(client, smtp, session_factory):
    _, token = invite(client, smtp)
    response = accept(client, token, password="short")
    assert response.status_code == 422 and code_of(response) == "weak_password"
    assert "short" not in response.text.replace("shortly", "")
    assert invitations(session_factory)[0].accepted_at is None
    assert accept(client, token).status_code == 201  # the same link works with a good password


def test_invalid_request_shapes_are_rejected(client, smtp, fake_auth):
    _, token = invite(client, smtp)
    assert client.post("/internal/invitations/accept", headers=KEY, json={"token": token}).status_code == 422
    assert accept(client, token, password="p" * 300).status_code == 422
    assert fake_auth.calls == []


# --- service failures -------------------------------------------------------
@pytest.mark.parametrize("mode", ["down", "500"])
def test_auth_service_outage_changes_nothing_and_is_retryable(client, smtp, fake_auth, session_factory, mode):
    _, token = invite(client, smtp)
    fake_auth.mode = mode
    response = accept(client, token)
    assert response.status_code == 503 and code_of(response) == "temporarily_unavailable"
    assert fake_auth.users == {} and invitations(session_factory)[0].accepted_at is None

    fake_auth.mode = None  # the service recovers; the same link still works
    assert accept(client, token).status_code == 201
    assert len(fake_auth.users) == 1


def test_rejected_service_credentials_fail_safely_without_leaking_the_key(client, smtp, session_factory, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    _, token = invite(client, smtp)
    monkeypatch.setenv("AUTH_INTERNAL_API_KEY", "a-wrong-key")
    response = accept(client, token)
    assert response.status_code == 502 and code_of(response) == "service_error"
    assert "rejected the service credentials" in caplog.text
    assert "a-wrong-key" not in caplog.text + response.text and AUTH_KEY not in caplog.text + response.text
    assert invitations(session_factory)[0].accepted_at is None


def test_crash_after_account_creation_is_repaired_by_retrying(client, smtp, fake_auth, session_factory, monkeypatch):
    """The account is created, then the invitation update fails: a retry must finish the job."""
    _, token = invite(client, smtp)
    real_finalize = activation.finalize
    attempts = {"n": 0}

    def flaky_finalize(db, invitation):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise OperationalError("UPDATE organization_invitations", {}, Exception("connection lost"))
        return real_finalize(db, invitation)

    monkeypatch.setattr(activation, "finalize", flaky_finalize)

    first = accept(client, token)
    assert first.status_code == 503 and code_of(first) == "temporarily_unavailable"
    assert len(fake_auth.users) == 1  # the account exists...
    assert invitations(session_factory)[0].accepted_at is None  # ...but the invitation is still pending

    retry = accept(client, token)  # same link, same password
    assert retry.status_code == 201
    assert len(fake_auth.users) == 1 and len(fake_auth.calls) == 2  # idempotent: still one account
    assert invitations(session_factory)[0].accepted_at is not None
    assert accept(client, token).status_code == 410  # and now it is really used up


def test_retry_with_a_different_password_after_a_crash_does_not_overwrite_the_account(client, smtp, fake_auth, monkeypatch):
    _, token = invite(client, smtp)
    real_finalize = activation.finalize
    state = {"failed": False}

    def flaky_finalize(db, invitation):
        if not state["failed"]:
            state["failed"] = True
            raise OperationalError("UPDATE", {}, Exception("connection lost"))
        return real_finalize(db, invitation)

    monkeypatch.setattr(activation, "finalize", flaky_finalize)
    accept(client, token)
    retry = accept(client, token, password="Different!Passphrase9")
    assert retry.status_code == 409 and code_of(retry) == "account_exists"
    assert fake_auth.users[ADMIN_EMAIL]["password"] == GOOD_PASSWORD


# --- concurrency (real threads, real PostgreSQL row locks) --------------------
def run_in_threads(jobs):
    def run(job):
        with TestClient(app) as thread_client:  # each thread has its own client
            return job(thread_client)

    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        return list(pool.map(run, jobs))


def test_simultaneous_activation_with_the_same_password_succeeds_once(client, smtp, fake_auth, session_factory):
    _, token = invite(client, smtp)
    fake_auth.delay = 0.3  # widen the race window
    results = run_in_threads([lambda c: accept(c, token).status_code] * 5)
    assert sorted(results) == [201, 410, 410, 410, 410]
    assert len(fake_auth.calls) == 1 and len(fake_auth.users) == 1
    assert invitations(session_factory)[0].accepted_at is not None


def test_simultaneous_activation_with_different_passwords_has_exactly_one_winner(client, smtp, fake_auth):
    _, token = invite(client, smtp)
    fake_auth.delay = 0.3
    passwords = [f"Str0ng!Passphrase{n}" for n in range(5)]
    results = run_in_threads([(lambda c, p=p: accept(c, token, password=p).status_code) for p in passwords])
    assert results.count(201) == 1 and results.count(410) == 4
    assert fake_auth.users[ADMIN_EMAIL]["password"] == passwords[results.index(201)]
    assert len(fake_auth.calls) == 1


def test_a_resend_during_activation_waits_and_cannot_revoke_the_accepted_token(client, smtp, fake_auth, session_factory):
    org, token = invite(client, smtp)
    fake_auth.delay = 0.6

    def slow_accept(c):
        return accept(c, token).status_code

    def resend_soon(c):
        time.sleep(0.2)  # arrives while the activation is in progress
        return c.post(f"/api/v1/organizations/{org['id']}/invitations/resend", headers=ADMIN).status_code

    activation_status, resend_status = run_in_threads([slow_accept, resend_soon])
    assert activation_status == 201
    assert resend_status == 409  # the invitation was accepted first; the resend was refused
    assert len(smtp.messages) == 1  # no second email went out
    (invitation,) = invitations(session_factory)
    assert invitation.accepted_at is not None and invitation.revoked_at is None
