"""Deleting an organization from the CRM: the Auth Service's part (POST /internal/organizations/{id}/purge).

Covers: the shared secret is required (401 without it, 503 when none is configured) and the route is not in the public API document; only the accounts of THAT organization
are deleted (its administrators), never another organization's and never a Super Admin; deleted people can no longer sign in or use a token they already held;
repeating it is harmless.
"""
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.main import app
from app.models import User
from app.security import hash_password

PASSWORD = "Str0ng!Passphrase"
ALPHA, BETA = str(uuid.uuid4()), str(uuid.uuid4())
KEY = {"X-Internal-Key": "test-internal-key"}


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def add_user(session_factory, email, role="organization-admin", organization_id=ALPHA):
    with session_factory() as db:
        user = User(full_name="Some Admin", email=email, password_hash=hash_password(PASSWORD), role=role, organization_id=uuid.UUID(organization_id) if organization_id else None)
        db.add(user)
        db.commit()


def login(client, email):
    return client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD})


def emails(session_factory):
    with session_factory() as db:
        return sorted(row[0] for row in db.execute(text("SELECT email FROM users")))


def purge(client, organization_id, headers=KEY):
    return client.post(f"/internal/organizations/{organization_id}/purge", headers=headers)


def test_the_route_needs_the_internal_key_and_is_not_public(client, monkeypatch):
    assert purge(client, ALPHA, {}).status_code == 401
    assert purge(client, ALPHA, {"X-Internal-Key": "wrong"}).status_code == 401
    monkeypatch.delenv("INTERNAL_API_KEY")
    assert purge(client, ALPHA).status_code == 503
    assert not any("purge" in path for path in client.get("/openapi.json").json()["paths"])


def test_only_that_organizations_accounts_are_deleted_never_another_organization_or_a_super_admin(client, session_factory):
    for email in ("a1@example.org", "a2@example.org"):
        add_user(session_factory, email, organization_id=ALPHA)
    add_user(session_factory, "b1@example.org", organization_id=BETA)
    add_user(session_factory, "root@example.org", role="super-admin", organization_id=None)
    token = login(client, "a1@example.org").json()["access_token"]
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 200

    response = purge(client, ALPHA)
    assert response.status_code == 200 and response.json() == {"service": "auth", "organization_id": ALPHA, "deleted": {"users": 2}, "total": 2}
    assert emails(session_factory) == ["b1@example.org", "root@example.org"]
    assert login(client, "a1@example.org").status_code == 401  # they can no longer sign in ...
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401  # ... and the token they held stops working
    assert login(client, "b1@example.org").status_code == 200 and login(client, "root@example.org").status_code == 200


def test_repeating_it_deletes_nothing_more(client, session_factory):
    add_user(session_factory, "a1@example.org")
    assert purge(client, ALPHA).json()["total"] == 1
    again = purge(client, ALPHA)
    assert again.status_code == 200 and again.json()["total"] == 0 and again.json()["deleted"] == {}


def test_an_unknown_organization_is_a_no_op_and_a_bad_id_is_refused(client):
    assert purge(client, uuid.uuid4()).json()["total"] == 0
    assert client.post("/internal/organizations/not-a-uuid/purge", headers=KEY).status_code == 422
