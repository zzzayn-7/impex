"""Module access (Step 19): the Purchasing module must be enabled for the caller's organization, and the Purchasing Service enforces it itself.

The Organization Service decides (it lists the organization's usable modules in the answer this service already asks for, with the
caller's own token). Nothing a browser sends is ever read for this: the tests try headers, query strings and bodies anyway.
"""
import re
import uuid

import pytest
from sqlalchemy import text

from app.main import app
from conftest import RECEIPTS, bearer, received

PREFIX = "/api/v1/purchasing"
USAGE = "/internal/v1/organizations/{}/module-usage"
KEY = "test-module-key"


def modules_of(directory, org_id, modules):
    directory.organizations[org_id]["modules"] = list(modules)


def refused(response, module="purchasing"):
    assert response.status_code == 403, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "module_disabled" and detail["module"] == module and "not enabled" in detail["message"]


def tenant_routes():
    """Every public route of the service, from its own OpenAPI document (so a route added later is covered automatically)."""
    routes = []
    for path, operations in app.openapi()["paths"].items():
        if path.startswith(PREFIX) and not path.endswith("/health"):
            for method, operation in operations.items():
                routes.append((method.upper(), path, operation["operationId"]))
    return routes


# ---------------------------------------------------------------------------------------------- every route
def test_the_service_has_routes_to_check():
    assert len(tenant_routes()) >= 20


@pytest.mark.parametrize("method,path,name", tenant_routes(), ids=lambda v: v if isinstance(v, str) else None)
def test_every_purchasing_route_refuses_an_organization_without_the_module(client, directory, two_orgs, method, path, name):
    modules_of(directory, two_orgs["alpha_id"], ["inventory"])  # Purchasing is off
    url = re.sub(r"\{[^}]+\}", str(uuid.uuid4()), path)
    response = client.request(method, url, headers=two_orgs["alpha"].headers, json={})
    if name.startswith("confirm_goods_receipt_"):
        # The one route that must still be able to FINISH a receipt that is already posting (tested below). Anything else is refused;
        # a receipt that does not exist is simply not found, and nothing about any record is revealed.
        assert response.status_code == 404, response.text
    else:
        refused(response)


def test_the_same_routes_work_when_the_module_is_enabled(client, two_orgs):
    for path in ("/suppliers", "/purchase-orders", "/goods-receipts"):
        assert client.get(PREFIX + path, headers=two_orgs["alpha"].headers).status_code == 200, path


# ---------------------------------------------------------------------------------------------- dependencies
@pytest.mark.parametrize("modules,allowed", [
    (["inventory", "purchasing"], True),
    (["inventory", "purchasing", "sales"], True),
    (["purchasing"], False),       # Purchasing needs Inventory
    (["inventory"], False),
    (["inventory", "sales"], False),
    ([], False),
])
def test_purchasing_needs_itself_and_inventory(client, directory, two_orgs, modules, allowed):
    modules_of(directory, two_orgs["alpha_id"], modules)
    response = client.get(f"{PREFIX}/suppliers", headers=two_orgs["alpha"].headers)
    assert response.status_code == (200 if allowed else 403), response.text
    if not allowed:
        refused(response)


# ---------------------------------------------------------------------------------------------- an outage never grants access
@pytest.mark.parametrize("mode", ["no-modules", "garbled-modules", "down", "500"])
def test_when_the_entitlement_cannot_be_read_nothing_is_allowed(client, directory, two_orgs, mode):
    directory.org_mode = mode
    assert client.get(f"{PREFIX}/suppliers", headers=two_orgs["alpha"].headers).status_code == 503
    assert client.post(f"{PREFIX}/suppliers", json={"name": "Sneaky"}, headers=two_orgs["alpha"].headers).status_code == 503


def test_nothing_the_browser_sends_can_switch_a_module_on(client, directory, two_orgs):
    modules_of(directory, two_orgs["alpha_id"], ["inventory"])
    h = {**two_orgs["alpha"].headers, "X-Modules": "inventory,purchasing", "X-Module": "purchasing", "X-Organization-Id": two_orgs["beta_id"]}
    refused(client.get(f"{PREFIX}/suppliers?modules=purchasing&organization_id={two_orgs['beta_id']}", headers=h))
    refused(client.post(f"{PREFIX}/suppliers", json={"name": "Sneaky", "modules": ["purchasing"], "organization_id": two_orgs["beta_id"]}, headers=h))
    assert client.get(f"{PREFIX}/suppliers", headers=two_orgs["beta"].headers).status_code == 200  # beta is entitled by its own record


def test_each_organization_is_judged_by_its_own_entitlement(client, directory, two_orgs):
    modules_of(directory, two_orgs["alpha_id"], ["inventory"])
    refused(client.get(f"{PREFIX}/suppliers", headers=two_orgs["alpha"].headers))
    two_orgs["beta"].supplier("Beta Supplies")
    assert [s["name"] for s in client.get(f"{PREFIX}/suppliers", headers=two_orgs["beta"].headers).json()["items"]] == ["Beta Supplies"]


def test_an_inactive_organization_is_still_refused_before_modules_matter(client, directory, two_orgs):
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = False
    response = client.get(f"{PREFIX}/suppliers", headers=two_orgs["alpha"].headers)
    assert response.status_code == 403 and "not active" in response.json()["detail"]


def test_super_admins_and_other_roles_never_pass(client, directory):
    directory.add_user("root", "super-admin")
    assert client.get(f"{PREFIX}/suppliers", headers=bearer("root")).status_code == 403


# ---------------------------------------------------------------------------------------------- data stays, and comes back
def test_switching_the_module_off_hides_the_records_and_switching_it_on_restores_them(client, directory, two_orgs, shop, session_factory):
    api, org = two_orgs["alpha"], two_orgs["alpha_id"]
    order = api.ordered(shop)

    def rows():
        with session_factory() as db:
            return [db.execute(text(f"SELECT count(*) FROM {t} WHERE organization_id = :o"), {"o": org}).scalar() for t in ("suppliers", "purchase_orders", "purchase_order_lines")]

    before = rows()
    assert before == [1, 1, 2]
    modules_of(directory, org, ["inventory"])
    refused(client.get(f"{PREFIX}/purchase-orders/{order['id']}", headers=api.headers))
    refused(client.post(f"{PREFIX}/purchase-orders/{order['id']}/cancel", headers=api.headers))
    refused(client.get(f"{PREFIX}/suppliers/{order['supplier']['id']}", headers=api.headers))
    assert rows() == before  # not one record was touched
    modules_of(directory, org, ["inventory", "purchasing"])
    again = api.detail(order["id"])
    assert again["id"] == order["id"] and again["status"] == "ordered" and len(again["lines"]) == 2


def test_a_change_takes_effect_on_the_very_next_request(client, directory, two_orgs):
    org = two_orgs["alpha_id"]
    for _ in range(2):
        modules_of(directory, org, ["inventory"])
        refused(client.get(f"{PREFIX}/suppliers", headers=two_orgs["alpha"].headers))
        modules_of(directory, org, ["inventory", "purchasing"])
        assert client.get(f"{PREFIX}/suppliers", headers=two_orgs["alpha"].headers).status_code == 200


# ---------------------------------------------------------------------------------------------- pending transactions are never stranded
@pytest.fixture
def stuck(api, directory, inventory, shop, two_orgs):
    """A goods receipt left `posting` because Inventory did not answer (10 bolts are already added there)."""
    order = api.ordered(shop)
    draft = api.draft(order["id"], [received(order, shop["bolt"], 10)])
    inventory.post_modes = ["timeout_after"]
    inventory.lookup_mode = "500"
    assert api.confirm(draft["id"]).status_code == 202
    inventory.lookup_mode = None
    return {"receipt": draft, "order": order, "shop": shop}


def test_a_receipt_that_is_posting_can_still_be_finished_after_the_module_is_switched_off(client, directory, two_orgs, api, inventory, stuck):
    shop, draft = stuck["shop"], stuck["receipt"]
    assert inventory.quantity(shop["bolt"]) == 50
    modules_of(directory, two_orgs["alpha_id"], ["inventory"])
    refused(client.get(f"{RECEIPTS}/{draft['id']}", headers=api.headers))  # nothing can be read...
    finished = api.confirm(draft["id"])  # ...but the half-done operation can be completed, exactly once
    assert finished.status_code == 200 and finished.json()["status"] == "confirmed"
    assert inventory.quantity(shop["bolt"]) == 50 and len(inventory.ledger) == 1
    refused(api.confirm(draft["id"]))  # finished: nothing more can be done through the disabled module


def test_recovery_is_only_for_a_posting_receipt(client, directory, two_orgs, api, inventory, shop, stuck):
    other = api.draft(stuck["order"]["id"], [received(stuck["order"], shop["flour"], 1)])
    modules_of(directory, two_orgs["alpha_id"], ["inventory"])
    refused(api.confirm(other["id"]))  # a DRAFT cannot be confirmed through a disabled module
    refused(client.post(f"{RECEIPTS}/{other['id']}/cancel", headers=api.headers))
    refused(client.put(f"{RECEIPTS}/{other['id']}/lines", json={"lines": []}, headers=api.headers))
    assert len(inventory.postings()) == 1  # only the original posting exists: nothing new was started
    modules_of(directory, two_orgs["alpha_id"], ["inventory", "purchasing"])
    assert api.get_receipt(other["id"])["status"] == "draft"  # untouched


def test_recovery_does_not_open_other_organizations(client, directory, two_orgs, stuck):
    modules_of(directory, two_orgs["alpha_id"], ["inventory"])
    modules_of(directory, two_orgs["beta_id"], ["inventory"])
    foreign = client.post(f"{RECEIPTS}/{stuck['receipt']['id']}/confirm", headers=two_orgs["beta"].headers)
    assert foreign.status_code == 404  # another organization's receipt does not exist for beta, module on or off


# ---------------------------------------------------------------------------------------------- what the Organization Service asks before switching off
@pytest.fixture
def internal_key(monkeypatch):
    monkeypatch.setenv("MODULE_INTERNAL_API_KEY", KEY)


def test_the_usage_endpoint_counts_what_is_in_progress(client, two_orgs, internal_key, stuck, api):
    answer = client.get(USAGE.format(two_orgs["alpha_id"]), headers={"X-Internal-Key": KEY}).json()
    assert answer["module"] == "purchasing"
    counts = {item["code"]: item["count"] for item in answer["blocking"] + answer["warnings"]}
    assert counts["receipts_posting"] == 1 and counts["orders_awaiting_goods"] == 1 and counts["receipts_draft"] == 0
    assert [item["code"] for item in answer["blocking"]] == ["receipts_posting"]
    other = client.get(USAGE.format(two_orgs["beta_id"]), headers={"X-Internal-Key": KEY}).json()
    assert all(item["count"] == 0 for item in other["blocking"] + other["warnings"])  # scoped to the organization asked about


def test_the_usage_endpoint_is_for_the_organization_service_only(client, monkeypatch, two_orgs):
    url = USAGE.format(two_orgs["alpha_id"])
    monkeypatch.delenv("MODULE_INTERNAL_API_KEY", raising=False)
    assert client.get(url, headers={"X-Internal-Key": "anything"}).status_code == 503  # not configured: never open
    monkeypatch.setenv("MODULE_INTERNAL_API_KEY", KEY)
    assert client.get(url).status_code == 401
    assert client.get(url, headers={"X-Internal-Key": "wrong"}).status_code == 401
    assert client.get(url, headers=two_orgs["alpha"].headers).status_code == 401  # a user's token is not a service credential
    assert client.get(USAGE.format("not-a-uuid"), headers={"X-Internal-Key": KEY}).status_code == 422
    assert "module-usage" not in client.get("/openapi.json").text  # not in the public documentation
