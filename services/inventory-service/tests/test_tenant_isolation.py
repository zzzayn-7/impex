"""Two organizations, one administrator each: neither can see or change the other's products.

Also covers who may use the service at all and what happens when the organization is inactive or a
dependency is down. Every attempt to reach "the other" organization must fail, however it is made.
"""
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.auth import get_auth_client, get_org_client
from app.main import app
from app.models import Product

from conftest import bearer

URL = "/api/v1/inventory/products"
CATEGORIES = "/api/v1/inventory/categories"


def payload(**overrides):
    return {"sku": "SKU-1", "name": "Thing", "category": "General", "unit": "pcs", "cost_price": "1.00",
            "selling_price": "2.00", "currency_code": "USD", **overrides}


@pytest.fixture
def world(directory, client):
    """Alpha and Beta, each with an administrator and their own products."""
    alpha, beta = directory.add_organization("Alpha Trading"), directory.add_organization("Beta Logistics")
    directory.add_user("admin-alpha", "organization-admin", alpha)
    directory.add_user("admin-beta", "organization-admin", beta)
    products = {}
    for key, token in (("alpha", "admin-alpha"), ("beta", "admin-beta")):
        products[key] = [
            client.post(URL, json=payload(sku=f"{key.upper()}-1", name=f"{key} bolt", category=f"{key}-cat"), headers=bearer(token)).json(),
            client.post(URL, json=payload(sku="SHARED-SKU", name=f"{key} shared", category="Common"), headers=bearer(token)).json(),
        ]
    return {"alpha": alpha, "beta": beta, "products": products}


def rows(session_factory):
    with session_factory() as db:
        return {p.id: p for p in db.scalars(select(Product)).all()}


# --- reading ----------------------------------------------------------------------
def test_each_administrator_lists_only_their_own_products(client, world):
    for token, own, other in (("admin-alpha", "alpha", "beta"), ("admin-beta", "beta", "alpha")):
        response = client.get(URL, params={"status": "all"}, headers=bearer(token))
        body = response.json()
        assert body["total"] == 2
        assert {p["id"] for p in body["items"]} == {p["id"] for p in world["products"][own]}
        assert other not in response.text.lower()  # not a single trace of the other organization's products


def test_search_and_filters_cannot_find_the_other_tenants_products(client, world):
    alpha = bearer("admin-alpha")
    assert client.get(URL, params={"q": "BETA-1"}, headers=alpha).json()["total"] == 0
    assert client.get(URL, params={"q": "beta"}, headers=alpha).json()["total"] == 0
    assert client.get(URL, params={"category": "beta-cat"}, headers=alpha).json()["total"] == 0
    assert client.get(CATEGORIES, headers=alpha).json() == ["Common", "alpha-cat"]
    assert client.get(CATEGORIES, headers=bearer("admin-beta")).json() == ["Common", "beta-cat"]


def test_viewing_another_tenants_product_is_indistinguishable_from_a_missing_one(client, world):
    theirs = world["products"]["beta"][0]["id"]
    foreign = client.get(f"{URL}/{theirs}", headers=bearer("admin-alpha"))
    missing = client.get(f"{URL}/00000000-0000-4000-8000-000000000000", headers=bearer("admin-alpha"))
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json() == {"detail": "Product not found."}
    assert "beta" not in foreign.text.lower()


@pytest.mark.parametrize("attacker,victim", [("admin-alpha", "beta"), ("admin-beta", "alpha")])
def test_neither_administrator_can_modify_the_others_products(client, world, session_factory, attacker, victim):
    before = rows(session_factory)
    target = world["products"][victim][0]["id"]
    headers = bearer(attacker)
    assert client.patch(f"{URL}/{target}", json={"name": "HIJACKED", "selling_price": "0.01"}, headers=headers).status_code == 404
    assert client.post(f"{URL}/{target}/archive", headers=headers).status_code == 404
    assert client.post(f"{URL}/{target}/restore", headers=headers).status_code == 404
    assert client.delete(f"{URL}/{target}", headers=headers).status_code == 405  # there is no hard delete at all
    after = rows(session_factory)
    assert {k: (v.name, v.selling_price, v.is_active, v.organization_id, v.updated_at) for k, v in after.items()} == \
           {k: (v.name, v.selling_price, v.is_active, v.organization_id, v.updated_at) for k, v in before.items()}


def test_the_same_sku_can_exist_in_both_catalogs(client, world):
    alpha = client.get(URL, params={"q": "SHARED-SKU"}, headers=bearer("admin-alpha")).json()["items"]
    beta = client.get(URL, params={"q": "SHARED-SKU"}, headers=bearer("admin-beta")).json()["items"]
    assert [p["name"] for p in alpha] == ["alpha shared"] and [p["name"] for p in beta] == ["beta shared"]
    # but still not twice within one catalog
    assert client.post(URL, json=payload(sku="shared-sku"), headers=bearer("admin-alpha")).status_code == 409


# --- the organization can never be chosen by the caller --------------------------------
def test_new_products_belong_to_the_authenticated_administrators_organization(client, world, session_factory):
    response = client.post(URL, json=payload(sku="NEW-A"), headers=bearer("admin-alpha"))
    assert response.status_code == 201
    assert str(rows(session_factory)[uuid.UUID(response.json()["id"])].organization_id) == world["alpha"]


@pytest.mark.parametrize("field", ["organization_id", "organizationId", "tenant_id", "org_id"])
def test_an_organization_id_in_the_body_is_rejected(client, world, session_factory, field):
    before = rows(session_factory)
    created = client.post(URL, json=payload(sku="EVIL", **{field: world["beta"]}), headers=bearer("admin-alpha"))
    assert created.status_code == 422
    product = world["products"]["alpha"][0]["id"]
    assert client.patch(f"{URL}/{product}", json={field: world["beta"]}, headers=bearer("admin-alpha")).status_code == 422
    after = rows(session_factory)
    assert set(after) == set(before)
    assert {str(p.organization_id) for p in after.values() if p.sku == "ALPHA-1"} == {world["alpha"]}


def test_query_headers_cookies_and_bodies_naming_another_organization_change_nothing(client, world):
    beta_id = world["beta"]
    listing = client.get(
        URL,
        params={"organization_id": beta_id, "org_id": beta_id, "tenant_id": beta_id},
        headers={**bearer("admin-alpha"), "X-Organization-Id": beta_id, "X-Tenant-Id": beta_id, "Cookie": f"organization_id={beta_id}"},
    ).json()
    assert {p["sku"] for p in listing["items"]} == {"ALPHA-1", "SHARED-SKU"} and listing["total"] == 2
    created = client.post(URL + f"?organization_id={beta_id}", json=payload(sku="VIA-QUERY"),
                          headers={**bearer("admin-alpha"), "X-Organization-Id": beta_id})
    assert created.status_code == 201
    assert client.get(URL, params={"q": "VIA-QUERY"}, headers=bearer("admin-beta")).json()["total"] == 0  # not in Beta's catalog


def test_no_endpoint_declares_an_organization_input(client):
    spec = client.get("/openapi.json").json()
    for path, operations in spec["paths"].items():
        for method, operation in operations.items():
            names = {p["name"].lower() for p in operation.get("parameters", [])}
            assert not [n for n in names if "org" in n or "tenant" in n], (method, path)
    for name, schema in spec["components"]["schemas"].items():
        assert not [p for p in schema.get("properties", {}) if "org" in p.lower() or "tenant" in p.lower()], name


# --- who may use the service ---------------------------------------------------------
@pytest.mark.parametrize("method,path", [("GET", URL), ("POST", URL), ("GET", CATEGORIES),
                                         ("GET", URL + "/00000000-0000-4000-8000-000000000000"),
                                         ("PATCH", URL + "/00000000-0000-4000-8000-000000000000"),
                                         ("POST", URL + "/00000000-0000-4000-8000-000000000000/archive")])
def test_authentication_and_role_rules_apply_to_every_endpoint(client, directory, world, method, path):
    directory.add_user("super", "super-admin")
    directory.add_user("super-with-org", "super-admin", world["alpha"])
    directory.add_user("regular", "user", world["alpha"])
    directory.add_user("no-org", "organization-admin", None)
    directory.add_user("bad-org", "organization-admin", "not-a-uuid")
    directory.add_user("disabled", "organization-admin", world["alpha"], is_active=False)
    directory.add_user("orphan", "organization-admin", "11111111-2222-4333-8444-555555555555")  # no such organization
    body = {"json": payload()} if method in ("POST", "PATCH") and not path.endswith("archive") else {}
    assert client.request(method, path, **body).status_code == 401
    assert client.request(method, path, headers=bearer("made-up"), **body).status_code == 401
    assert client.request(method, path, headers={"X-Organization-Id": world["alpha"]}, **body).status_code == 401
    for token in ("super", "super-with-org", "regular", "no-org", "bad-org", "disabled", "orphan"):
        assert client.request(method, path, headers=bearer(token), **body).status_code == 403, token


def test_super_admins_have_no_access_to_tenant_products(client, directory, world):
    directory.add_user("super", "super-admin")
    response = client.get(URL, headers=bearer("super"))
    assert response.status_code == 403 and response.json()["detail"] == "Organization administrator permission required"


# --- the organization must be active ----------------------------------------------------
def test_an_inactive_organization_cannot_touch_its_products_but_others_are_unaffected(client, directory, world, session_factory):
    product_id = world["products"]["alpha"][0]["id"]
    directory.organizations[world["alpha"]]["is_active"] = False
    alpha = bearer("admin-alpha")
    calls = [("GET", URL, None), ("POST", URL, payload(sku="X")), ("GET", CATEGORIES, None), ("GET", f"{URL}/{product_id}", None),
            ("PATCH", f"{URL}/{product_id}", {"name": "n"}), ("POST", f"{URL}/{product_id}/archive", None),
            ("POST", f"{URL}/{product_id}/restore", None)]
    for method, path, body in calls:
        response = client.request(method, path, json=body, headers=alpha)
        assert response.status_code == 403 and response.json()["detail"] == "Your organization is not active.", (method, path)
    assert client.get(URL, headers=bearer("admin-beta")).json()["total"] == 2  # Beta is unaffected
    assert len(rows(session_factory)) == 4  # nothing created, nothing erased
    directory.organizations[world["alpha"]]["is_active"] = True
    assert client.get(URL, headers=alpha).json()["total"] == 2  # and the data is all still there


def test_the_organization_is_checked_with_the_callers_own_token_on_every_request(client, directory, world):
    client.get(URL, headers=bearer("admin-alpha"))
    client.get(URL, headers=bearer("admin-beta"))
    assert [c["authorization"] for c in directory.org_calls[-2:]] == ["Bearer admin-alpha", "Bearer admin-beta"]
    assert all(set(c) <= {"host", "accept", "accept-encoding", "connection", "user-agent", "authorization"} for c in directory.org_calls)


def test_a_mismatched_organization_answer_is_refused(directory, world):
    """If the Organization Service ever answered with a different organization, access is refused."""
    def other_org(request):
        return httpx.Response(200, json={"id": world["beta"], "name": "Beta Logistics", "is_active": True})

    auth, _ = directory.clients()
    wrong = httpx.AsyncClient(transport=httpx.MockTransport(other_org), base_url="http://organization-service:8001")
    app.dependency_overrides[get_auth_client] = lambda: auth
    app.dependency_overrides[get_org_client] = lambda: wrong
    try:
        with TestClient(app) as c:
            assert c.get(URL, headers=bearer("admin-alpha")).status_code == 403
    finally:
        app.dependency_overrides.pop(get_auth_client, None)
        app.dependency_overrides.pop(get_org_client, None)


# --- dependency failures -----------------------------------------------------------------
@pytest.mark.parametrize("which,mode", [("auth_mode", "down"), ("auth_mode", "500"), ("org_mode", "down"), ("org_mode", "500")])
def test_a_dependency_outage_returns_503_never_401_or_data(client, directory, world, which, mode):
    setattr(directory, which, mode)
    response = client.get(URL, headers=bearer("admin-alpha"))
    assert response.status_code == 503
    assert response.json()["detail"] in ("Authentication service unavailable", "Organization service unavailable")
    assert client.get("/health").status_code == 200


def test_nothing_is_ever_hard_deleted_through_the_api(client, world, session_factory):
    target = world["products"]["alpha"][0]["id"]
    assert client.delete(f"{URL}/{target}", headers=bearer("admin-alpha")).status_code == 405
    with session_factory() as db:
        assert db.scalar(select(func.count()).select_from(Product)) == 4
