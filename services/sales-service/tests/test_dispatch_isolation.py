"""Dispatches: two organizations never see or change each other's dispatches, nothing is decided by the browser, and who may use them."""
import uuid

import pytest
from sqlalchemy import text

from conftest import DISPATCHES, bearer, sent


@pytest.fixture
def world(two_orgs, inventory):
    """Each organization: a product with the SAME SKU, a warehouse with stock, a Ready list for 10, a CONFIRMED dispatch and a DRAFT one."""
    data = {}
    for who in ("alpha", "beta"):
        org = two_orgs[who]
        product = inventory.add_product(org.org_id, "SHARED-SKU", f"{who} gadget", "pcs")
        warehouse = inventory.add_warehouse(org.org_id, "MAIN")
        inventory.set_stock(product, warehouse, 100)
        delivery_list = org.ready_list({"gadget": product}, items=(("gadget", 10),), client_name=f"{who} client")
        confirmed = org.draft(delivery_list["id"], [sent(delivery_list, product, 3, warehouse)])
        assert org.confirm(confirmed["id"]).status_code == 200
        draft = org.draft(delivery_list["id"], [sent(delivery_list, product, 2, warehouse)])
        data[who] = {"product": product, "warehouse": warehouse, "list": delivery_list, "confirmed": confirmed, "draft": draft}
    return data


def snapshot(session_factory):
    with session_factory() as db:
        dispatches = db.execute(text("SELECT id, organization_id, number, status, notes, dispatch_date FROM dispatches ORDER BY id")).all()
        lines = db.execute(text("SELECT id, organization_id, dispatch_id, quantity, warehouse_id FROM dispatch_lines ORDER BY id")).all()
        lists = db.execute(text("SELECT id, status FROM delivery_lists ORDER BY id")).all()
    return [tuple(r) for r in dispatches], [tuple(l) for l in lines], [tuple(l) for l in lists]


def test_each_administrator_sees_only_their_own_dispatches(two_orgs, world):
    for who, other in (("alpha", "beta"), ("beta", "alpha")):
        org = two_orgs[who]
        listed = org.client.get(DISPATCHES, headers=org.headers).json()
        assert {i["id"] for i in listed["items"]} == {world[who]["confirmed"]["id"], world[who]["draft"]["id"]} and listed["total"] == 2
        assert other not in str(listed).lower()
        delivery_list = org.detail(world[who]["list"]["id"])
        assert {r["id"] for r in delivery_list["dispatches"]} == {world[who]["confirmed"]["id"], world[who]["draft"]["id"]}


def test_searching_and_filtering_cannot_reach_the_other_organization(two_orgs, world):
    alpha, theirs = two_orgs["alpha"], world["beta"]
    for params in (
        {"delivery_list_id": theirs["list"]["id"]}, {"client_id": theirs["list"]["client"]["id"]}, {"warehouse_id": theirs["warehouse"]},
        {"product_id": theirs["product"]}, {"q": "beta"},
    ):
        assert alpha.client.get(DISPATCHES, params=params, headers=alpha.headers).json()["total"] == 0, params


def test_another_organizations_dispatch_is_indistinguishable_from_a_missing_one(two_orgs, world):
    alpha, theirs = two_orgs["alpha"], world["beta"]
    for dispatch in (theirs["confirmed"], theirs["draft"]):
        for method, suffix, body in (
            ("get", "", None), ("patch", "", {"notes": "x"}), ("put", "/lines", {"lines": []}), ("post", "/confirm", None), ("post", "/cancel", None),
        ):
            foreign = alpha.client.request(method, f"{DISPATCHES}/{dispatch['id']}{suffix}", json=body, headers=alpha.headers)
            missing = alpha.client.request(method, f"{DISPATCHES}/{uuid.uuid4()}{suffix}", json=body, headers=alpha.headers)
            assert foreign.status_code == missing.status_code == 404 and foreign.json() == missing.json(), (method, suffix)
            assert "beta" not in foreign.text.lower()


def test_a_dispatch_cannot_be_started_against_another_organizations_list(two_orgs, world):
    alpha, theirs = two_orgs["alpha"], world["beta"]
    foreign = alpha.dispatch_request(theirs["list"]["id"], [])
    missing = alpha.dispatch_request(str(uuid.uuid4()), [])
    assert foreign.status_code == missing.status_code == 404 and foreign.json() == missing.json()


def test_another_organizations_items_and_warehouses_are_not_found(two_orgs, world):
    alpha, mine, theirs = two_orgs["alpha"], world["alpha"], world["beta"]
    their_item = sent(theirs["list"], theirs["product"], 1, mine["warehouse"])
    stolen_item = alpha.dispatch_request(mine["list"]["id"], [their_item])
    ghost_item = alpha.dispatch_request(mine["list"]["id"], [{**their_item, "delivery_list_item_id": str(uuid.uuid4())}])
    assert stolen_item.status_code == ghost_item.status_code == 404 and stolen_item.json() == ghost_item.json()
    stolen_warehouse = alpha.dispatch_request(mine["list"]["id"], [sent(mine["list"], mine["product"], 1, theirs["warehouse"])])
    ghost_warehouse = alpha.dispatch_request(mine["list"]["id"], [sent(mine["list"], mine["product"], 1, str(uuid.uuid4()))])
    assert stolen_warehouse.status_code == ghost_warehouse.status_code == 404 and stolen_warehouse.json() == ghost_warehouse.json()


@pytest.mark.parametrize("attacker,victim", [("alpha", "beta"), ("beta", "alpha")])
def test_nothing_of_the_other_organization_changes(two_orgs, world, session_factory, inventory, attacker, victim):
    before, stock_before = snapshot(session_factory), inventory.snapshot()
    org, theirs = two_orgs[attacker], world[victim]
    attempts = []
    for dispatch in (theirs["confirmed"], theirs["draft"]):
        base = f"{DISPATCHES}/{dispatch['id']}"
        attempts += [
            org.client.patch(base, json={"notes": "HIJACKED"}, headers=org.headers),
            org.client.put(f"{base}/lines", json={"lines": []}, headers=org.headers),
            org.client.post(f"{base}/confirm", headers=org.headers),
            org.client.post(f"{base}/cancel", headers=org.headers),
        ]
    attempts.append(org.dispatch_request(theirs["list"]["id"], []))
    attempts.append(org.status(theirs["list"]["id"], "cancel"))
    assert {a.status_code for a in attempts} == {404}
    assert snapshot(session_factory) == before and inventory.snapshot() == stock_before


def test_each_organization_posts_with_its_own_token_only(two_orgs, world, inventory):
    assert {token for _, _, token in inventory.postings()} == {"admin-alpha", "admin-beta"}
    by_org = {}
    for entry in inventory.ledger:
        by_org.setdefault(entry["org"], set()).add(entry["product_id"])
    assert by_org == {two_orgs["alpha_id"]: {world["alpha"]["product"]}, two_orgs["beta_id"]: {world["beta"]["product"]}}


def test_the_organization_is_never_taken_from_the_request(two_orgs, world):
    alpha = two_orgs["alpha"]
    forged = {"delivery_list_id": world["alpha"]["list"]["id"], "organization_id": two_orgs["beta_id"]}
    assert alpha.client.post(DISPATCHES, json=forged, headers={**alpha.headers, "Idempotency-Key": "forged-key-0001"}).status_code == 422
    assert alpha.client.get(DISPATCHES, params={"organization_id": two_orgs["beta_id"]}, headers=alpha.headers).json()["total"] == 2
    assert alpha.client.patch(f"{DISPATCHES}/{world['alpha']['draft']['id']}", json={"organization_id": two_orgs["beta_id"]}, headers=alpha.headers).status_code == 422


def test_the_same_idempotency_key_in_two_organizations_is_independent(two_orgs, world):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    a = alpha.dispatch_request(world["alpha"]["list"]["id"], [], key="shared-key-0001")
    b = beta.dispatch_request(world["beta"]["list"]["id"], [], key="shared-key-0001")
    assert (a.status_code, b.status_code) == (201, 201) and a.json()["id"] != b.json()["id"]


def test_every_dispatch_route_needs_an_active_organization_administrator(client, directory, world, two_orgs):
    dispatch = world["alpha"]["draft"]["id"]
    routes = [("get", DISPATCHES), ("get", f"{DISPATCHES}/{dispatch}"), ("post", DISPATCHES), ("patch", f"{DISPATCHES}/{dispatch}"),
              ("put", f"{DISPATCHES}/{dispatch}/lines"), ("post", f"{DISPATCHES}/{dispatch}/confirm"), ("post", f"{DISPATCHES}/{dispatch}/cancel")]
    directory.add_user("super", "super-admin")
    inactive = directory.add_organization("Dormant", active=False)
    directory.add_user("dormant-admin", "organization-admin", inactive)
    for method, url in routes:
        assert client.request(method, url, json={}).status_code == 401, url
        assert client.request(method, url, json={}, headers=bearer("nobody")).status_code == 401, url
        assert client.request(method, url, json={}, headers=bearer("super")).status_code == 403, url
        assert client.request(method, url, json={}, headers=bearer("dormant-admin")).status_code == 403, url


def test_a_deactivated_organization_cannot_confirm_a_dispatch(two_orgs, world, directory, inventory):
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = False
    before = len(inventory.postings())
    assert two_orgs["alpha"].confirm(world["alpha"]["draft"]["id"]).status_code == 403
    assert len(inventory.postings()) == before


def test_the_database_refuses_a_dispatch_that_points_at_another_organizations_list_or_client(two_orgs, world, session_factory):
    mine, theirs = world["alpha"], world["beta"]
    insert = ("INSERT INTO dispatches (id, organization_id, delivery_list_id, client_id, number, dispatch_date, posting_key, created_by, created_by_email) "
              "VALUES (:id, :o, :dl, :c, 'DS-777777', current_date, 'dispatch-' || CAST(:id AS text), :u, 'a@b.c')")
    from sqlalchemy.exc import DBAPIError

    for dl, c in ((theirs["list"]["id"], mine["list"]["client"]["id"]), (mine["list"]["id"], theirs["list"]["client"]["id"])):
        with pytest.raises(DBAPIError):
            with session_factory() as db:
                db.execute(text(insert), {"id": uuid.uuid4(), "o": uuid.UUID(two_orgs["alpha_id"]), "dl": uuid.UUID(dl), "c": uuid.UUID(c), "u": uuid.uuid4()})
                db.commit()
