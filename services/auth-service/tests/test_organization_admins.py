"""Internal organization-admin provisioning: authentication, validation, idempotency, duplicates, races."""
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.main import app
from app.models import User
from app.security import hash_password, verify_password

from conftest import INTERNAL_KEY

URL = "/internal/organization-admins"
KEY = {"X-Internal-Key": INTERNAL_KEY}
ORG = str(uuid.uuid4())
GOOD_PASSWORD = "Str0ng!Passphrase"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def payload(**overrides):
    return {"organization_id": ORG, "full_name": "Olivia Owner", "email": "owner@acme.example",
            "password": GOOD_PASSWORD, **overrides}


def users(session_factory):
    with session_factory() as db:
        return db.scalars(select(User).order_by(User.created_at)).all()


# --- service authentication -------------------------------------------------
def test_requires_the_service_key(client, session_factory):
    assert client.post(URL, json=payload()).status_code == 401
    assert client.post(URL, json=payload(), headers={"X-Internal-Key": "wrong"}).status_code == 401
    assert client.post(URL, json=payload(), headers={"Authorization": "Bearer " + INTERNAL_KEY}).status_code == 401
    assert users(session_factory) == []


def test_fails_closed_when_no_key_is_configured(client, monkeypatch, session_factory):
    monkeypatch.delenv("INTERNAL_API_KEY")
    assert client.post(URL, json=payload(), headers=KEY).status_code == 503
    assert client.post(URL, json=payload(), headers={"X-Internal-Key": ""}).status_code == 503
    assert users(session_factory) == []


def test_internal_endpoint_is_not_in_the_public_api_docs(client):
    assert URL not in client.get("/openapi.json").json()["paths"]


# --- creating the account ---------------------------------------------------
def test_creates_an_active_organization_admin(client, session_factory):
    response = client.post(URL, json=payload(email="Owner@Acme.Example"), headers=KEY)
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"id", "email", "full_name", "role", "organization_id", "created"}
    assert (body["email"], body["role"], body["organization_id"], body["created"]) == (
        "owner@acme.example", "organization-admin", ORG, True,
    )
    (user,) = users(session_factory)
    assert user.is_active and user.role == "organization-admin" and str(user.organization_id) == ORG
    assert user.password_hash != GOOD_PASSWORD and GOOD_PASSWORD not in str(vars(user))
    assert verify_password(GOOD_PASSWORD, user.password_hash)  # the existing secure hashing is reused
    assert GOOD_PASSWORD not in response.text and "hash" not in response.text


def test_callers_cannot_choose_the_role(client, session_factory):
    response = client.post(URL, json=payload(role="super-admin", is_active=False), headers=KEY)
    assert response.status_code == 201
    (user,) = users(session_factory)
    assert user.role == "organization-admin" and user.is_active is True


def test_public_registration_cannot_create_privileged_or_organization_accounts(client, session_factory):
    response = client.post("/api/v1/auth/register", json={
        "email": "sneaky@example.org", "password": "password123", "full_name": "Sneaky",
        "role": "organization-admin", "organization_id": ORG,
    })
    assert response.status_code == 201
    (user,) = users(session_factory)
    assert user.role == "user" and user.organization_id is None


# --- validation -------------------------------------------------------------
@pytest.mark.parametrize("password,missing", [
    ("short1!A", "at least 12 characters"),
    ("alllowercase1!x", "an uppercase letter"),
    ("NoDigitsHere!!x", "a digit"),
    ("NoSymbolsHere12", "a symbol"),
    ("Owner-owner-1234!", "no part of your email address"),
])
def test_weak_passwords_are_rejected_and_not_echoed(client, session_factory, password, missing):
    response = client.post(URL, json=payload(password=password), headers=KEY)
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "weak_password" and any(missing in p for p in detail["problems"])
    assert password not in response.text
    assert users(session_factory) == []


def test_name_is_required_and_whitespace_is_normalised(client, session_factory):
    assert client.post(URL, json=payload(full_name="   "), headers=KEY).status_code == 422
    assert client.post(URL, json=payload(full_name="x" * 256), headers=KEY).status_code == 422
    assert client.post(URL, json=payload(full_name="  Olivia   Owner "), headers=KEY).status_code == 201
    assert users(session_factory)[0].full_name == "Olivia Owner"


def test_invalid_email_or_organization_id_is_rejected(client):
    assert client.post(URL, json=payload(email="nope"), headers=KEY).status_code == 422
    assert client.post(URL, json=payload(organization_id="not-a-uuid"), headers=KEY).status_code == 422


# --- idempotency and duplicates ---------------------------------------------
def test_retrying_the_same_request_is_idempotent(client, session_factory):
    assert client.post(URL, json=payload(), headers=KEY).json()["created"] is True
    again = client.post(URL, json=payload(), headers=KEY)
    assert again.status_code == 200 and again.json()["created"] is False
    assert len(users(session_factory)) == 1


def test_same_account_with_a_different_password_is_a_conflict(client, session_factory):
    client.post(URL, json=payload(), headers=KEY)
    conflict = client.post(URL, json=payload(password="Another!Passphrase9"), headers=KEY)
    assert conflict.status_code == 409 and conflict.json()["detail"]["code"] == "account_exists"
    (user,) = users(session_factory)
    assert verify_password(GOOD_PASSWORD, user.password_hash)  # the original password is untouched


def test_email_used_by_another_organization_or_account_type_is_a_conflict(client, session_factory):
    client.post(URL, json=payload(), headers=KEY)
    other_org = client.post(URL, json=payload(organization_id=str(uuid.uuid4())), headers=KEY)
    assert other_org.status_code == 409 and other_org.json()["detail"]["code"] == "email_taken"

    for role, email in (("user", "regular@example.org"), ("super-admin", "root@example.org")):
        with session_factory() as db:
            db.add(User(full_name="Existing", email=email, password_hash=hash_password(GOOD_PASSWORD), role=role))
            db.commit()
        taken = client.post(URL, json=payload(email=email), headers=KEY)
        assert taken.status_code == 409 and taken.json()["detail"]["code"] == "email_taken"
    assert len(users(session_factory)) == 3


def test_concurrent_requests_create_exactly_one_account(session_factory):
    def call(_):
        with TestClient(app) as c:
            return c.post(URL, json=payload(), headers=KEY).status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        statuses = sorted(pool.map(call, range(8)))
    assert statuses.count(201) == 1 and statuses.count(200) == 7  # one creator, the rest idempotent
    assert len(users(session_factory)) == 1


def test_concurrent_requests_with_different_passwords_have_one_winner(session_factory):
    passwords = [f"Str0ng!Passphrase{n}" for n in range(6)]

    def call(password):
        with TestClient(app) as c:
            return c.post(URL, json=payload(password=password), headers=KEY).status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        statuses = list(pool.map(call, passwords))
    assert statuses.count(201) == 1 and statuses.count(409) == 5
    (user,) = users(session_factory)
    winner = passwords[statuses.index(201)]
    assert verify_password(winner, user.password_hash)


# --- database guarantees ----------------------------------------------------
def test_database_rejects_an_organization_admin_without_an_organization(session_factory):
    with session_factory() as db:
        db.add(User(full_name="Bad", email="bad@example.org", password_hash="x", role="organization-admin"))
        with pytest.raises(IntegrityError):
            db.commit()


# --- precheck: can this email still become this organization's administrator? ---
PRECHECK = "/internal/organization-admins/precheck"


def precheck(client, **overrides):
    return client.post(PRECHECK, json={"organization_id": ORG, "email": "owner@acme.example", **overrides}, headers=KEY)


def test_precheck_requires_the_service_key_and_fails_closed(client, monkeypatch):
    body = {"organization_id": ORG, "email": "owner@acme.example"}
    assert client.post(PRECHECK, json=body).status_code == 401
    assert client.post(PRECHECK, json=body, headers={"X-Internal-Key": "wrong"}).status_code == 401
    monkeypatch.delenv("INTERNAL_API_KEY")
    assert client.post(PRECHECK, json=body, headers=KEY).status_code == 503


def test_precheck_reports_available_for_an_unused_email(client, session_factory):
    assert precheck(client).json() == {"state": "available"}
    assert users(session_factory) == []  # read-only: nothing was created


def test_precheck_reports_an_existing_administrator_of_the_same_organization(client):
    client.post(URL, json=payload(), headers=KEY)
    assert precheck(client).json() == {"state": "already_administrator"}
    assert precheck(client, email="OWNER@Acme.Example").json() == {"state": "already_administrator"}  # case-insensitive


def test_precheck_reports_emails_owned_by_other_accounts(client, session_factory):
    client.post(URL, json=payload(), headers=KEY)
    assert precheck(client, organization_id=str(uuid.uuid4())).json() == {"state": "email_taken"}  # other organization
    for role, email in (("user", "regular@example.org"), ("super-admin", "root@example.org")):
        with session_factory() as db:
            db.add(User(full_name="Existing", email=email, password_hash=hash_password(GOOD_PASSWORD), role=role))
            db.commit()
        assert precheck(client, email=email).json() == {"state": "email_taken"}


def test_precheck_is_not_in_the_public_api_docs_and_validates_input(client):
    assert PRECHECK not in client.get("/openapi.json").json()["paths"]
    assert precheck(client, email="nope").status_code == 422
    assert precheck(client, organization_id="not-a-uuid").status_code == 422


# --- demo passwords (DEMO_MODE only) -------------------------------------------
DEMO_PASSWORD = "12345678"


def test_demo_password_is_refused_unless_the_server_is_in_demo_mode(client, session_factory):
    response = client.post(URL, json=payload(password=DEMO_PASSWORD, allow_weak_password=True), headers=KEY)
    assert response.status_code == 403 and response.json()["detail"]["code"] == "demo_disabled"
    assert users(session_factory) == []


def test_demo_password_works_in_demo_mode_and_the_account_can_log_in(client, session_factory, monkeypatch):
    monkeypatch.setenv("DEMO_MODE", "true")
    response = client.post(URL, json=payload(password=DEMO_PASSWORD, allow_weak_password=True), headers=KEY)
    assert response.status_code == 201
    (user,) = users(session_factory)
    assert user.role == "organization-admin" and str(user.organization_id) == ORG
    assert verify_password(DEMO_PASSWORD, user.password_hash) and DEMO_PASSWORD not in user.password_hash
    login = client.post("/api/v1/auth/login", json={"email": "owner@acme.example", "password": DEMO_PASSWORD})
    assert login.status_code == 200
    assert client.post(URL, json=payload(password=DEMO_PASSWORD, allow_weak_password=True), headers=KEY).status_code == 200  # idempotent


def test_demo_mode_does_not_weaken_the_normal_policy(client, session_factory, monkeypatch):
    monkeypatch.setenv("DEMO_MODE", "true")
    assert client.post(URL, json=payload(password=DEMO_PASSWORD), headers=KEY).status_code == 422  # flag not set
    assert client.post(URL, json=payload(password="1234567", allow_weak_password=True), headers=KEY).status_code == 422  # still 8+
    assert users(session_factory) == []


# --- update ----------------------------------------------------------------------
UPDATE = "/internal/organization-admins/update"
DELETE = "/internal/organization-admins/delete"


def ref(**overrides):
    return {"organization_id": ORG, "email": "owner@acme.example", **overrides}


def create_admin(client, **overrides):
    assert client.post(URL, json=payload(**overrides), headers=KEY).status_code == 201


@pytest.mark.parametrize("path", [UPDATE, DELETE])
def test_update_and_delete_require_the_service_key_and_fail_closed(client, session_factory, monkeypatch, path):
    create_admin(client)
    assert client.post(path, json=ref()).status_code == 401
    assert client.post(path, json=ref(), headers={"X-Internal-Key": "wrong"}).status_code == 401
    monkeypatch.delenv("INTERNAL_API_KEY")
    assert client.post(path, json=ref(), headers=KEY).status_code == 503
    assert len(users(session_factory)) == 1 and path not in client.get("/openapi.json").json()["paths"]


def test_update_changes_name_and_email(client, session_factory):
    create_admin(client)
    response = client.post(UPDATE, json=ref(new_full_name="  Olivia   Q. Owner ", new_email="New.Owner@Acme.Example"), headers=KEY)
    assert response.status_code == 200 and response.json() == {"email": "new.owner@acme.example", "full_name": "Olivia Q. Owner"}
    (user,) = users(session_factory)
    assert (user.email, user.full_name, user.role) == ("new.owner@acme.example", "Olivia Q. Owner", "organization-admin")
    assert verify_password(GOOD_PASSWORD, user.password_hash)  # the password is untouched
    assert client.post("/api/v1/auth/login", json={"email": "new.owner@acme.example", "password": GOOD_PASSWORD}).status_code == 200


def test_update_is_idempotent_after_a_partial_failure(client, session_factory):
    create_admin(client)
    body = ref(new_email="moved@acme.example")
    assert client.post(UPDATE, json=body, headers=KEY).status_code == 200
    again = client.post(UPDATE, json=body, headers=KEY)  # the retry still names the old email
    assert again.status_code == 200 and again.json()["email"] == "moved@acme.example"
    assert len(users(session_factory)) == 1


def test_update_rejects_an_email_that_is_taken_and_invalid_names(client, session_factory):
    create_admin(client)
    create_admin(client, email="other@acme.example")
    taken = client.post(UPDATE, json=ref(new_email="other@acme.example"), headers=KEY)
    assert taken.status_code == 409 and taken.json()["detail"]["code"] == "email_taken"
    assert client.post(UPDATE, json=ref(new_full_name="   "), headers=KEY).status_code == 422
    assert sorted(u.email for u in users(session_factory)) == ["other@acme.example", "owner@acme.example"]


def test_update_and_delete_can_only_reach_administrators_of_the_named_organization(client, session_factory):
    create_admin(client)
    with session_factory() as db:
        for role, email in (("super-admin", "root@example.org"), ("user", "regular@example.org")):
            db.add(User(full_name="Other", email=email, password_hash=hash_password(GOOD_PASSWORD), role=role))
        db.commit()
    for email in ("root@example.org", "regular@example.org"):
        assert client.post(UPDATE, json=ref(email=email, new_full_name="Hijacked"), headers=KEY).status_code == 404
        assert client.post(DELETE, json=ref(email=email), headers=KEY).json() == {"deleted": False}
    wrong_org = ref(organization_id=str(uuid.uuid4()))
    assert client.post(UPDATE, json={**wrong_org, "new_full_name": "Hijacked"}, headers=KEY).status_code == 404
    assert client.post(DELETE, json=wrong_org, headers=KEY).json() == {"deleted": False}
    assert sorted(u.full_name for u in users(session_factory)) == ["Olivia Owner", "Other", "Other"]


# --- delete ----------------------------------------------------------------------
def test_delete_removes_the_administrator_and_is_repeatable(client, session_factory):
    create_admin(client)
    assert client.post(DELETE, json=ref(email="OWNER@acme.example"), headers=KEY).json() == {"deleted": True}
    assert users(session_factory) == []
    assert client.post("/api/v1/auth/login", json={"email": "owner@acme.example", "password": GOOD_PASSWORD}).status_code == 401
    assert client.post(DELETE, json=ref(), headers=KEY).json() == {"deleted": False}  # nothing left: not an error
    create_admin(client)  # and the address can be used again
