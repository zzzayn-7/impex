"""Who may use Finance: administrators of an organization that is active, set up, and has the Finance module - and only their own organization's books.

Every route is enumerated from the service's own OpenAPI document, so a route added later is covered automatically.
"""
import re
import uuid

import pytest

from app.main import app
from conftest import ACCOUNTS, ENTRIES, EXPENSES, PREFIX, bearer

HEALTH = {f"{PREFIX}/health"}


def tenant_routes():
    routes = []
    for path, operations in app.openapi()["paths"].items():
        if path.startswith(PREFIX) and path not in HEALTH:
            for method, operation in operations.items():
                routes.append((method.upper(), path, operation["operationId"]))
    return routes


def call(client, method, path, headers, **kw):
    return client.request(method, re.sub(r"\{[^}]+\}", str(uuid.uuid4()), path), headers=headers, json={}, **kw)


def test_the_service_has_routes_to_check():
    assert len(tenant_routes()) == 23  # a new route must be added deliberately: it is then covered by every gate below


# ------------------------------------------------------------------------------------------------------------------ authentication
@pytest.mark.parametrize("method,path,name", tenant_routes(), ids=lambda v: v if isinstance(v, str) else None)
def test_every_route_needs_a_token(client, method, path, name):
    assert call(client, method, path, {}).status_code == 401
    assert call(client, method, path, bearer("not-a-real-token")).status_code == 401


@pytest.mark.parametrize("method,path,name", tenant_routes(), ids=lambda v: v if isinstance(v, str) else None)
def test_a_super_admin_session_grants_no_tenant_access(client, directory, method, path, name):
    directory.add_user("root", "super-admin", None)
    assert call(client, method, path, bearer("root")).status_code == 403


def test_a_deactivated_administrator_and_an_inactive_organization_are_refused(client, directory, two_orgs):
    directory.users["admin-alpha"]["is_active"] = False
    assert client.get(ACCOUNTS, headers=bearer("admin-alpha")).status_code == 403
    directory.users["admin-alpha"]["is_active"] = True
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = False
    assert client.get(ACCOUNTS, headers=bearer("admin-alpha")).status_code == 403


# ------------------------------------------------------------------------------------------------------------------ first-time setup
def refused_setup(response):
    assert response.status_code == 403, response.text
    assert response.json()["detail"]["code"] == "setup_required"


@pytest.mark.parametrize("method,path,name", tenant_routes(), ids=lambda v: v if isinstance(v, str) else None)
@pytest.mark.parametrize("setup", ["pending", "in_progress"])
def test_every_route_refuses_an_organization_that_is_not_set_up(client, directory, two_orgs, method, path, name, setup):
    directory.organizations[two_orgs["alpha_id"]]["setup_status"] = setup
    refused_setup(call(client, method, path, two_orgs["alpha"].headers))


@pytest.mark.parametrize("method,path,name", tenant_routes(), ids=lambda v: v if isinstance(v, str) else None)
def test_every_route_refuses_an_administrator_whose_profile_is_not_confirmed(client, directory, two_orgs, method, path, name):
    directory.users["admin-alpha"]["profile_setup_completed_at"] = None
    refused_setup(call(client, method, path, two_orgs["alpha"].headers))


def test_a_missing_setup_status_is_not_read_as_complete(client, directory, two_orgs):
    directory.org_mode = "no-setup-status"
    refused_setup(client.get(ACCOUNTS, headers=two_orgs["alpha"].headers))


# ------------------------------------------------------------------------------------------------------------------ the module gate
def module_refused(response):
    assert response.status_code == 403, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "module_disabled" and detail["module"] == "finance" and "not enabled" in detail["message"]


@pytest.mark.parametrize("method,path,name", tenant_routes(), ids=lambda v: v if isinstance(v, str) else None)
def test_every_route_refuses_an_organization_without_the_finance_module(client, directory, two_orgs, method, path, name):
    directory.organizations[two_orgs["alpha_id"]]["modules"] = ["inventory", "purchasing", "sales"]  # everything but Finance
    module_refused(call(client, method, path, two_orgs["alpha"].headers))


def test_other_modules_do_not_grant_finance_and_finance_alone_is_enough(client, directory, two_orgs):
    org = two_orgs["alpha_id"]
    directory.organizations[org]["modules"] = ["inventory", "sales", "purchasing"]
    module_refused(client.get(ACCOUNTS, headers=two_orgs["alpha"].headers))
    directory.organizations[org]["modules"] = ["finance"]
    assert client.get(ACCOUNTS, headers=two_orgs["alpha"].headers).status_code == 200


def test_a_missing_or_garbled_module_list_is_never_read_as_enabled(client, directory, two_orgs):
    directory.org_mode = "no-modules"
    assert client.get(ACCOUNTS, headers=two_orgs["alpha"].headers).status_code == 503
    directory.org_mode = "garbled-modules"
    assert client.get(ACCOUNTS, headers=two_orgs["alpha"].headers).status_code in (403, 503)


def test_nothing_the_browser_sends_can_enable_the_module(client, directory, two_orgs):
    directory.organizations[two_orgs["alpha_id"]]["modules"] = []
    headers = {**two_orgs["alpha"].headers, "X-Modules": "finance", "X-Module": "finance", "X-Organization-Id": two_orgs["alpha_id"]}
    module_refused(client.get(ACCOUNTS, headers=headers, params={"modules": "finance", "module": "finance"}))
    module_refused(client.post(ENTRIES, headers={**headers, "Idempotency-Key": "module-key-001"}, json={"modules": ["finance"], "entry_date": "2026-11-05", "description": "x", "lines": []}))


def test_switching_the_module_off_keeps_the_books_and_switching_it_on_restores_them(client, directory, two_orgs):
    api, org = two_orgs["alpha"], two_orgs["alpha_id"]
    entry = api.balanced()
    directory.organizations[org]["modules"] = []
    module_refused(client.get(f"{ENTRIES}/{entry['id']}", headers=api.headers))
    directory.organizations[org]["modules"] = ["finance"]
    assert client.get(f"{ENTRIES}/{entry['id']}", headers=api.headers).json()["entry_number"] == "JE-000001"


def test_the_health_check_is_public(client):
    assert client.get(f"{PREFIX}/health").status_code == 200 and client.get("/health").json()["service"] == "finance-service"


# ------------------------------------------------------------------------------------------------------------------ tenant isolation
def test_one_organization_cannot_see_or_touch_anothers_books(client, two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    entry, draft = alpha.balanced(), alpha.entry([(alpha.acct("1100"), "1", "0"), (alpha.acct("4000"), "0", "1")])
    expense, expense_draft = alpha.expense(post=True), alpha.expense()
    account = alpha.new_account("6500", "Alpha only")
    beta.accounts()
    theirs = beta.headers
    gone = lambda r: r.status_code == 404  # noqa: E731 - another tenant's record is indistinguishable from a missing one
    assert gone(client.get(f"{ENTRIES}/{entry['id']}", headers=theirs))
    assert gone(client.post(f"{ENTRIES}/{entry['id']}/reverse", json={"reason": "Not mine to reverse"}, headers=theirs))
    assert gone(client.post(f"{ENTRIES}/{draft['id']}/post", headers=theirs))
    assert gone(client.delete(f"{ENTRIES}/{draft['id']}", headers=theirs))
    assert gone(client.put(f"{ENTRIES}/{draft['id']}", headers=theirs, json={"entry_date": "2026-11-05", "description": "x", "currency_code": "USD", "lines": []}))
    assert gone(client.get(f"{EXPENSES}/{expense['id']}", headers=theirs))
    assert gone(client.post(f"{EXPENSES}/{expense['id']}/reverse", json={"reason": "Not mine to reverse"}, headers=theirs))
    assert gone(client.post(f"{EXPENSES}/{expense_draft['id']}/post", headers=theirs))
    assert gone(client.delete(f"{EXPENSES}/{expense_draft['id']}", headers=theirs))
    assert gone(client.get(f"{ACCOUNTS}/{account['id']}", headers=theirs))
    assert gone(client.patch(f"{ACCOUNTS}/{account['id']}", json={"name": "Hijacked"}, headers=theirs))
    assert gone(client.delete(f"{ACCOUNTS}/{account['id']}", headers=theirs))
    assert client.get(f"{ENTRIES}/{entry['id']}", headers=theirs).json() == client.get(f"{ENTRIES}/{uuid.uuid4()}", headers=theirs).json()  # the same 404 body: no clue that it exists
    assert beta.entries()["total"] == 0 and client.get(EXPENSES, headers=theirs).json()["total"] == 0
    assert account["id"] not in [a["id"] for a in beta.accounts()]
    assert alpha.client.get(f"{ENTRIES}/{entry['id']}", headers=alpha.headers).json()["status"] == "posted"  # and nothing of Alpha's changed


def test_the_overview_and_numbering_are_per_organization(two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    alpha.balanced(amount="500")
    alpha.balanced(amount="500")
    assert beta.balanced(amount="1")["entry_number"] == "JE-000001"  # Beta's numbering starts at one
    overview = beta.get(f"{PREFIX}/overview").json()
    assert overview["posted_entries"] == 1 and overview["totals_by_currency"][0]["assets"] == "1.0000"
    assert alpha.get(f"{PREFIX}/overview").json()["totals_by_currency"][0]["assets"] == "1000.0000"


def test_the_organization_is_never_taken_from_the_request(client, two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    alpha.balanced()
    spoofed = {**beta.headers, "X-Organization-Id": two_orgs["alpha_id"], "X-Tenant-Id": two_orgs["alpha_id"]}
    assert client.get(ENTRIES, headers=spoofed, params={"organization_id": two_orgs["alpha_id"]}).json()["total"] == 0
    for path in (ENTRIES, EXPENSES, ACCOUNTS):
        refused = client.post(path, headers={**beta.headers, "Idempotency-Key": "spoof-key-0001"}, json={"organization_id": two_orgs["alpha_id"]})
        assert refused.status_code == 422, path


def test_an_idempotency_key_cannot_replay_another_organizations_entry(client, two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    alpha.entry([], key="same-key-00001", description="Alpha's")
    mine = beta.entry([], key="same-key-00001", description="Beta's")
    assert mine["description"] == "Beta's"


def test_concurrent_organizations_do_not_share_activation(two_orgs, session_factory):
    from sqlalchemy import text

    two_orgs["alpha"].accounts(), two_orgs["beta"].accounts()
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM finance_organizations")).scalar() == 2
        assert db.execute(text("SELECT count(DISTINCT organization_id) FROM accounts")).scalar() == 2
        assert db.execute(text("SELECT count(*) FROM accounts")).scalar() == 2 * 14
