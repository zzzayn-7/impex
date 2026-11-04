"""Goods receipts: two organizations never see or change each other's receipts, nothing is decided by the browser, and who may use them."""
import uuid

import pytest
from sqlalchemy import text

from conftest import RECEIPTS, bearer, received


@pytest.fixture
def world(two_orgs, inventory):
    """Each organization: a product with the SAME SKU, a warehouse, a placed order for 10, a DRAFT receipt and a CONFIRMED one."""
    data = {}
    for who in ("alpha", "beta"):
        org = two_orgs[who]
        product = inventory.add_product(org.org_id, "SHARED-SKU", f"{who} gadget", "pcs")
        warehouse = inventory.add_warehouse(org.org_id, "MAIN")
        order = org.ordered({"gadget": product}, lines=(("gadget", 10),))
        confirmed = org.draft(order["id"], [received(order, product, 3, warehouse)])
        assert org.confirm(confirmed["id"]).status_code == 200
        draft = org.draft(order["id"], [received(order, product, 2, warehouse)])
        data[who] = {"product": product, "warehouse": warehouse, "order": order, "confirmed": confirmed, "draft": draft}
    return data


def snapshot(session_factory):
    with session_factory() as db:
        receipts = db.execute(text("SELECT id, organization_id, number, status, notes, received_date FROM goods_receipts ORDER BY id")).all()
        lines = db.execute(text("SELECT id, organization_id, goods_receipt_id, accepted_quantity, rejected_quantity, warehouse_id FROM goods_receipt_lines ORDER BY id")).all()
        orders = db.execute(text("SELECT id, status FROM purchase_orders ORDER BY id")).all()
    return [tuple(r) for r in receipts], [tuple(l) for l in lines], [tuple(o) for o in orders]


def test_each_administrator_sees_only_their_own_receipts(two_orgs, world):
    for who, other in (("alpha", "beta"), ("beta", "alpha")):
        org = two_orgs[who]
        listed = org.client.get(RECEIPTS, headers=org.headers).json()
        assert {i["id"] for i in listed["items"]} == {world[who]["confirmed"]["id"], world[who]["draft"]["id"]} and listed["total"] == 2
        assert other not in str(listed).lower()
        order = org.detail(world[who]["order"]["id"])
        assert {r["id"] for r in order["receipts"]} == {world[who]["confirmed"]["id"], world[who]["draft"]["id"]}


def test_searching_and_filtering_cannot_reach_the_other_organization(two_orgs, world):
    alpha, theirs = two_orgs["alpha"], world["beta"]
    for params in (
        {"purchase_order_id": theirs["order"]["id"]}, {"supplier_id": theirs["order"]["supplier"]["id"]},
        {"warehouse_id": theirs["warehouse"]}, {"product_id": theirs["product"]}, {"q": "beta"},
    ):
        assert alpha.client.get(RECEIPTS, params=params, headers=alpha.headers).json()["total"] == 0, params


def test_another_organizations_receipt_is_indistinguishable_from_a_missing_one(two_orgs, world):
    alpha, theirs = two_orgs["alpha"], world["beta"]
    for receipt in (theirs["confirmed"], theirs["draft"]):
        for method, suffix, body in (
            ("get", "", None), ("patch", "", {"notes": "x"}), ("put", "/lines", {"lines": []}), ("post", "/confirm", None), ("post", "/cancel", None),
        ):
            foreign = alpha.client.request(method, f"{RECEIPTS}/{receipt['id']}{suffix}", json=body, headers=alpha.headers)
            missing = alpha.client.request(method, f"{RECEIPTS}/{uuid.uuid4()}{suffix}", json=body, headers=alpha.headers)
            assert foreign.status_code == missing.status_code == 404 and foreign.json() == missing.json(), (method, suffix)
            assert "beta" not in foreign.text.lower()


def test_a_receipt_cannot_be_started_against_another_organizations_order(two_orgs, world, inventory):
    alpha, theirs = two_orgs["alpha"], world["beta"]
    mine = alpha.draft(world["alpha"]["order"]["id"], [])
    foreign = alpha.receipt(theirs["order"]["id"], [])
    missing = alpha.receipt(str(uuid.uuid4()), [])
    assert foreign.status_code == missing.status_code == 404 and foreign.json() == missing.json()
    assert mine["purchase_order"]["number"] == "PO-000001"


def test_another_organizations_lines_warehouses_and_products_are_not_found(two_orgs, world):
    alpha, mine, theirs = two_orgs["alpha"], world["alpha"], world["beta"]
    their_line = received(theirs["order"], theirs["product"], 1, mine["warehouse"])
    stolen_line = alpha.receipt(mine["order"]["id"], [their_line])
    ghost_line = alpha.receipt(mine["order"]["id"], [{**their_line, "purchase_order_line_id": str(uuid.uuid4())}])
    assert stolen_line.status_code == ghost_line.status_code == 404 and stolen_line.json() == ghost_line.json()
    stolen_warehouse = alpha.receipt(mine["order"]["id"], [received(mine["order"], mine["product"], 1, theirs["warehouse"])])
    ghost_warehouse = alpha.receipt(mine["order"]["id"], [received(mine["order"], mine["product"], 1, str(uuid.uuid4()))])
    assert stolen_warehouse.status_code == ghost_warehouse.status_code == 404 and stolen_warehouse.json() == ghost_warehouse.json()


@pytest.mark.parametrize("attacker,victim", [("alpha", "beta"), ("beta", "alpha")])
def test_nothing_of_the_other_organization_changes(two_orgs, world, session_factory, inventory, attacker, victim):
    before, stock_before = snapshot(session_factory), inventory.snapshot()
    org, theirs = two_orgs[attacker], world[victim]
    attempts = []
    for receipt in (theirs["confirmed"], theirs["draft"]):
        base = f"{RECEIPTS}/{receipt['id']}"
        attempts += [
            org.client.patch(base, json={"notes": "HIJACKED"}, headers=org.headers),
            org.client.put(f"{base}/lines", json={"lines": []}, headers=org.headers),
            org.client.post(f"{base}/confirm", headers=org.headers),
            org.client.post(f"{base}/cancel", headers=org.headers),
        ]
    attempts.append(org.receipt(theirs["order"]["id"], []))
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
    forged = {"purchase_order_id": world["alpha"]["order"]["id"], "organization_id": two_orgs["beta_id"]}
    assert alpha.client.post(RECEIPTS, json=forged, headers={**alpha.headers, "Idempotency-Key": "forged-key-0001"}).status_code == 422
    assert alpha.client.get(RECEIPTS, params={"organization_id": two_orgs["beta_id"]}, headers=alpha.headers).json()["total"] == 2  # ignored: still only alpha's
    assert alpha.client.patch(f"{RECEIPTS}/{world['alpha']['draft']['id']}", json={"organization_id": two_orgs["beta_id"]}, headers=alpha.headers).status_code == 422


def test_the_same_idempotency_key_in_two_organizations_is_independent(two_orgs, world):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    a = alpha.receipt(world["alpha"]["order"]["id"], [], key="shared-key-0001")
    b = beta.receipt(world["beta"]["order"]["id"], [], key="shared-key-0001")
    assert (a.status_code, b.status_code) == (201, 201) and a.json()["id"] != b.json()["id"]


def test_every_receipt_route_needs_an_active_organization_administrator(client, directory, world, two_orgs):
    receipt = world["alpha"]["draft"]["id"]
    routes = [("get", RECEIPTS), ("get", f"{RECEIPTS}/{receipt}"), ("post", RECEIPTS), ("patch", f"{RECEIPTS}/{receipt}"),
              ("put", f"{RECEIPTS}/{receipt}/lines"), ("post", f"{RECEIPTS}/{receipt}/confirm"), ("post", f"{RECEIPTS}/{receipt}/cancel")]
    directory.add_user("super", "super-admin")
    inactive = directory.add_organization("Dormant", active=False)
    directory.add_user("dormant-admin", "organization-admin", inactive)
    for method, url in routes:
        assert client.request(method, url, json={}).status_code == 401, url
        assert client.request(method, url, json={}, headers=bearer("nobody")).status_code == 401, url
        assert client.request(method, url, json={}, headers=bearer("super")).status_code == 403, url
        assert client.request(method, url, json={}, headers=bearer("dormant-admin")).status_code == 403, url


def test_a_deactivated_organization_cannot_confirm_a_receipt(two_orgs, world, directory, inventory):
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = False
    alpha = two_orgs["alpha"]
    before = len(inventory.postings())
    assert alpha.confirm(world["alpha"]["draft"]["id"]).status_code == 403
    assert len(inventory.postings()) == before
