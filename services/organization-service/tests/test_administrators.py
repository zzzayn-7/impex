"""Administrator management from the Super Admin portal: add, list, resend, duplicates, failures.

Built on the existing invitation workflow, so the token, expiry, hashing and activation rules are
covered by test_invitations.py / test_activation.py. These tests cover what is new.
"""
import hashlib
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.activation import get_internal_auth_client
from app.auth import get_auth_client
from app.main import app
from app.models import Organization, OrganizationInvitation

from conftest import fake_auth_client, token_from_message
from test_activation import ACTIVATION_KEY, AUTH_KEY, FakeAuthService, KEY, accept, lookup

SUPER_ADMIN = {"id": "1", "email": "root@example.org", "full_name": "Root", "role": "super-admin", "is_active": True}
TOKENS = {
    "admin-token": (200, SUPER_ADMIN),
    "user-token": (200, {**SUPER_ADMIN, "role": "user"}),
    "disabled-admin-token": (200, {**SUPER_ADMIN, "is_active": False}),
    "expired-token": (401, {"detail": "Invalid or expired token"}),
}
ADMIN = {"Authorization": "Bearer admin-token"}
ORGS = "/api/v1/organizations"
PASSWORD = "Str0ng!Passphrase"


@pytest.fixture
def fake_auth():
    return FakeAuthService()


@pytest.fixture
def client(smtp, fake_auth, monkeypatch):
    monkeypatch.setenv("ACTIVATION_API_KEY", ACTIVATION_KEY)
    monkeypatch.setenv("AUTH_INTERNAL_API_KEY", AUTH_KEY)
    monkeypatch.setenv("TENANT_PORTAL_URL", "http://portal.test/")
    super_admin_check = fake_auth_client(TOKENS)
    internal = httpx.Client(transport=httpx.MockTransport(fake_auth.handler), base_url="http://auth-service:8000")
    app.dependency_overrides[get_auth_client] = lambda: super_admin_check
    app.dependency_overrides[get_internal_auth_client] = lambda: internal
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_auth_client, None)
    app.dependency_overrides.pop(get_internal_auth_client, None)


def make_org(client, slug="acme", name="Acme Imports"):
    response = client.post(ORGS, headers=ADMIN, json={
        "name": name, "slug": slug, "country_code": "DE", "contact_email": "ops@acme.example"})
    assert response.status_code == 201
    return response.json()


def add(client, org_id, email="ada@example.org", full_name="Ada Lovelace", headers=ADMIN, **extra):
    body = {"email": email, **extra}
    if full_name is not None:
        body["full_name"] = full_name
    return client.post(f"{ORGS}/{org_id}/administrators", json=body, headers=headers)


def resend(client, org_id, admin_id, headers=ADMIN):
    return client.post(f"{ORGS}/{org_id}/administrators/{admin_id}/resend", headers=headers)


def listing(client, headers=ADMIN):
    return client.get(f"{ORGS}/administrators", headers=headers)


def rows(session_factory):
    with session_factory() as db:
        return db.scalars(select(OrganizationInvitation).order_by(OrganizationInvitation.created_at)).all()


def expire(session_factory, admin_id):
    with session_factory() as db:
        db.get(OrganizationInvitation, admin_id).expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.commit()


# --- only Super Admins ------------------------------------------------------
@pytest.mark.parametrize("call", ["list", "add", "resend"])
@pytest.mark.parametrize("headers,expected", [
    ({}, 401),
    ({"Authorization": "Bearer expired-token"}, 401),
    ({"Authorization": "Bearer user-token"}, 403),
    ({"Authorization": "Bearer disabled-admin-token"}, 403),
    ({"Authorization": "Bearer user-token", "X-User-Role": "super-admin"}, 403),
])
def test_only_active_super_admins_may_manage_administrators(client, smtp, fake_auth, session_factory, call, headers, expected):
    org = make_org(client)
    if call == "list":
        response = listing(client, headers)
    elif call == "add":
        response = add(client, org["id"], headers=headers)
    else:
        response = resend(client, org["id"], "00000000-0000-4000-8000-000000000000", headers)
    assert response.status_code == expected
    assert smtp.messages == [] and rows(session_factory) == [] and fake_auth.prechecks == []


# --- adding an administrator ------------------------------------------------
def test_adding_an_administrator_creates_a_pending_invitation_and_emails_everything_needed(client, smtp, session_factory):
    org = make_org(client)
    response = add(client, org["id"], email="Ada@Example.org", full_name="  Ada   Lovelace ")
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"id", "organization_id", "organization_name", "organization_slug", "full_name", "email",
                         "role", "status", "invited_at", "expires_at", "activated_at"}
    assert (body["organization_id"], body["organization_name"], body["full_name"], body["email"], body["role"],
            body["status"], body["activated_at"]) == (org["id"], "Acme Imports", "Ada Lovelace", "ada@example.org",
                                                     "organization-admin", "pending", None)

    (message,) = smtp.messages
    assert message["To"] == "ada@example.org"
    token = token_from_message(message)
    text = message.get_body(("plain",)).get_content()
    html_part = message.get_body(("html",)).get_content()
    for part in (text, html_part):
        assert "Acme Imports" in part  # organization name
        assert "ada@example.org" in part  # administrator email
        assert f"http://app.test/activate#token={token}" in part  # activation link
        assert "http://portal.test/login" in part  # organization login URL
    assert "Ada Lovelace" in text
    assert "never send passwords" in text and "password:" not in text.lower()

    (row,) = rows(session_factory)
    assert row.token_hash == hashlib.sha256(token.encode()).hexdigest() != token
    assert row.full_name == "Ada Lovelace" and row.email == "ada@example.org"
    assert row.accepted_at is None and row.revoked_at is None
    assert (row.expires_at - row.created_at).total_seconds() == 24 * 3600
    assert token not in response.text and row.token_hash not in response.text


def test_the_organization_and_role_cannot_be_chosen_by_the_request_body(client, smtp, session_factory):
    org = make_org(client, "acme")
    other = make_org(client, "other", "Other Org")
    response = add(client, org["id"], role="super-admin", organization_id=other["id"], is_active=False,
                   organization_name="Other Org")
    assert response.status_code == 201
    assert response.json()["organization_id"] == org["id"] and response.json()["role"] == "organization-admin"
    assert str(rows(session_factory)[0].organization_id) == org["id"]


def test_organization_can_be_addressed_by_slug_and_name_is_optional(client, smtp):
    make_org(client, "acme")
    response = add(client, "acme", full_name=None)
    assert response.status_code == 201 and response.json()["full_name"] is None
    assert "Hello," in smtp.messages[0].get_body(("plain",)).get_content()


@pytest.mark.parametrize("payload", [{}, {"email": "not-an-email"}, {"email": "a@b.org", "full_name": "x" * 256}])
def test_invalid_input_is_rejected(client, smtp, session_factory, payload):
    org = make_org(client)
    assert client.post(f"{ORGS}/{org['id']}/administrators", json=payload, headers=ADMIN).status_code == 422
    assert smtp.messages == [] and rows(session_factory) == []


def test_unknown_organization_returns_404(client, smtp):
    assert add(client, "00000000-0000-4000-8000-000000000000").status_code == 404
    assert add(client, "no-such-slug").status_code == 404
    assert smtp.messages == []


def test_an_organization_can_have_several_administrators(client, smtp, session_factory):
    org = make_org(client)
    assert add(client, org["id"], email="ada@example.org").status_code == 201
    assert add(client, org["id"], email="grace@example.org", full_name="Grace Hopper").status_code == 201
    assert len(smtp.messages) == 2 and len(rows(session_factory)) == 2
    assert {a["email"] for a in listing(client).json()} == {"ada@example.org", "grace@example.org"}


# --- duplicates -------------------------------------------------------------
def test_a_second_invitation_for_the_same_person_is_rejected(client, smtp, session_factory):
    org = make_org(client)
    add(client, org["id"])
    for email in ("ada@example.org", "ADA@example.org"):
        duplicate = add(client, org["id"], email=email)
        assert duplicate.status_code == 409 and "resend" in duplicate.json()["detail"].lower()
    assert len(smtp.messages) == 1 and len(rows(session_factory)) == 1


def test_someone_who_is_already_an_administrator_is_rejected(client, smtp, fake_auth, session_factory):
    org = make_org(client)
    fake_auth.users["ada@example.org"] = {"org": org["id"], "password": PASSWORD, "name": "Ada"}
    response = add(client, org["id"])
    assert response.status_code == 409 and "already has an active administrator account" in response.json()["detail"]
    assert smtp.messages == [] and rows(session_factory) == []


def test_an_email_that_belongs_to_another_account_is_rejected(client, smtp, fake_auth, session_factory):
    org = make_org(client)
    fake_auth.users["ada@example.org"] = {"org": "some-other-organization", "password": PASSWORD, "name": "Ada"}
    response = add(client, org["id"])
    assert response.status_code == 409 and "belongs to another account" in response.json()["detail"]
    assert smtp.messages == [] and rows(session_factory) == []


@pytest.mark.parametrize("mode", ["down", "500"])
def test_auth_service_outage_blocks_the_invitation_without_leaving_a_trace(client, smtp, fake_auth, session_factory, mode):
    org = make_org(client)
    fake_auth.mode = mode
    assert add(client, org["id"]).status_code == 503
    assert smtp.messages == [] and rows(session_factory) == []
    fake_auth.mode = None
    assert add(client, org["id"]).status_code == 201  # and it works once the service is back


def test_simultaneous_requests_create_exactly_one_invitation(client, smtp, session_factory):
    org = make_org(client)

    def call(_):
        with TestClient(app) as c:
            return add(c, org["id"]).status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        statuses = sorted(pool.map(call, range(6)))
    assert statuses == [201, 409, 409, 409, 409, 409]
    assert len(smtp.messages) == 1 and len(rows(session_factory)) == 1


# --- listing ----------------------------------------------------------------
def test_listing_shows_name_email_organization_role_and_status(client, smtp, session_factory):
    acme = make_org(client, "acme", "Acme Imports")
    globex = make_org(client, "globex", "Globex Trading")
    add(client, acme["id"], email="ada@example.org", full_name="Ada Lovelace")
    expired_row = add(client, acme["id"], email="old@example.org", full_name="Old Invite").json()
    add(client, globex["id"], email="hank@example.org", full_name="Hank Scorpio")
    expire(session_factory, expired_row["id"])

    admins = listing(client).json()
    assert [a["email"] for a in admins] == ["hank@example.org", "old@example.org", "ada@example.org"]  # newest first
    by_email = {a["email"]: a for a in admins}
    assert by_email["ada@example.org"]["status"] == "pending"
    assert by_email["old@example.org"]["status"] == "expired"
    assert {(a["organization_name"], a["role"]) for a in admins} == {("Acme Imports", "organization-admin"), ("Globex Trading", "organization-admin")}
    assert by_email["hank@example.org"]["organization_slug"] == "globex"
    serialized = listing(client).text
    assert "token" not in serialized and "hash" not in serialized


def test_listing_is_empty_without_administrators(client):
    assert listing(client).json() == []


# --- resend -----------------------------------------------------------------
def test_resending_an_expired_invitation_issues_a_fresh_one_and_kills_the_old_link(client, smtp, session_factory):
    org = make_org(client)
    first = add(client, org["id"]).json()
    old_token = token_from_message(smtp.messages[0])
    expire(session_factory, first["id"])
    assert listing(client).json()[0]["status"] == "expired"

    response = resend(client, org["id"], first["id"])
    assert response.status_code == 201
    renewed = response.json()
    assert renewed["id"] != first["id"] and renewed["status"] == "pending" and renewed["full_name"] == "Ada Lovelace"
    new_token = token_from_message(smtp.messages[1])
    assert new_token != old_token

    assert [(a["id"], a["status"]) for a in listing(client).json()] == [(renewed["id"], "pending")]  # no duplicate row
    old = lookup(client, old_token)
    assert old.status_code == 410 and old.json()["detail"]["code"] == "revoked"
    assert lookup(client, new_token).status_code == 200


def test_a_pending_invitation_can_be_resent_too(client, smtp):
    org = make_org(client)
    first = add(client, org["id"]).json()
    assert resend(client, org["id"], first["id"]).status_code == 201
    assert len(smtp.messages) == 2


def test_resend_validates_that_the_administrator_belongs_to_the_organization(client, smtp):
    acme, globex = make_org(client, "acme"), make_org(client, "globex", "Globex")
    admin = add(client, acme["id"]).json()
    assert resend(client, globex["id"], admin["id"]).status_code == 404  # right id, wrong organization
    assert resend(client, acme["id"], "00000000-0000-4000-8000-000000000000").status_code == 404
    assert resend(client, acme["id"], "not-a-uuid").status_code == 404
    assert len(smtp.messages) == 1


def test_resend_is_refused_once_the_account_exists(client, smtp, fake_auth):
    org = make_org(client)
    admin = add(client, org["id"]).json()
    token = token_from_message(smtp.messages[0])
    assert accept(client, token).status_code == 201
    response = resend(client, org["id"], admin["id"])
    assert response.status_code == 409 and "already activated" in response.json()["detail"]
    assert len(smtp.messages) == 1


def test_resend_is_refused_if_the_email_now_belongs_to_another_account(client, smtp, fake_auth):
    org = make_org(client)
    admin = add(client, org["id"]).json()
    fake_auth.users["ada@example.org"] = {"org": "somebody-elses", "password": PASSWORD, "name": "Squatter"}
    assert resend(client, org["id"], admin["id"]).status_code == 409
    assert len(smtp.messages) == 1


# --- partial failures -------------------------------------------------------
def test_email_failure_on_add_stores_nothing_and_a_retry_creates_a_single_invitation(client, smtp, session_factory):
    org = make_org(client)
    smtp.fail_on_connect = ConnectionRefusedError("mail server down")
    failed = add(client, org["id"])
    assert failed.status_code == 502 and "could not be sent" in failed.json()["detail"]
    assert rows(session_factory) == [] and listing(client).json() == []

    smtp.fail_on_connect = None
    assert add(client, org["id"]).status_code == 201
    assert len(rows(session_factory)) == 1 and len(listing(client).json()) == 1  # no duplicates


def test_email_failure_on_resend_keeps_the_previous_invitation(client, smtp, session_factory):
    org = make_org(client)
    first = add(client, org["id"]).json()
    before = rows(session_factory)[0].token_hash
    smtp.fail_on_send = OSError("connection reset")
    assert resend(client, org["id"], first["id"]).status_code == 502
    (after,) = rows(session_factory)
    assert (after.id, after.token_hash, after.revoked_at) == (rows(session_factory)[0].id, before, None)
    assert str(after.id) == first["id"]


# --- the whole journey, through the existing activation flow ----------------
def test_invited_administrator_activates_and_shows_as_active(client, smtp, fake_auth, session_factory):
    org = make_org(client)
    add(client, org["id"], email="ada@example.org", full_name="Ada L.")
    other = add(client, org["id"], email="grace@example.org", full_name="Grace Hopper").json()
    token = token_from_message(smtp.messages[0])

    prefill = lookup(client, token).json()
    assert prefill["full_name"] == "Ada L." and prefill["email"] == "ada@example.org"

    response = accept(client, token, name="Ada Lovelace")
    assert response.status_code == 201

    (body, _), = fake_auth.calls
    assert body["organization_id"] == org["id"] and body["email"] == "ada@example.org"  # from our records
    assert "role" not in body

    by_email = {a["email"]: a for a in listing(client).json()}
    assert by_email["ada@example.org"]["status"] == "active"
    assert by_email["ada@example.org"]["full_name"] == "Ada Lovelace"  # the name they confirmed
    assert by_email["ada@example.org"]["activated_at"] is not None
    assert by_email["grace@example.org"]["status"] == "pending"  # the other administrator is unaffected
    assert lookup(client, token_from_message(smtp.messages[1])).status_code == 200

    # an active administrator cannot be invited again
    assert add(client, org["id"], email="ada@example.org").status_code == 409
    assert resend(client, org["id"], by_email["ada@example.org"]["id"]).status_code == 409
    assert resend(client, org["id"], other["id"]).status_code == 201  # while the other can still be resent
