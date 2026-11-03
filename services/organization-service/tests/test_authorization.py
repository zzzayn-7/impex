"""Authorization tests for the Organization Service.

The Auth Service is replaced by an in-process fake (httpx.MockTransport), so these
tests need no running containers or network.
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import get_auth_client
from app.main import app

SUPER_ADMIN = {"id": "1", "email": "root@example.org", "full_name": "Root", "role": "super-admin", "is_active": True}
REGULAR_USER = {**SUPER_ADMIN, "email": "user@example.org", "role": "user"}
DISABLED_ADMIN = {**SUPER_ADMIN, "is_active": False}

# token -> (status code, JSON body) the fake Auth Service answers with
TOKENS = {
    "admin-token": (200, SUPER_ADMIN),
    "user-token": (200, REGULAR_USER),
    "disabled-admin-token": (200, DISABLED_ADMIN),
    "expired-token": (401, {"detail": "Invalid or expired token"}),
    "broken-token": (500, {"detail": "boom"}),
}

NEW_ORG = {"name": "Acme Imports", "slug": "acme-imports", "country_code": "DE", "contact_email": "ops@acme.example"}

PROTECTED = [
    ("GET", "/api/v1/organizations"),
    ("POST", "/api/v1/organizations"),
    ("GET", "/api/v1/organizations/org_default_01"),
]


@pytest.fixture
def auth_calls():
    return []


@pytest.fixture
def client(auth_calls):
    def handler(request: httpx.Request) -> httpx.Response:
        auth_calls.append(request)
        assert request.url.path == "/api/v1/auth/me"
        header = request.headers.get("authorization", "")
        status, body = TOKENS.get(header.removeprefix("Bearer "), (401, {"detail": "Invalid or expired token"}))
        return httpx.Response(status, json=body)

    fake_auth = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://auth-service:8000")
    app.dependency_overrides[get_auth_client] = lambda: fake_auth
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def call(client, method, path, headers=None):
    return client.request(method, path, headers=headers, json=NEW_ORG if method == "POST" else None)


# --- 401: missing / invalid / expired ---------------------------------------
@pytest.mark.parametrize("method,path", PROTECTED)
def test_missing_token_returns_401(client, method, path, auth_calls):
    response = call(client, method, path)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert auth_calls == []  # nothing to verify, so the Auth Service is not called


@pytest.mark.parametrize("method,path", PROTECTED)
def test_invalid_or_expired_token_returns_401(client, method, path):
    assert call(client, method, path, bearer("expired-token")).status_code == 401
    assert call(client, method, path, bearer("totally-made-up")).status_code == 401


def test_non_bearer_scheme_returns_401(client):
    response = client.get("/api/v1/organizations", headers={"Authorization": "Basic YWRtaW46YWRtaW4="})
    assert response.status_code == 401


# --- 403: authenticated but not allowed -------------------------------------
@pytest.mark.parametrize("method,path", PROTECTED)
def test_regular_user_returns_403(client, method, path):
    assert call(client, method, path, bearer("user-token")).status_code == 403


def test_inactive_super_admin_returns_403(client):
    assert client.get("/api/v1/organizations", headers=bearer("disabled-admin-token")).status_code == 403


# --- 200/201: Super Admin ----------------------------------------------------
def test_super_admin_can_list_get_and_create(client):
    headers = bearer("admin-token")

    listing = client.get("/api/v1/organizations", headers=headers)
    assert listing.status_code == 200
    assert any(org["id"] == "org_default_01" for org in listing.json())  # existing records are kept

    assert client.get("/api/v1/organizations/org_default_01", headers=headers).status_code == 200
    assert client.get("/api/v1/organizations/does-not-exist", headers=headers).status_code == 404

    created = client.post("/api/v1/organizations", json=NEW_ORG, headers=headers)
    assert created.status_code == 201
    assert created.json()["slug"] == "acme-imports"


def test_token_is_forwarded_to_auth_service(client, auth_calls):
    client.get("/api/v1/organizations", headers=bearer("admin-token"))
    assert len(auth_calls) == 1
    assert auth_calls[0].headers["authorization"] == "Bearer admin-token"


# --- client-supplied role headers must never be trusted ---------------------
SPOOFED = {"X-User-Role": "super-admin", "X-Role": "super-admin", "X-User-Id": "1", "X-Forwarded-User": "root"}


def test_spoofed_role_headers_without_token_return_401(client):
    assert client.get("/api/v1/organizations", headers=SPOOFED).status_code == 401


def test_spoofed_role_headers_cannot_elevate_a_regular_user(client):
    headers = {**SPOOFED, **bearer("user-token")}
    assert client.get("/api/v1/organizations", headers=headers).status_code == 403


# --- Auth Service failures are not the caller's fault -----------------------
def test_auth_service_error_returns_503(client):
    assert client.get("/api/v1/organizations", headers=bearer("broken-token")).status_code == 503


def test_auth_service_unreachable_returns_503(auth_calls):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    down = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://auth-service:8000")
    app.dependency_overrides[get_auth_client] = lambda: down
    try:
        with TestClient(app) as test_client:
            assert test_client.get("/api/v1/organizations", headers=bearer("admin-token")).status_code == 503
            assert test_client.get("/health").status_code == 200  # health stays up even if auth is down
    finally:
        app.dependency_overrides.clear()


# --- health stays public ----------------------------------------------------
@pytest.mark.parametrize("path", ["/health", "/api/v1/organizations/health"])
def test_health_is_public(client, path, auth_calls):
    response = client.get(path)
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
    assert auth_calls == []
