"""Who may use the Support Service, two organizations apart, forged identity, deactivation and onboarding."""
import uuid

import pytest
from sqlalchemy import select

from app.models import SupportMessage, SupportTicket

from conftest import ADMIN, TICKETS, Api, bearer


def count(session_factory, model):
    with session_factory() as db:
        return len(db.scalars(select(model)).all())


# =====================================================================================================
# two organizations
# =====================================================================================================
def test_each_organization_sees_only_its_own_tickets(world):
    a, b = world["alpha"].ticket(subject="Alpha ticket"), world["beta"].ticket(subject="Beta ticket")
    mine = world["alpha"].mine().json()
    assert [i["id"] for i in mine["items"]] == [a["id"]] and mine["total"] == 1 and mine["counts"]["open"] == 1
    theirs = world["beta"].mine().json()
    assert [i["id"] for i in theirs["items"]] == [b["id"]]
    assert "Beta Logistics" not in str(mine) and "Alpha Trading" not in str(theirs)
    assert world["alpha"].client.get("/api/v1/support/summary", headers=world["alpha"].headers).json()["total"] == 1


def test_another_organizations_ticket_is_indistinguishable_from_a_missing_one(world):
    theirs = world["beta"].ticket()
    missing = str(uuid.uuid4())
    for call in (
        lambda t: world["alpha"].read(t), lambda t: world["alpha"].follow_up(t),
    ):
        foreign, absent = call(theirs["id"]), call(missing)
        assert foreign.status_code == absent.status_code == 404 and foreign.json() == absent.json()
        assert "Beta" not in foreign.text


def test_nothing_of_the_other_organization_changes(world, session_factory):
    theirs = world["beta"].ticket()
    before = world["root"].open_admin(theirs["id"]).json()
    attempts = [
        world["alpha"].follow_up(theirs["id"], "HIJACK"),
        world["alpha"].client.patch(f"{TICKETS}/{theirs['id']}", json={"status": "closed"}, headers=world["alpha"].headers),
        world["alpha"].client.delete(f"{TICKETS}/{theirs['id']}", headers=world["alpha"].headers),
    ]
    assert [a.status_code for a in attempts] == [404, 405, 405]
    after = world["root"].open_admin(theirs["id"]).json()
    assert after["messages"] == before["messages"] and after["status"] == before["status"] and count(session_factory, SupportMessage) == 1


def test_a_forged_organization_never_widens_what_a_tenant_can_see(world):
    world["beta"].ticket(subject="Beta secret")
    forged = world["alpha"].client.get(TICKETS, params={"organization_id": world["beta_id"]}, headers={**world["alpha"].headers, "X-Organization-Id": world["beta_id"], "X-Role": "super-admin"})
    assert forged.status_code == 200 and forged.json()["total"] == 0 and "Beta secret" not in forged.text
    admin_params = world["alpha"].client.get(TICKETS, params={"organization_id": world["beta_id"], "priority": "normal"}, headers=world["alpha"].headers)
    assert admin_params.json()["total"] == 0


def test_the_role_comes_from_the_auth_service_never_from_a_header(world):
    world["alpha"].ticket()
    response = world["alpha"].client.get(f"{ADMIN}/tickets", headers={**world["alpha"].headers, "X-Role": "super-admin", "X-Internal-Key": "x"})
    assert response.status_code == 403


# =====================================================================================================
# platform access
# =====================================================================================================
TENANT_ROUTES = [("get", TICKETS), ("post", TICKETS), ("get", f"{TICKETS}/{{id}}"), ("post", f"{TICKETS}/{{id}}/messages"), ("get", "/api/v1/support/summary")]
ADMIN_ROUTES = [("get", f"{ADMIN}/tickets"), ("get", f"{ADMIN}/tickets/{{id}}"), ("post", f"{ADMIN}/tickets/{{id}}/messages"), ("patch", f"{ADMIN}/tickets/{{id}}"),
                ("get", f"{ADMIN}/summary"), ("get", f"{ADMIN}/notifications"), ("post", f"{ADMIN}/notifications/{{id}}/retry")]
BODIES = {"post": {"subject": "Hello there", "category": "general_inquiry", "message": "hi", "body": "hi"}, "patch": {"status": "closed"}}


def call(world, who, method, url, ticket_id, **kw):
    headers = {**(bearer(who) if who else {}), "Idempotency-Key": f"key-{uuid.uuid4()}"}
    body = BODIES.get(method)
    if body is not None and "/messages" in url:
        body = {"body": "hi"}
    elif body is not None and method == "post" and url.endswith("/retry"):
        body = None
    return world["alpha"].client.request(method, url.format(id=ticket_id), json=body, headers=headers)


@pytest.mark.parametrize("method, url", ADMIN_ROUTES)
def test_the_platform_inbox_is_for_super_admins_only(world, method, url):
    ticket = world["alpha"].ticket()
    directory = world["directory"]
    directory.add_user("plain", "user", None)
    directory.add_user("orphan", "organization-admin", None)
    assert call(world, None, method, url, ticket["id"]).status_code == 401
    assert call(world, "nonsense", method, url, ticket["id"]).status_code == 401
    for who in ("alpha", "alpha2", "beta", "plain", "orphan"):
        assert call(world, who, method, url, ticket["id"]).status_code == 403, who
    assert call(world, "root", method, url, ticket["id"]).status_code in (200, 201, 404, 422)  # (a real Super Admin gets through the gate)


@pytest.mark.parametrize("method, url", TENANT_ROUTES)
def test_a_super_admin_is_not_a_tenant_and_the_tenant_routes_need_an_organization_administrator(world, method, url):
    ticket = world["alpha"].ticket()
    directory = world["directory"]
    directory.add_user("plain", "user", None)
    directory.add_user("orphan", "organization-admin", None)
    directory.add_user("super-with-org", "super-admin", world["alpha_id"])
    assert call(world, None, method, url, ticket["id"]).status_code == 401
    for who in ("root", "super-with-org", "plain", "orphan"):
        assert call(world, who, method, url, ticket["id"]).status_code == 403, who


def test_there_is_no_way_to_delete_anything(world):
    ticket = world["alpha"].ticket()
    for url in (f"{TICKETS}/{ticket['id']}", f"{ADMIN}/tickets/{ticket['id']}", TICKETS, f"{TICKETS}/{ticket['id']}/messages"):
        for who in ("alpha", "root"):
            assert world["alpha"].client.delete(url, headers=bearer(who)).status_code in (404, 405)
    assert not any("delete" in operation for path in world["alpha"].client.get("/openapi.json").json()["paths"].values() for operation in path)


def test_the_endpoints_declare_no_organization_or_identity_input(world):
    spec = world["alpha"].client.get("/openapi.json").json()
    for path, operations in spec["paths"].items():
        if "/admin/" in path or not path.startswith("/api/v1/support/tickets"):
            continue
        for operation in operations.values():
            assert not {p["name"] for p in operation.get("parameters", [])} & {"organization_id", "org_id", "user_id", "sender_role", "recipient"}, path
    for schema in ("TicketCreate", "MessageCreate"):
        text = str(spec["components"]["schemas"][schema])
        assert "organization_id" not in text and "recipient" not in text and "sender_role" not in text


# =====================================================================================================
# deactivation, outages
# =====================================================================================================
def test_a_deactivated_administrator_loses_access_but_their_tickets_stay(world, session_factory):
    ticket = world["alpha"].ticket()
    world["directory"].users["alpha"]["is_active"] = False
    assert world["alpha"].read(ticket["id"]).status_code == 401
    assert world["alpha"].open().status_code == 401
    assert world["alpha"].follow_up(ticket["id"]).status_code == 401
    assert world["alpha2"].read(ticket["id"]).status_code == 200  # a colleague in the same organization still sees the history
    assert count(session_factory, SupportTicket) == 1 and world["root"].open_admin(ticket["id"]).json()["requester_name"] == "Alice Alpha"


def test_a_deactivated_organization_cannot_use_support(world, session_factory):
    ticket = world["alpha"].ticket()
    world["directory"].organizations[world["alpha_id"]]["is_active"] = False
    for response in (world["alpha"].read(ticket["id"]), world["alpha"].open(), world["alpha"].follow_up(ticket["id"]), world["alpha"].mine()):
        assert response.status_code == 403
    assert world["beta"].open().status_code == 201  # nobody else is affected
    assert world["root"].open_admin(ticket["id"]).status_code == 200  # and the platform still sees it
    assert count(session_factory, SupportTicket) == 2


def test_a_deactivated_super_admin_is_refused(world):
    ticket = world["alpha"].ticket()
    world["directory"].users["root"]["is_active"] = False
    assert world["root"].inbox().status_code == 401 and world["root"].open_admin(ticket["id"]).status_code == 401


def test_a_dependency_outage_is_a_recoverable_503_and_stores_nothing(world, session_factory):
    world["directory"].auth_down = True
    assert world["alpha"].open().status_code == 503 and world["root"].inbox().status_code == 503
    world["directory"].auth_down = False
    world["directory"].org_down = True
    assert world["alpha"].open().status_code == 503
    assert world["root"].inbox().status_code == 200  # the platform inbox does not depend on the Organization Service
    world["directory"].org_down = False
    assert count(session_factory, SupportTicket) == 0
    assert world["alpha"].open().status_code == 201


def test_an_expired_or_missing_token_is_401(world):
    assert world["alpha"].client.get(TICKETS).status_code == 401
    assert world["alpha"].client.get(TICKETS, headers={"Authorization": "Bearer expired"}).status_code == 401


# =====================================================================================================
# onboarding
# =====================================================================================================
def test_support_works_while_first_time_setup_is_incomplete(world, directory):
    pending = directory.add_organization("Brand New Co", setup_status="pending")
    directory.add_user("newbie", "organization-admin", pending, full_name="Nina Newcomer", email="nina@new.example")
    newbie = Api(world["alpha"].client, "newbie")
    ticket = newbie.ticket(subject="I cannot upload my logo", category="technical_issue", message="The upload says the file is invalid.")
    assert ticket["organization_name"] == "Brand New Co"
    assert newbie.mine().json()["total"] == 1
    reply = world["root"].reply(ticket["id"], body="Please try a PNG under 2 MB.")
    assert reply.status_code == 201
    assert newbie.read(ticket["id"]).json()["messages"][-1]["body"].startswith("Please try a PNG")
    assert newbie.follow_up(ticket["id"], "That worked, thanks.").status_code == 201
    in_progress = directory.add_organization("Half Way Co", setup_status="in_progress")
    directory.add_user("half", "organization-admin", in_progress)
    assert Api(world["alpha"].client, "half").open().status_code == 201
