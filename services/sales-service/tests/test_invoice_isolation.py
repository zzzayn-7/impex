"""Invoices and payments: two organizations never see or change each other's, nothing is decided by the browser, and who may use them."""
import uuid

import pytest
from sqlalchemy import text

from conftest import INVOICES, bearer, bill

ACCOUNT = "/api/v1/sales/clients/{}/account"
BILLABLE = "/api/v1/sales/billable-lines"


@pytest.fixture
def world(two_orgs, inventory):
    """Each organization: a product with the SAME SKU, a Ready list for 10 bought by its client, ONE confirmed dispatch of all 10, a DRAFT
    invoice for 3, and an ISSUED invoice for 4 (price 2 -> 8.00) with a payment of 1.00 on it."""
    data = {}
    for who in ("alpha", "beta"):
        org = two_orgs[who]
        product = inventory.add_product(org.org_id, "SHARED-SKU", f"{who} gadget", "pcs")
        warehouse = inventory.add_warehouse(org.org_id, "MAIN")
        inventory.set_stock(product, warehouse, 100)
        shop = {"gadget": product, "main": warehouse}
        delivery_list = org.ready_list(shop, items=(("gadget", 10),), client_name=f"{who} client")
        dispatch = org.confirmed_dispatch(shop, delivery_list, [("gadget", 10, "main")])
        client_id = delivery_list["client"]["id"]
        draft = org.draft_invoice(client_id, [bill(dispatch, product, 3, "2")])
        issued = org.issued_invoice(client_id, [bill(dispatch, product, 4, "2")])
        paid = org.pay(issued["id"], "1")
        assert paid.status_code == 201
        data[who] = {"product": product, "list": delivery_list, "dispatch": dispatch, "client": client_id, "draft": draft, "issued": paid.json(), "payment": paid.json()["payments"][0]}
    return data


def snapshot(session_factory):
    with session_factory() as db:
        invoices = db.execute(text("SELECT id, organization_id, number, status, total, paid_total, notes, due_date FROM invoices ORDER BY id")).all()
        lines = db.execute(text("SELECT id, organization_id, quantity, unit_price FROM invoice_lines ORDER BY id")).all()
        payments = db.execute(text("SELECT id, organization_id, kind, amount FROM invoice_payments ORDER BY id")).all()
        counters = db.execute(text("SELECT organization_id, last_number FROM invoice_counters ORDER BY organization_id")).all()
    return [[tuple(r) for r in rows] for rows in (invoices, lines, payments, counters)]


def test_each_administrator_sees_only_their_own_invoices(two_orgs, world):
    for who, other in (("alpha", "beta"), ("beta", "alpha")):
        org = two_orgs[who]
        listed = org.client.get(INVOICES, headers=org.headers).json()
        assert {i["id"] for i in listed["items"]} == {world[who]["draft"]["id"], world[who]["issued"]["id"]} and listed["total"] == 2
        assert other not in str(listed).lower()
        account = org.client.get(ACCOUNT.format(world[who]["client"]), headers=org.headers).json()
        assert {i["id"] for i in account["invoices"]} == {world[who]["draft"]["id"], world[who]["issued"]["id"]}
        assert [p["id"] for p in account["payments"]] == [world[who]["payment"]["id"]]
        lines = org.client.get(BILLABLE, params={"client_id": world[who]["client"]}, headers=org.headers).json()
        assert [l["dispatch_line_id"] for l in lines] == [world[who]["dispatch"]["lines"][0]["id"]]


def test_each_organization_numbers_its_own_invoices(two_orgs, world):
    assert world["alpha"]["issued"]["number"] == world["beta"]["issued"]["number"] == "INV-000001"
    for who in ("alpha", "beta"):
        org = two_orgs[who]
        again = org.issued_invoice(world[who]["client"], [bill(world[who]["dispatch"], world[who]["product"], 2, "1")])
        assert again["number"] == "INV-000002"


def test_searching_and_filtering_cannot_reach_the_other_organization(two_orgs, world):
    alpha, theirs = two_orgs["alpha"], world["beta"]
    for params in ({"client_id": theirs["client"]}, {"q": "beta"}, {"q": theirs["issued"]["client_name"]}, {"status": "issued", "client_id": theirs["client"]}):
        assert alpha.client.get(INVOICES, params=params, headers=alpha.headers).json()["total"] == 0, params
    own = alpha.client.get(INVOICES, params={"q": "INV-000001"}, headers=alpha.headers).json()
    assert [i["id"] for i in own["items"]] == [world["alpha"]["issued"]["id"]]


def test_another_organizations_invoice_is_indistinguishable_from_a_missing_one(two_orgs, world):
    alpha, theirs = two_orgs["alpha"], world["beta"]
    reason = {"reason": "x"}
    for invoice in (theirs["draft"], theirs["issued"]):
        for method, suffix, body, headers in (
            ("get", "", None, {}), ("get", "/pdf", None, {}), ("patch", "", {"notes": "x"}, {}), ("put", "/lines", {"lines": []}, {}), ("post", "/issue", None, {}),
            ("post", "/void", reason, {}), ("post", "/payments", {"amount": "1", "method": "cash"}, {"Idempotency-Key": "probe-key-0001"}),
            ("post", f"/payments/{theirs['payment']['id']}/reverse", reason, {"Idempotency-Key": "probe-key-0002"}),
        ):
            foreign = alpha.client.request(method, f"{INVOICES}/{invoice['id']}{suffix}", json=body, headers={**alpha.headers, **headers})
            missing = alpha.client.request(method, f"{INVOICES}/{uuid.uuid4()}{suffix}", json=body, headers={**alpha.headers, **headers})
            assert foreign.status_code == missing.status_code == 404, (method, suffix, foreign.text)
            assert foreign.json() == missing.json() and "beta" not in foreign.text.lower()


def test_another_organizations_client_is_not_found(two_orgs, world):
    alpha, theirs = two_orgs["alpha"], world["beta"]
    for url, params in ((ACCOUNT.format(theirs["client"]), None), (BILLABLE, {"client_id": theirs["client"]})):
        foreign = alpha.client.get(url, params=params, headers=alpha.headers)
        missing = alpha.client.get(url.replace(theirs["client"], str(uuid.uuid4())), params={"client_id": str(uuid.uuid4())} if params else None, headers=alpha.headers)
        assert foreign.status_code == missing.status_code == 404 and foreign.json() == missing.json()
    foreign = alpha.invoice_request(theirs["client"], [])
    missing = alpha.invoice_request(str(uuid.uuid4()), [])
    assert foreign.status_code == missing.status_code == 404 and foreign.json() == missing.json()


def test_another_organizations_dispatched_goods_cannot_be_billed(two_orgs, world):
    alpha, mine, theirs = two_orgs["alpha"], world["alpha"], world["beta"]
    stolen = alpha.invoice_request(mine["client"], [bill(theirs["dispatch"], theirs["product"], 1, "2")])
    ghost = alpha.invoice_request(mine["client"], [{"dispatch_line_id": str(uuid.uuid4()), "quantity": "1", "unit_price": "2"}])
    assert stolen.status_code == ghost.status_code == 404 and stolen.json() == ghost.json()
    # nor into one of my own drafts
    edit = alpha.client.put(f"{INVOICES}/{mine['draft']['id']}/lines", json={"lines": [bill(theirs["dispatch"], theirs["product"], 1, "2")]}, headers=alpha.headers)
    assert edit.status_code == 404 and edit.json() == ghost.json()


def test_another_organizations_payment_cannot_be_reversed_through_my_invoice(two_orgs, world):
    alpha, mine, theirs = two_orgs["alpha"], world["alpha"], world["beta"]
    attempt = alpha.reverse(mine["issued"]["id"], theirs["payment"]["id"])
    assert attempt.status_code == 404 and attempt.json() == alpha.reverse(mine["issued"]["id"], str(uuid.uuid4())).json()


@pytest.mark.parametrize("attacker,victim", [("alpha", "beta"), ("beta", "alpha")])
def test_nothing_of_the_other_organization_changes(two_orgs, world, session_factory, inventory, attacker, victim):
    before, stock_before, requests_before = snapshot(session_factory), inventory.snapshot(), len(inventory.requests)
    org, theirs = two_orgs[attacker], world[victim]
    attempts = []
    for invoice in (theirs["draft"], theirs["issued"]):
        base = f"{INVOICES}/{invoice['id']}"
        attempts += [
            org.client.patch(base, json={"notes": "HIJACKED"}, headers=org.headers),
            org.client.put(f"{base}/lines", json={"lines": []}, headers=org.headers),
            org.issue(invoice["id"]),
            org.void(invoice["id"]),
            org.pay(invoice["id"], "1"),
            org.reverse(invoice["id"], theirs["payment"]["id"]),
        ]
    attempts.append(org.invoice_request(theirs["client"], [bill(theirs["dispatch"], theirs["product"], 1, "2")]))
    assert {a.status_code for a in attempts} == {404}
    assert snapshot(session_factory) == before and inventory.snapshot() == stock_before and len(inventory.requests) == requests_before


def test_the_organization_is_never_taken_from_the_request(two_orgs, world):
    alpha, mine = two_orgs["alpha"], world["alpha"]
    forged = {"client_id": mine["client"], "currency_code": "USD", "lines": [], "organization_id": two_orgs["beta_id"]}
    assert alpha.client.post(INVOICES, json=forged, headers={**alpha.headers, "Idempotency-Key": "forged-key-0001"}).status_code == 422
    assert alpha.client.get(INVOICES, params={"organization_id": two_orgs["beta_id"]}, headers=alpha.headers).json()["total"] == 2
    assert alpha.client.patch(f"{INVOICES}/{mine['draft']['id']}", json={"organization_id": two_orgs["beta_id"]}, headers=alpha.headers).status_code == 422
    forged_payment = {"amount": "1", "method": "cash", "organization_id": two_orgs["beta_id"]}
    assert alpha.client.post(f"{INVOICES}/{mine['issued']['id']}/payments", json=forged_payment, headers={**alpha.headers, "Idempotency-Key": "forged-key-0002"}).status_code == 422
    forged_line = {"lines": [{**bill(mine["dispatch"], mine["product"], 1, "2"), "organization_id": two_orgs["beta_id"]}]}
    assert alpha.client.put(f"{INVOICES}/{mine['draft']['id']}/lines", json=forged_line, headers=alpha.headers).status_code == 422


def test_the_same_idempotency_key_in_two_organizations_is_independent(two_orgs, world):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    a = alpha.invoice_request(world["alpha"]["client"], [bill(world["alpha"]["dispatch"], world["alpha"]["product"], 1, "2")], key="shared-key-0001")
    b = beta.invoice_request(world["beta"]["client"], [bill(world["beta"]["dispatch"], world["beta"]["product"], 1, "2")], key="shared-key-0001")
    assert (a.status_code, b.status_code) == (201, 201) and a.json()["id"] != b.json()["id"]
    pa, pb = alpha.pay(world["alpha"]["issued"]["id"], "1", key="shared-pay-0001"), beta.pay(world["beta"]["issued"]["id"], "1", key="shared-pay-0001")
    assert (pa.status_code, pb.status_code) == (201, 201)


def test_every_invoice_route_needs_an_active_organization_administrator(client, directory, world, two_orgs):
    invoice, payment = world["alpha"]["issued"]["id"], world["alpha"]["payment"]["id"]
    routes = [
        ("get", INVOICES), ("post", INVOICES), ("get", f"{INVOICES}/{invoice}"), ("get", f"{INVOICES}/{invoice}/pdf"), ("patch", f"{INVOICES}/{invoice}"),
        ("put", f"{INVOICES}/{invoice}/lines"), ("post", f"{INVOICES}/{invoice}/issue"), ("post", f"{INVOICES}/{invoice}/void"),
        ("post", f"{INVOICES}/{invoice}/payments"), ("post", f"{INVOICES}/{invoice}/payments/{payment}/reverse"),
        ("get", ACCOUNT.format(world["alpha"]["client"])), ("get", BILLABLE),
    ]
    directory.add_user("super", "super-admin")
    inactive = directory.add_organization("Dormant", active=False)
    directory.add_user("dormant-admin", "organization-admin", inactive)
    for method, url in routes:
        assert client.request(method, url, json={}).status_code == 401, url
        assert client.request(method, url, json={}, headers=bearer("nobody")).status_code == 401, url
        assert client.request(method, url, json={}, headers=bearer("super")).status_code == 403, url
        assert client.request(method, url, json={}, headers=bearer("dormant-admin")).status_code == 403, url


def test_a_deactivated_organization_can_neither_issue_nor_take_payments(two_orgs, world, directory, session_factory):
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = False
    before = snapshot(session_factory)
    alpha = two_orgs["alpha"]
    assert alpha.issue(world["alpha"]["draft"]["id"]).status_code == 403
    assert alpha.pay(world["alpha"]["issued"]["id"], "1").status_code == 403
    assert alpha.reverse(world["alpha"]["issued"]["id"], world["alpha"]["payment"]["id"]).status_code == 403
    assert snapshot(session_factory) == before


def test_an_ordinary_user_who_is_not_an_administrator_is_refused(client, directory, world, two_orgs):
    directory.add_user("clerk", "employee", two_orgs["alpha_id"])
    for method, url in (("get", INVOICES), ("post", INVOICES), ("get", f"{INVOICES}/{world['alpha']['issued']['id']}")):
        assert client.request(method, url, json={}, headers=bearer("clerk")).status_code == 403, url
