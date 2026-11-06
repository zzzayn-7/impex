"""Module access (Step 19): the Sales module must be enabled for the caller's organization, and the Sales Service enforces it itself.

The Organization Service decides (it lists the organization's usable modules in the answer this service already asks for, with the
caller's own token). Nothing a browser sends is ever read for this: the tests try headers, query strings and bodies anyway.
"""
import re
import uuid

import pytest
from sqlalchemy import text

from app.main import app
from conftest import DISPATCHES, bearer, item_of, sent

PREFIX = "/api/v1/sales"
USAGE = "/internal/v1/organizations/{}/module-usage"
KEY = "test-module-key"


def modules_of(directory, org_id, modules):
    directory.organizations[org_id]["modules"] = list(modules)


def refused(response, module="sales"):
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


def test_the_service_has_routes_to_check():
    assert len(tenant_routes()) >= 30


@pytest.mark.parametrize("method,path,name", tenant_routes(), ids=lambda v: v if isinstance(v, str) else None)
def test_every_sales_route_refuses_an_organization_without_the_module(client, directory, two_orgs, method, path, name):
    modules_of(directory, two_orgs["alpha_id"], ["inventory"])  # Sales is off
    url = re.sub(r"\{[^}]+\}", str(uuid.uuid4()), path)
    response = client.request(method, url, headers=two_orgs["alpha"].headers, json={})
    if name.startswith("confirm_dispatch_"):
        # The one route that must still be able to FINISH a dispatch that is already posting (tested below). Anything else is refused;
        # a dispatch that does not exist is simply not found, and nothing about any record is revealed.
        assert response.status_code == 404, response.text
    else:
        refused(response)


def test_the_same_routes_work_when_the_module_is_enabled(client, two_orgs):
    for path in ("/clients", "/delivery-lists", "/dispatches", "/invoices"):
        assert client.get(PREFIX + path, headers=two_orgs["alpha"].headers).status_code == 200, path


# ---------------------------------------------------------------------------------------------- dependencies
@pytest.mark.parametrize("modules,allowed", [
    (["inventory", "sales"], True),
    (["inventory", "purchasing", "sales"], True),
    (["sales"], False),            # Sales needs Inventory
    (["inventory"], False),
    (["inventory", "purchasing"], False),
    ([], False),
])
def test_sales_needs_itself_and_inventory(client, directory, two_orgs, modules, allowed):
    modules_of(directory, two_orgs["alpha_id"], modules)
    response = client.get(f"{PREFIX}/clients", headers=two_orgs["alpha"].headers)
    assert response.status_code == (200 if allowed else 403), response.text
    if not allowed:
        refused(response)


# ---------------------------------------------------------------------------------------------- an outage never grants access
@pytest.mark.parametrize("mode,expected", [("no-modules", 503), ("garbled-modules", 503), ("down", 503), ("500", 503)])
def test_when_the_entitlement_cannot_be_read_nothing_is_allowed(client, directory, two_orgs, mode, expected):
    directory.org_mode = mode
    response = client.get(f"{PREFIX}/clients", headers=two_orgs["alpha"].headers)
    assert response.status_code == expected, response.text
    # not even a write
    assert client.post(f"{PREFIX}/clients", json={"name": "Sneaky"}, headers=two_orgs["alpha"].headers).status_code == expected


def test_nothing_the_browser_sends_can_switch_a_module_on(client, directory, two_orgs):
    modules_of(directory, two_orgs["alpha_id"], ["inventory"])
    tricks = {
        "headers": {"X-Modules": "inventory,sales", "X-Module": "sales", "X-Organization-Id": two_orgs["beta_id"], "X-Enabled-Modules": "sales"},
    }
    h = {**two_orgs["alpha"].headers, **tricks["headers"]}
    refused(client.get(f"{PREFIX}/clients?modules=sales&organization_id={two_orgs['beta_id']}&module=sales", headers=h))
    refused(client.post(f"{PREFIX}/clients", json={"name": "Sneaky", "modules": ["sales"], "organization_id": two_orgs["beta_id"]}, headers=h))
    assert client.get(f"{PREFIX}/clients", headers=two_orgs["beta"].headers).status_code == 200  # (beta is entitled by its own record)


def test_each_organization_is_judged_by_its_own_entitlement(client, directory, two_orgs):
    modules_of(directory, two_orgs["alpha_id"], ["inventory"])
    refused(client.get(f"{PREFIX}/clients", headers=two_orgs["alpha"].headers))
    assert client.get(f"{PREFIX}/clients", headers=two_orgs["beta"].headers).status_code == 200
    two_orgs["beta"].new_client("Beta customer")
    assert [c["name"] for c in client.get(f"{PREFIX}/clients", headers=two_orgs["beta"].headers).json()["items"]] == ["Beta customer"]
    refused(client.get(f"{PREFIX}/clients", headers=two_orgs["alpha"].headers))


def test_an_inactive_organization_is_still_refused_before_modules_matter(client, directory, two_orgs):
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = False
    response = client.get(f"{PREFIX}/clients", headers=two_orgs["alpha"].headers)
    assert response.status_code == 403 and "not active" in response.json()["detail"]


def test_super_admins_and_other_roles_never_pass(client, directory):
    directory.add_user("root", "super-admin")
    assert client.get(f"{PREFIX}/clients", headers=bearer("root")).status_code == 403


# ---------------------------------------------------------------------------------------------- data stays, and comes back
def test_switching_the_module_off_hides_the_records_and_switching_it_on_restores_them(client, directory, two_orgs, session_factory):
    api, org = two_orgs["alpha"], two_orgs["alpha_id"]
    acme = api.new_client("Acme Ltd")
    delivery_list = api.new_list(acme["id"])

    def rows():
        with session_factory() as db:
            return [db.execute(text(f"SELECT count(*) FROM {t} WHERE organization_id = :o"), {"o": org}).scalar() for t in ("clients", "delivery_lists")]

    before = rows()
    modules_of(directory, org, ["inventory"])
    refused(client.get(f"{PREFIX}/clients/{acme['id']}", headers=api.headers))
    refused(client.get(f"{PREFIX}/delivery-lists/{delivery_list['id']}", headers=api.headers))
    refused(client.patch(f"{PREFIX}/clients/{acme['id']}", json={"name": "Renamed"}, headers=api.headers))
    assert rows() == before == [1, 1]  # not one record was touched
    modules_of(directory, org, ["inventory", "sales"])
    assert api.detail(delivery_list["id"])["id"] == delivery_list["id"]
    assert client.get(f"{PREFIX}/clients/{acme['id']}", headers=api.headers).json()["name"] == "Acme Ltd"


def test_a_change_takes_effect_on_the_very_next_request(client, directory, two_orgs):
    org = two_orgs["alpha_id"]
    for _ in range(2):
        modules_of(directory, org, ["inventory"])
        refused(client.get(f"{PREFIX}/clients", headers=two_orgs["alpha"].headers))
        modules_of(directory, org, ["inventory", "sales"])
        assert client.get(f"{PREFIX}/clients", headers=two_orgs["alpha"].headers).status_code == 200


# ---------------------------------------------------------------------------------------------- pending transactions are never stranded
@pytest.fixture
def stuck(api, directory, inventory, shop, two_orgs):
    """A dispatch left `posting` because Inventory did not answer (15 bolts are already deducted there)."""
    delivery_list = api.ready_list(shop)
    draft = api.draft(delivery_list["id"], [sent(delivery_list, shop["bolt"], 15, shop["main"])])
    inventory.post_modes = ["timeout_after"]
    inventory.lookup_mode = "500"
    assert api.confirm(draft["id"]).status_code == 202
    inventory.lookup_mode = None
    return {"dispatch": draft, "list": delivery_list, "shop": shop}


def test_a_dispatch_that_is_posting_can_still_be_finished_after_the_module_is_switched_off(client, directory, two_orgs, api, inventory, stuck):
    shop, draft = stuck["shop"], stuck["dispatch"]
    assert inventory.quantity(shop["bolt"], shop["main"]) == 25
    modules_of(directory, two_orgs["alpha_id"], ["inventory"])
    refused(client.get(f"{DISPATCHES}/{draft['id']}", headers=api.headers))  # nothing can be read...
    finished = api.confirm(draft["id"])  # ...but the half-done operation can be completed, exactly once
    assert finished.status_code == 200 and finished.json()["status"] == "confirmed"
    assert inventory.quantity(shop["bolt"], shop["main"]) == 25 and len(inventory.ledger) == 1
    refused(api.confirm(draft["id"]))  # finished: nothing more can be done through the disabled module


def test_recovery_is_only_for_a_posting_dispatch(client, directory, two_orgs, api, inventory, shop, stuck):
    other = api.draft(stuck["list"]["id"], [sent(stuck["list"], shop["flour"], 1, shop["main"])])
    modules_of(directory, two_orgs["alpha_id"], ["inventory"])
    refused(api.confirm(other["id"]))  # a DRAFT cannot be confirmed through a disabled module
    refused(client.post(f"{DISPATCHES}/{other['id']}/cancel", headers=api.headers))
    refused(client.put(f"{DISPATCHES}/{other['id']}/lines", json={"lines": []}, headers=api.headers))
    assert len(inventory.postings()) == 1  # only the original posting exists: nothing new was started
    modules_of(directory, two_orgs["alpha_id"], ["inventory", "sales"])
    assert api.get_dispatch(other["id"])["status"] == "draft"  # untouched


def test_recovery_does_not_open_other_organizations(client, directory, two_orgs, api, stuck):
    modules_of(directory, two_orgs["alpha_id"], ["inventory"])
    foreign = two_orgs["beta"].client.post(f"{DISPATCHES}/{stuck['dispatch']['id']}/confirm", headers=two_orgs["beta"].headers)
    assert foreign.status_code == 404  # another organization's dispatch does not exist for beta
    modules_of(directory, two_orgs["beta_id"], ["inventory"])  # and with Sales off for beta as well, it is still just not found
    assert two_orgs["beta"].client.post(f"{DISPATCHES}/{stuck['dispatch']['id']}/confirm", headers=two_orgs["beta"].headers).status_code == 404


# ---------------------------------------------------------------------------------------------- what the Organization Service asks before switching off
@pytest.fixture
def internal_key(monkeypatch):
    monkeypatch.setenv("MODULE_INTERNAL_API_KEY", KEY)


def test_the_usage_endpoint_counts_what_is_in_progress(client, two_orgs, internal_key, stuck, api):
    answer = client.get(USAGE.format(two_orgs["alpha_id"]), headers={"X-Internal-Key": KEY}).json()
    assert answer["module"] == "sales"
    counts = {item["code"]: item["count"] for item in answer["blocking"] + answer["warnings"]}
    assert counts["dispatches_posting"] == 1 and counts["delivery_lists_open"] == 1 and counts["dispatches_draft"] == 0
    assert [item["code"] for item in answer["blocking"]] == ["dispatches_posting"]
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
