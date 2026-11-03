"""End-to-end email delivery through the real Mailpit container.

Skipped automatically when Mailpit is not running. Start it with:
    docker compose up -d mailpit
Mailpit's API is used to read the delivered messages; only the messages created by these tests
(unique recipient addresses) are looked up and removed.
"""
import os
import re
import time
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth import get_auth_client
from app.invitations import hash_token
from app.main import app
from app.models import OrganizationInvitation

from conftest import fake_auth_client

MAILPIT_API = os.getenv("MAILPIT_API_URL", "http://mailpit:8025").rstrip("/")
ADMIN = {"Authorization": "Bearer admin-token"}
SUPER_ADMIN = {"id": "1", "email": "root@example.org", "full_name": "Root", "role": "super-admin", "is_active": True}


def mailpit_available() -> bool:
    try:
        return httpx.get(f"{MAILPIT_API}/api/v1/info", timeout=2).status_code == 200
    except httpx.HTTPError:
        return False


pytestmark = pytest.mark.skipif(not mailpit_available(), reason="Mailpit is not running (docker compose up -d mailpit)")


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("SMTP_HOST", os.getenv("MAILPIT_SMTP_HOST", "mailpit"))
    monkeypatch.setenv("SMTP_PORT", "1025")
    monkeypatch.setenv("APP_BASE_URL", "http://localhost")
    auth = fake_auth_client({"admin-token": (200, SUPER_ADMIN)})
    app.dependency_overrides[get_auth_client] = lambda: auth
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_auth_client, None)


def wait_for_messages(address: str, count: int, timeout: float = 10.0) -> list:
    deadline = time.time() + timeout
    while time.time() < deadline:
        found = httpx.get(f"{MAILPIT_API}/api/v1/search", params={"query": f'to:"{address}"'}, timeout=5).json()
        if found["messages_count"] >= count:
            return sorted(found["messages"], key=lambda m: m["Created"])
        time.sleep(0.3)
    pytest.fail(f"expected {count} message(s) for {address} in Mailpit")


def read(message_id: str) -> dict:
    return httpx.get(f"{MAILPIT_API}/api/v1/message/{message_id}", timeout=5).json()


def test_invitation_and_resend_are_delivered_to_mailpit(client, session_factory):
    address = f"owner-{uuid.uuid4().hex[:10]}@mailpit-test.example"
    org = client.post("/api/v1/organizations", headers=ADMIN, json={
        "name": "Mailpit Test Org", "slug": f"mailpit-{uuid.uuid4().hex[:8]}", "country_code": "DE",
        "contact_email": "ops@mailpit-test.example", "primary_admin_email": address,
    }).json()
    delivered_ids = []
    try:
        assert client.post(f"/api/v1/organizations/{org['id']}/invitations", headers=ADMIN).status_code == 201
        (first,) = wait_for_messages(address, 1)
        delivered_ids.append(first["ID"])
        detail = read(first["ID"])
        assert detail["To"][0]["Address"] == address
        assert detail["From"]["Address"] == "no-reply@impex.local"
        assert "Mailpit Test Org" in detail["Subject"]
        first_token = re.search(r"/activate#token=([A-Za-z0-9_-]+)", detail["Text"]).group(1)
        assert "/activate#token=" in detail["HTML"]

        # resend: a second email with a different token; the first token is dead
        assert client.post(f"/api/v1/organizations/{org['id']}/invitations/resend", headers=ADMIN).status_code == 201
        _, second = wait_for_messages(address, 2)
        delivered_ids.append(second["ID"])
        second_token = re.search(r"/activate#token=([A-Za-z0-9_-]+)", read(second["ID"])["Text"]).group(1)
        assert second_token != first_token

        with session_factory() as db:
            rows = {r.token_hash: r for r in db.scalars(select(OrganizationInvitation))}
        assert rows[hash_token(first_token)].revoked_at is not None
        assert rows[hash_token(second_token)].revoked_at is None
        assert first_token not in str(rows) and second_token not in str(rows)
    finally:
        if delivered_ids:
            httpx.request("DELETE", f"{MAILPIT_API}/api/v1/messages", json={"IDs": delivered_ids}, timeout=5)
