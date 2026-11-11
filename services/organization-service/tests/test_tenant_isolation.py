"""Multi-tenant isolation: an organization administrator sees their own organization and nothing else.

Two organizations (Alpha, Beta) with one administrator each. Every test that tries to reach "the other"
organization expects it to be impossible, however the request is manipulated.
"""
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.auth import get_auth_client
from app.main import app
from app.models import Organization, OrganizationInvitation

from conftest import fake_auth_client

TENANT_URL = "/api/v1/tenant/organization"
ORGS = "/api/v1/organizations"

EXPECTED_FIELDS = {"id", "name", "slug", "country_code", "tax_identifier", "contact_email", "is_active", "created_at", "setup_status", "has_logo", "logo_version", "modules", "description", "default_currency", "timezone", "date_format", "number_format", "settings_version"}


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def account(role, organization_id, **overrides):
    return {
        "id": str(uuid.uuid4()), "email": f"{role}@example.org", "full_name": f"Test {role}", "role": role,
        "organization_id": organization_id, "is_active": True, "created_at": "2026-11-04T00:00:00+00:00", **overrides,
    }


@pytest.fixture
def tenants(session_factory):
    with session_factory() as db:
        alpha = Organization(name="Alpha Trading", slug="alpha-trading", country_code="DE", tax_identifier="DE111111111",
                             contact_email="ops@alpha.example", primary_admin_email="admin@alpha.example")
        beta = Organization(name="Beta Logistics", slug="beta-logistics", country_code="FR", tax_identifier="FR222222222",
                            contact_email="ops@beta.example", primary_admin_email="admin@beta.example")
        db.add_all([alpha, beta])
        db.commit()
        return {"alpha": alpha, "beta": beta}


@pytest.fixture
def tokens(tenants):
    alpha, beta = str(tenants["alpha"].id), str(tenants["beta"].id)
    return {
        "admin-alpha": (200, account("organization-admin", alpha, email="admin@alpha.example")),
        "admin-beta": (200, account("organization-admin", beta, email="admin@beta.example")),
        "super": (200, account("super-admin", None)),
        "super-with-org": (200, account("super-admin", alpha)),  # a Super Admin never gets tenant access
        "regular": (200, account("user", None)),
        "regular-with-org": (200, account("user", alpha)),
        "admin-no-org": (200, account("organization-admin", None)),
        "admin-bad-org": (200, account("organization-admin", "not-a-uuid")),
        "admin-inactive": (200, account("organization-admin", alpha, is_active=False)),
        "admin-orphan": (200, account("organization-admin", str(uuid.uuid4()))),  # organization does not exist
        "expired": (401, {"detail": "Invalid or expired token"}),
        "auth-broken": (500, {"detail": "boom"}),
    }


@pytest.fixture
def client(tokens):
    auth = fake_auth_client(tokens)
    app.dependency_overrides[get_auth_client] = lambda: auth
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_auth_client, None)


# --- each administrator sees exactly their own organization ----------------------
def test_each_administrator_gets_only_their_own_organization(client, tenants):
    alpha = client.get(TENANT_URL, headers=bearer("admin-alpha"))
    beta = client.get(TENANT_URL, headers=bearer("admin-beta"))
    assert alpha.status_code == beta.status_code == 200
    assert alpha.json()["id"] == str(tenants["alpha"].id) and alpha.json()["name"] == "Alpha Trading"
    assert beta.json()["id"] == str(tenants["beta"].id) and beta.json()["name"] == "Beta Logistics"
    assert "Beta" not in alpha.text and "beta" not in alpha.text.lower()
    assert "Alpha" not in beta.text and "alpha" not in beta.text.lower()


def test_response_has_only_the_agreed_fields(client):
    body = client.get(TENANT_URL, headers=bearer("admin-alpha")).json()
    assert set(body) == EXPECTED_FIELDS
    assert body["tax_identifier"] == "DE111111111" and body["contact_email"] == "ops@alpha.example"
    assert body["is_active"] is True and body["country_code"] == "DE"
    assert "admin@alpha.example" not in str(body)  # no administrator details


def test_the_endpoint_declares_no_inputs_at_all(client):
    """Structural guarantee: nothing in the URL, query or body can influence which organization is returned."""
    operation = client.get("/openapi.json").json()["paths"][TENANT_URL]
    assert list(operation) == ["get"]
    assert not operation["get"].get("parameters") and "requestBody" not in operation["get"]


# --- manipulation attempts: the other organization is unreachable ------------
def manipulations(other):
    oid, slug = str(other.id), other.slug
    return {
        "query organization_id": dict(params={"organization_id": oid}),
        "query org_id": dict(params={"org_id": oid}),
        "query tenant_id": dict(params={"tenant_id": oid}),
        "query id": dict(params={"id": oid}),
        "query slug": dict(params={"slug": slug, "organization": slug}),
        "header X-Organization-Id": dict(headers={"X-Organization-Id": oid}),
        "header X-Tenant-Id": dict(headers={"X-Tenant-Id": oid, "X-Org-Id": oid, "X-Organization-Slug": slug}),
        "role/identity headers": dict(headers={"X-User-Role": "super-admin", "X-User-Id": "1", "X-Forwarded-User": "root"}),
        "cookie": dict(headers={"Cookie": f"organization_id={oid}; tenant={oid}"}),
        "JSON body on GET": dict(json={"organization_id": oid, "slug": slug}),
        "everything at once": dict(
            params={"organization_id": oid}, headers={"X-Organization-Id": oid, "X-Tenant-Id": oid}, json={"organization_id": oid}
        ),
    }


@pytest.mark.parametrize("attacker,victim", [("admin-alpha", "beta"), ("admin-beta", "alpha")])
def test_no_request_manipulation_reaches_another_organization(client, tenants, attacker, victim):
    own = "alpha" if victim == "beta" else "beta"
    for label, extras in manipulations(tenants[victim]).items():
        headers = {**bearer(attacker), **extras.pop("headers", {})}
        response = client.request("GET", TENANT_URL, headers=headers, **extras)
        assert response.status_code == 200, label
        assert response.json()["id"] == str(tenants[own].id), label  # still their own organization
        assert tenants[victim].name not in response.text and tenants[victim].contact_email not in response.text, label


@pytest.mark.parametrize("path", [
    "/api/v1/tenant/organization/{other}", "/api/v1/tenant/organization/{slug}", "/api/v1/tenant/organizations/{other}",
    "/api/v1/tenant/{other}/organization", "/api/v1/tenant/{other}", "/api/v1/tenant/organization/../{other}",
])
def test_url_variations_naming_another_organization_do_not_exist(client, tenants, path):
    other = tenants["beta"]
    response = client.get(path.format(other=other.id, slug=other.slug), headers=bearer("admin-alpha"))
    assert response.status_code in (404, 405)
    assert "Beta" not in response.text


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_the_tenant_endpoint_is_read_only(client, tenants, method):
    response = client.request(method, TENANT_URL, headers=bearer("admin-alpha"), json={"name": "Hacked"})
    assert response.status_code == 405
    assert client.get(TENANT_URL, headers=bearer("admin-alpha")).json()["name"] == "Alpha Trading"


# --- 401: invalid authentication ---------------------------------------------
def test_missing_or_invalid_credentials_return_401(client):
    assert client.get(TENANT_URL).status_code == 401
    assert client.get(TENANT_URL).headers["www-authenticate"] == "Bearer"
    assert client.get(TENANT_URL, headers=bearer("expired")).status_code == 401
    assert client.get(TENANT_URL, headers=bearer("made-up-token")).status_code == 401
    assert client.get(TENANT_URL, headers={"Authorization": "Basic YWRtaW46YWRtaW4="}).status_code == 401
    assert client.get(TENANT_URL, headers={"Authorization": "Bearer "}).status_code == 401


def test_headers_cannot_substitute_for_a_token(client, tenants):
    headers = {"X-Organization-Id": str(tenants["alpha"].id), "X-User-Role": "organization-admin"}
    assert client.get(TENANT_URL, headers=headers).status_code == 401


# --- 403: authenticated but not allowed --------------------------------------
@pytest.mark.parametrize("token", [
    "super", "super-with-org", "regular", "regular-with-org", "admin-no-org", "admin-bad-org", "admin-inactive",
])
def test_only_active_organization_admins_with_an_organization_may_use_the_tenant_api(client, token):
    response = client.get(TENANT_URL, headers=bearer(token))
    assert response.status_code == 403
    assert response.json()["detail"] == "Organization administrator permission required"


def test_a_missing_organization_and_an_inactive_one_are_indistinguishable(client, tenants, session_factory):
    orphan = client.get(TENANT_URL, headers=bearer("admin-orphan"))
    with session_factory() as db:
        db.get(Organization, tenants["alpha"].id).is_active = False
        db.commit()
    inactive = client.get(TENANT_URL, headers=bearer("admin-alpha"))
    assert orphan.status_code == inactive.status_code == 403
    assert orphan.json() == inactive.json() == {"detail": "Your organization is not active."}


def test_an_inactive_organization_blocks_only_its_own_administrator(client, tenants, session_factory):
    with session_factory() as db:
        db.get(Organization, tenants["beta"].id).is_active = False
        db.commit()
    assert client.get(TENANT_URL, headers=bearer("admin-beta")).status_code == 403
    assert client.get(TENANT_URL, headers=bearer("admin-alpha")).status_code == 200


# --- 503: Auth Service problems ------------------------------------------------
def test_auth_service_failures_return_503_not_401(client):
    assert client.get(TENANT_URL, headers=bearer("auth-broken")).status_code == 503


def test_auth_service_outage_returns_503(tokens):
    def handler(request):
        raise httpx.ConnectError("connection refused")

    down = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://auth-service:8000")
    app.dependency_overrides[get_auth_client] = lambda: down
    try:
        with TestClient(app) as test_client:
            assert test_client.get(TENANT_URL, headers=bearer("admin-alpha")).status_code == 503
            assert test_client.get("/health").status_code == 200  # health stays up
    finally:
        app.dependency_overrides.pop(get_auth_client, None)


# --- the organization comes from the Auth Service's record, never from the caller
def test_the_organization_is_whatever_the_auth_service_says(client, tenants, tokens):
    """Even a request that screams 'Alpha' gets Beta if the Auth Service says the token belongs to Beta."""
    response = client.get(
        TENANT_URL,
        headers={**bearer("admin-beta"), "X-Organization-Id": str(tenants["alpha"].id)},
        params={"organization_id": str(tenants["alpha"].id)},
    )
    assert response.json()["id"] == tokens["admin-beta"][1]["organization_id"] == str(tenants["beta"].id)


# --- Super Admin APIs stay Super Admin only ----------------------------------------
def super_admin_calls(own, other):
    org_json = {"name": "Evil Corp", "slug": "evil-corp", "country_code": "US", "contact_email": "x@evil.example"}
    admin_json = {"email": "someone@example.org", "full_name": "Some One"}
    zero = "00000000-0000-4000-8000-000000000000"
    calls = []
    for org in (own, other):
        calls += [
            ("GET", f"{ORGS}/{org.id}", None), ("GET", f"{ORGS}/{org.slug}", None),
            ("POST", f"{ORGS}/{org.id}/invitations", None), ("POST", f"{ORGS}/{org.id}/invitations/resend", None),
            ("POST", f"{ORGS}/{org.id}/administrators", admin_json),
            ("PATCH", f"{ORGS}/{org.id}/administrators/{zero}", {"full_name": "Hacked Name"}),
            ("DELETE", f"{ORGS}/{org.id}/administrators/{zero}", None),
            ("POST", f"{ORGS}/{org.id}/administrators/{zero}/resend", None),
        ]
    calls += [("GET", ORGS, None), ("POST", ORGS, org_json), ("GET", f"{ORGS}/administrators", None)]
    return calls


@pytest.mark.parametrize("token", ["admin-alpha", "admin-beta"])
def test_organization_admins_cannot_use_any_super_admin_api(client, tenants, session_factory, token):
    own, other = (tenants["alpha"], tenants["beta"]) if token == "admin-alpha" else (tenants["beta"], tenants["alpha"])
    for method, url, body in super_admin_calls(own, other):
        response = client.request(method, url, headers=bearer(token), json=body)
        assert response.status_code == 403, (method, url)
        assert response.json()["detail"] == "Super Admin permission required"
    with session_factory() as db:  # and nothing was created, changed or removed
        assert db.scalar(select(func.count()).select_from(Organization)) == 2
        assert db.scalar(select(func.count()).select_from(OrganizationInvitation)) == 0
        assert {o.name for o in db.scalars(select(Organization))} == {"Alpha Trading", "Beta Logistics"}


def test_super_admin_still_manages_organizations_but_has_no_tenant_access(client, tenants):
    listing = client.get(ORGS, headers=bearer("super"))
    assert listing.status_code == 200 and {o["name"] for o in listing.json()} == {"Alpha Trading", "Beta Logistics"}
    assert client.get(f"{ORGS}/{tenants['beta'].id}", headers=bearer("super")).status_code == 200
    assert client.get(TENANT_URL, headers=bearer("super")).status_code == 403
    assert client.get(TENANT_URL, headers=bearer("super-with-org")).status_code == 403


def test_health_stays_public(client):
    assert client.get("/health").status_code == 200
    assert client.get(f"{ORGS}/health").status_code == 200
