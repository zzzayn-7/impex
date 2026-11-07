"""First-time setup is mandatory before business activity, enforced by the Sales Service itself (Step 20).

Hiding screens and gating the portal's routes is not enough: an authenticated administrator must not be able to run ordinary business operations by
calling this service directly before their organization (and their own profile) is set up. The Organization Service's record (`setup_status`) and
the Auth Service's record (`profile_setup_completed_at`) decide; a missing field counts as "not done", never "done".
"""
import re
import uuid

import pytest

from app.main import app
from conftest import bearer

PREFIX = "/api/v1/sales"
LIST = "/clients"
USAGE = "/internal/v1/organizations/{}/module-usage"


def refused(response):
    assert response.status_code == 403, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "setup_required" and "first-time setup" in detail["message"]


def tenant_routes():
    """Every public route of the service, from its own OpenAPI document (so a route added later is covered automatically)."""
    routes = []
    for path, operations in app.openapi()["paths"].items():
        if path.startswith(PREFIX) and not path.endswith("/health"):
            for method, operation in operations.items():
                routes.append((method.upper(), path, operation["operationId"]))
    return routes


@pytest.mark.parametrize("method,path,name", tenant_routes(), ids=lambda v: v if isinstance(v, str) else None)
@pytest.mark.parametrize("setup", ["pending", "in_progress"])
def test_every_route_refuses_an_organization_that_is_not_set_up(client, directory, two_orgs, method, path, name, setup):
    directory.organizations[two_orgs["alpha_id"]]["setup_status"] = setup
    url = re.sub(r"\{[^}]+\}", str(uuid.uuid4()), path)
    refused(client.request(method, url, headers=two_orgs["alpha"].headers, json={}))  # (the "finish what was started" routes too: nothing can be in flight)


@pytest.mark.parametrize("method,path,name", tenant_routes(), ids=lambda v: v if isinstance(v, str) else None)
def test_every_route_refuses_an_administrator_whose_profile_is_not_confirmed(client, directory, two_orgs, method, path, name):
    directory.users["admin-alpha"]["profile_setup_completed_at"] = None
    url = re.sub(r"\{[^}]+\}", str(uuid.uuid4()), path)
    refused(client.request(method, url, headers=two_orgs["alpha"].headers, json={}))


def test_a_configured_organization_and_administrator_are_served(client, two_orgs):
    assert client.get(PREFIX + LIST, headers=two_orgs["alpha"].headers).status_code == 200


def test_a_missing_setup_status_is_not_read_as_complete(client, directory, two_orgs):
    directory.org_mode = "no-setup-status"
    refused(client.get(PREFIX + LIST, headers=two_orgs["alpha"].headers))
    refused(client.post(PREFIX + LIST, json={"name": "Sneaky"}, headers=two_orgs["alpha"].headers))


def test_a_missing_or_odd_profile_confirmation_is_not_read_as_confirmed(client, directory, two_orgs):
    for value in (None, "", 0, False):
        directory.users["admin-alpha"]["profile_setup_completed_at"] = value
        refused(client.get(PREFIX + LIST, headers=two_orgs["alpha"].headers))
    del directory.users["admin-alpha"]["profile_setup_completed_at"]
    refused(client.get(PREFIX + LIST, headers=two_orgs["alpha"].headers))


def test_setup_is_checked_before_the_module(client, directory, two_orgs):
    directory.organizations[two_orgs["alpha_id"]]["setup_status"] = "pending"
    directory.organizations[two_orgs["alpha_id"]]["modules"] = []
    refused(client.get(PREFIX + LIST, headers=two_orgs["alpha"].headers))


def test_nothing_the_browser_sends_can_skip_it(client, directory, two_orgs):
    directory.organizations[two_orgs["alpha_id"]]["setup_status"] = "pending"
    tricks = {"X-Setup-Status": "completed", "X-Setup-Complete": "true", "X-Organization-Id": two_orgs["beta_id"], "X-Profile-Confirmed": "true"}
    refused(client.get(f"{PREFIX}{LIST}?setup_status=completed&organization_id={two_orgs['beta_id']}", headers={**two_orgs["alpha"].headers, **tricks}))
    refused(client.post(PREFIX + LIST, json={"name": "Sneaky", "setup_status": "completed", "profile_setup_completed_at": "2026-01-01T00:00:00Z"}, headers={**two_orgs["alpha"].headers, **tricks}))


def test_completing_setup_opens_the_service_on_the_very_next_request(client, directory, two_orgs):
    org, user = two_orgs["alpha_id"], directory.users["admin-alpha"]
    confirmed = user["profile_setup_completed_at"]
    for _ in range(2):
        directory.organizations[org]["setup_status"] = "in_progress"
        refused(client.get(PREFIX + LIST, headers=two_orgs["alpha"].headers))
        directory.organizations[org]["setup_status"] = "completed"
        user["profile_setup_completed_at"] = None
        refused(client.get(PREFIX + LIST, headers=two_orgs["alpha"].headers))
        user["profile_setup_completed_at"] = confirmed
        assert client.get(PREFIX + LIST, headers=two_orgs["alpha"].headers).status_code == 200


def test_each_organization_is_judged_by_its_own_setup(client, directory, two_orgs):
    directory.organizations[two_orgs["alpha_id"]]["setup_status"] = "pending"
    refused(client.get(PREFIX + LIST, headers=two_orgs["alpha"].headers))
    assert client.get(PREFIX + LIST, headers=two_orgs["beta"].headers).status_code == 200


def test_an_inactive_organization_is_still_the_plain_inactive_refusal(client, directory, two_orgs):
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = False
    directory.organizations[two_orgs["alpha_id"]]["setup_status"] = "pending"
    response = client.get(PREFIX + LIST, headers=two_orgs["alpha"].headers)
    assert response.status_code == 403 and "not active" in str(response.json()["detail"])


def test_super_admins_still_never_pass(client, directory):
    directory.add_user("root", "super-admin")
    assert client.get(PREFIX + LIST, headers=bearer("root")).status_code == 403
