"""Help & Support can ASK for a module (a Change Request ticket) but can never GRANT one.

Module entitlements belong to the Organization Service and change only through a Super Admin's confirmed action there (see
docs/modules.md). This service therefore has no code path that writes to the Organization Service at all, and it is never itself gated by a
module: Help & Support is a permanent platform capability.
"""
import re
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"


def sources():
    return {path.name: path.read_text(encoding="utf-8") for path in APP.glob("*.py")}


def test_the_service_never_mentions_module_entitlements():
    for name, text in sources().items():
        assert "organization_modules" not in text, name
        assert not re.search(r"/modules\b", text), name
        assert "module_disabled" not in text, name  # it is not gated by modules either


def test_it_only_ever_reads_from_the_other_services():
    """The only requests this service makes to the Auth and Organization services are reads (who is calling, is the organization active)."""
    for name, text in sources().items():
        assert not re.search(r"(?:client|_client|org_client|auth_client)\.(?:post|put|patch|delete)\(", text), name


def test_a_change_request_ticket_changes_no_other_data(world):
    """Opening a ticket in the Change Request category (what a module request is) makes no write to any other service."""
    directory = world["directory"]
    directory.requests.clear()
    response = world["alpha"].open(subject="Request to activate the Sales module", category="change_request", message="Please enable Sales for our organization.")
    assert response.status_code == 201
    assert response.json()["category"] == "change_request" and response.json()["status"] == "open"
    assert directory.requests, "the identity checks were made"
    assert {method for _service, method, _path in directory.requests} == {"GET"}
    assert not any("modules" in path for _service, _method, path in directory.requests)


def test_help_and_support_works_whatever_modules_the_organization_has(world):
    """Support is permanent: an organization with NO module enabled (or no list at all) can still write to the Impex team and read the answer."""
    directory = world["directory"]
    directory.organizations[world["alpha_id"]]["modules"] = []
    opened = world["alpha"].open(subject="We lost access to everything", message="Please call us.")
    assert opened.status_code == 201
    assert world["alpha"].client.get("/api/v1/support/tickets", headers=world["alpha"].headers).status_code == 200
    assert world["root"].reply(opened.json()["id"], "We are looking at it.").status_code == 201
    assert world["alpha"].client.get(f"/api/v1/support/tickets/{opened.json()['id']}", headers=world["alpha"].headers).json()["messages"][-1]["body"] == "We are looking at it."
