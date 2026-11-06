"""Module access (Step 19): the Inventory module must be enabled for the caller's organization, and the Inventory Service enforces it itself.

Inventory is the base of Purchasing and Sales, which read products and move stock through this service with the caller's own token.
Switching Inventory off therefore also stops them from working, and the Organization Service refuses to switch it off while they are on.
"""
import re
import uuid

import pytest
from sqlalchemy import text

from app.main import app
from conftest import bearer

PREFIX = "/api/v1/inventory"


def modules_of(directory, org_id, modules):
    directory.organizations[org_id]["modules"] = list(modules)


def refused(response):
    assert response.status_code == 403, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "module_disabled" and detail["module"] == "inventory" and "not enabled" in detail["message"]


def tenant_routes():
    """Every public route of the service, from its own OpenAPI document (so a route added later is covered automatically)."""
    routes = []
    for path, operations in app.openapi()["paths"].items():
        if path.startswith(PREFIX) and not path.endswith("/health"):
            for method, operation in operations.items():
                routes.append((method.upper(), path, operation["operationId"]))
    return routes


def test_the_service_has_routes_to_check():
    assert len(tenant_routes()) >= 25


@pytest.mark.parametrize("method,path,name", tenant_routes(), ids=lambda v: v if isinstance(v, str) else None)
def test_every_inventory_route_refuses_an_organization_without_the_module(client, directory, two_orgs, method, path, name):
    modules_of(directory, two_orgs["alpha_id"], ["purchasing", "sales"])  # Inventory is off
    url = re.sub(r"\{[^}]+\}", str(uuid.uuid4()), path)
    refused(client.request(method, url, headers=two_orgs["alpha"].headers, json={}))


def test_the_same_routes_work_when_the_module_is_enabled(client, two_orgs):
    for path in ("/products", "/warehouses", "/stock", "/stock/movements"):
        assert client.get(PREFIX + path, headers=two_orgs["alpha"].headers).status_code == 200, path


@pytest.mark.parametrize("modules,allowed", [
    (["inventory"], True),
    (["inventory", "purchasing", "sales"], True),
    (["purchasing", "sales"], False),   # the others do not bring Inventory with them
    (["purchasing"], False),
    ([], False),
])
def test_inventory_needs_only_itself(client, directory, two_orgs, modules, allowed):
    modules_of(directory, two_orgs["alpha_id"], modules)
    response = client.get(f"{PREFIX}/products", headers=two_orgs["alpha"].headers)
    assert response.status_code == (200 if allowed else 403), response.text
    if not allowed:
        refused(response)


@pytest.mark.parametrize("mode", ["no-modules", "garbled-modules", "down", "500"])
def test_when_the_entitlement_cannot_be_read_nothing_is_allowed(client, directory, two_orgs, mode):
    directory.org_mode = mode
    assert client.get(f"{PREFIX}/products", headers=two_orgs["alpha"].headers).status_code == 503
    assert client.post(f"{PREFIX}/warehouses", json={"code": "X", "name": "X"}, headers=two_orgs["alpha"].headers).status_code == 503


def test_nothing_the_browser_sends_can_switch_a_module_on(client, directory, two_orgs):
    modules_of(directory, two_orgs["alpha_id"], [])
    h = {**two_orgs["alpha"].headers, "X-Modules": "inventory", "X-Module": "inventory", "X-Organization-Id": two_orgs["beta_id"]}
    refused(client.get(f"{PREFIX}/products?modules=inventory&organization_id={two_orgs['beta_id']}", headers=h))
    refused(client.post(f"{PREFIX}/products", json={"sku": "S", "name": "N", "unit": "pcs", "modules": ["inventory"]}, headers=h))
    assert client.get(f"{PREFIX}/products", headers=two_orgs["beta"].headers).status_code == 200


def test_each_organization_is_judged_by_its_own_entitlement(client, directory, two_orgs):
    two_orgs["beta"].product(sku="BETA-1")
    modules_of(directory, two_orgs["alpha_id"], [])
    refused(client.get(f"{PREFIX}/products", headers=two_orgs["alpha"].headers))
    assert [p["sku"] for p in client.get(f"{PREFIX}/products", headers=two_orgs["beta"].headers).json()["items"]] == ["BETA-1"]


def test_an_inactive_organization_is_still_refused_before_modules_matter(client, directory, two_orgs):
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = False
    response = client.get(f"{PREFIX}/products", headers=two_orgs["alpha"].headers)
    assert response.status_code == 403 and "not active" in response.json()["detail"]


def test_super_admins_never_pass(client, directory):
    directory.add_user("root", "super-admin")
    assert client.get(f"{PREFIX}/products", headers=bearer("root")).status_code == 403


def test_switching_the_module_off_hides_stock_and_products_and_switching_it_on_restores_them(client, directory, two_orgs, session_factory):
    api, org = two_orgs["alpha"], two_orgs["alpha_id"]
    bolt, depot = api.product(sku="BOLT-1"), api.warehouse("MAIN")
    api.add(bolt, depot, 40)

    def rows():
        with session_factory() as db:
            return [db.execute(text(f"SELECT count(*) FROM {t} WHERE organization_id = :o"), {"o": org}).scalar() for t in ("products", "warehouses", "stock_movements")]

    before = rows()
    assert before[0] == 1 and before[1] == 1 and before[2] >= 1
    modules_of(directory, org, ["purchasing", "sales"])
    refused(client.get(f"{PREFIX}/products/{bolt['id']}", headers=api.headers))
    refused(api.change("out", product_id=bolt["id"], warehouse_id=depot["id"], quantity="5"))  # stock cannot move while it is off
    refused(client.get(f"{PREFIX}/stock", headers=api.headers))
    assert rows() == before  # not one record was touched
    modules_of(directory, org, ["inventory"])
    assert api.quantity(bolt, depot) in ("40", "40.0000")
    assert client.get(f"{PREFIX}/products/{bolt['id']}", headers=api.headers).json()["sku"] == "BOLT-1"


def test_a_change_takes_effect_on_the_very_next_request(client, directory, two_orgs):
    org = two_orgs["alpha_id"]
    for _ in range(2):
        modules_of(directory, org, [])
        refused(client.get(f"{PREFIX}/products", headers=two_orgs["alpha"].headers))
        modules_of(directory, org, ["inventory"])
        assert client.get(f"{PREFIX}/products", headers=two_orgs["alpha"].headers).status_code == 200
