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
