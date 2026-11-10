"""Generate Invoice: a dispatched sales order becomes a saved DRAFT invoice in one request.

The goods and quantities are the order's confirmed dispatch lines, the unit price is the price AGREED with the client on the order (never the catalog's), the
currency is the order's, tax and discount are zero. Nothing is invented (an order made before prices were recorded is refused), it can be repeated without a
second invoice, another organization's order is a 404, and no stock moves.
"""
import threading
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import text

from conftest import INVOICES, bearer, sent

ORDERS = "/api/v1/sales/orders"


def d(value) -> Decimal:
    return Decimal(str(value))


@pytest.fixture
def goods(inventory, two_orgs):
    """Alpha's catalog. Some products still carry an old catalog price (2.50 / 1.20): it is a decoy, no order or invoice may use it."""
    org = two_orgs["alpha_id"]
    items = {
        "bolt": inventory.add_product(org, "BOLT-1", "Steel bolt", "pcs", price="2.5000", currency="USD"),
        "flour": inventory.add_product(org, "FLOUR", "Flour", "kg", price="1.2000", currency="USD"),
        "plain": inventory.add_product(org, "PLAIN", "Widget with no catalog price", "pcs"),
    }
    for key in items:
        inventory.set_stock(items[key], 1000)
    return items


def make_order(api, client, *lines, key=None, currency="USD"):
    """Lines are (product id, quantity, agreed unit price)."""
    headers = {**api.headers, "Idempotency-Key": key or f"order-{uuid.uuid4()}"}
    response = api.client.post(ORDERS, json={"client_id": client["id"], "currency_code": currency, "lines": [{"product_id": p, "quantity": str(q), "unit_price": str(price)} for p, q, price in lines]}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def dispatch_all(api, order, *lines):
    """Confirm ONE dispatch of these (product id, quantity) lines of the order's delivery list."""
    delivery_list = api.detail(order["delivery_list"]["id"])
    draft = api.draft(delivery_list["id"], [sent(delivery_list, p, q) for p, q in lines])
    confirmed = api.confirm(draft["id"])
    assert confirmed.status_code == 200, confirmed.text
    return confirmed.json()


def generate(api, order, headers=None):
    return api.client.post(f"{ORDERS}/{order['id']}/invoice", headers=headers or api.headers)


def make_it_an_older_order(session_factory):
    with session_factory() as db:  # what an older order looks like: no agreed prices were ever recorded
        db.execute(text("UPDATE delivery_list_items SET unit_price = NULL"))
        db.execute(text("UPDATE sales_orders SET currency_code = NULL"))
        db.commit()


@pytest.fixture
def delivered(api, goods):
    client = api.new_client("Acme Ltd", address="1 Main St\nBerlin")
    order = make_order(api, client, (goods["bolt"], 10, "30"), (goods["flour"], 4, "12.5"))
    dispatch_all(api, order, (goods["bolt"], 10), (goods["flour"], 4))
    return {"client": client, "order": order}


# =====================================================================================================
def test_it_makes_a_saved_draft_with_the_dispatched_goods_priced_as_agreed_on_the_order(api, delivered, goods):
    response = generate(api, delivered["order"])
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["created"] is True
    invoice = body["invoice"]
    assert invoice["status"] == "draft" and invoice["number"] is None and invoice["currency_code"] == "USD"
    assert invoice["client"]["name"] == "Acme Ltd" and invoice["notes"] == "Generated from sales order SO-000001 (delivery list DL-000001)."
    lines = {l["product_sku"]: l for l in invoice["lines"]}
    assert set(lines) == {"BOLT-1", "FLOUR"}
    assert (d(lines["BOLT-1"]["quantity"]), d(lines["BOLT-1"]["unit_price"]), d(lines["BOLT-1"]["line_total"])) == (10, 30, 300)  # NOT the catalog's 2.50
    assert (d(lines["FLOUR"]["quantity"]), d(lines["FLOUR"]["unit_price"]), d(lines["FLOUR"]["line_total"])) == (4, Decimal("12.5"), 50)
    assert all(d(l["discount_amount"]) == 0 and d(l["tax_rate"]) == 0 and d(l["line_tax"]) == 0 for l in invoice["lines"])
    assert d(invoice["subtotal"]) == d(invoice["total"]) == 350


def test_two_clients_ordering_the_same_product_are_invoiced_their_own_prices(api, goods):
    first, second = api.new_client("Company A"), api.new_client("Company B")
    a = make_order(api, first, (goods["bolt"], 20, "120000"), currency="PKR")
    b = make_order(api, second, (goods["bolt"], 20, "110000"), currency="PKR")
    for order in (a, b):
        dispatch_all(api, order, (goods["bolt"], 20))
    invoice_a, invoice_b = generate(api, a).json()["invoice"], generate(api, b).json()["invoice"]
    assert (invoice_a["currency_code"], d(invoice_a["total"])) == ("PKR", d("2400000"))
    assert (invoice_b["currency_code"], d(invoice_b["total"])) == ("PKR", d("2200000"))


def test_a_later_catalog_change_does_not_change_the_invoice_that_is_generated(api, delivered, goods, inventory, two_orgs):
    inventory.products[two_orgs["alpha_id"]][goods["bolt"]]["price"] = "9999.0000"
    invoice = generate(api, delivered["order"]).json()["invoice"]
    assert d(next(l for l in invoice["lines"] if l["product_sku"] == "BOLT-1")["unit_price"]) == 30


def test_it_is_saved_so_the_sales_invoice_page_lists_it(api, delivered):
    made = generate(api, delivered["order"]).json()["invoice"]
    listed = api.client.get(INVOICES, headers=api.headers).json()
    assert [i["id"] for i in listed["items"]] == [made["id"]]
    assert api.get_invoice(made["id"])["status"] == "draft"


def test_each_line_is_backed_by_the_dispatch_line_it_bills(api, delivered):
    invoice = generate(api, delivered["order"]).json()["invoice"]
    dispatch = api.client.get("/api/v1/sales/dispatches", headers=api.headers).json()
    dispatch_line_ids = {l["id"] for item in dispatch["items"] for l in api.get_dispatch(item["id"])["lines"]}
    allocated = {a["dispatch_line_id"] for l in invoice["lines"] for a in l["allocations"]}
    assert allocated == dispatch_line_ids and len(allocated) == 2


def test_repeating_it_returns_the_same_invoice_and_makes_no_second_one(api, delivered):
    first = generate(api, delivered["order"])
    again = generate(api, delivered["order"])
    assert first.status_code == 201 and again.status_code == 200
    assert again.json()["created"] is False and again.json()["invoice"]["id"] == first.json()["invoice"]["id"]
    assert len(api.client.get(INVOICES, headers=api.headers).json()["items"]) == 1


def test_an_issued_invoice_for_the_order_is_returned_too_nothing_is_billed_twice(api, delivered):
    made = generate(api, delivered["order"]).json()["invoice"]
    assert api.issue(made["id"]).status_code == 200
    again = generate(api, delivered["order"])
    assert again.status_code == 200 and again.json()["created"] is False and again.json()["invoice"]["status"] == "issued"
    assert len(api.client.get(INVOICES, headers=api.headers).json()["items"]) == 1


def test_a_voided_invoice_lets_the_order_be_invoiced_again(api, delivered):
    made = generate(api, delivered["order"]).json()["invoice"]
    assert api.issue(made["id"]).status_code == 200
    assert api.void(made["id"]).status_code == 200
    again = generate(api, delivered["order"])
    assert again.status_code == 201 and again.json()["created"] is True and again.json()["invoice"]["id"] != made["id"]


def test_simultaneous_clicks_make_exactly_one_invoice(api, delivered, client):
    results = []

    def click():
        results.append(api.client.post(f"{ORDERS}/{delivered['order']['id']}/invoice", headers=api.headers).status_code)

    threads = [threading.Thread(target=click) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results).count(201) == 1 and set(results) <= {200, 201}
    assert len(api.client.get(INVOICES, headers=api.headers).json()["items"]) == 1


def test_only_what_was_dispatched_is_billed(api, goods):
    client = api.new_client("Partial Co")
    order = make_order(api, client, (goods["bolt"], 10, "3"), (goods["flour"], 4, "2"))
    dispatch_all(api, order, (goods["bolt"], 6))
    invoice = generate(api, order).json()["invoice"]
    assert [(l["product_sku"], d(l["quantity"]), d(l["unit_price"])) for l in invoice["lines"]] == [("BOLT-1", 6, 3)]


def test_an_order_with_nothing_dispatched_has_nothing_to_invoice(api, goods):
    client = api.new_client("Idle Co")
    order = make_order(api, client, (goods["bolt"], 3, "4"))
    response = generate(api, order)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "not_dispatched"
    assert api.client.get(INVOICES, headers=api.headers).json()["items"] == []


def test_an_order_made_before_prices_were_recorded_is_refused_with_the_way_forward(api, goods, session_factory):
    client = api.new_client("Old Co")
    order = make_order(api, client, (goods["bolt"], 2, "5"))
    make_it_an_older_order(session_factory)  # (before the dispatch: a dispatched list's items are frozen by the database)
    dispatch_all(api, order, (goods["bolt"], 2))
    response = generate(api, order)
    assert response.status_code == 422 and response.json()["detail"]["code"] == "prices_not_recorded"
    assert "by hand" in response.json()["detail"]["message"]
    assert api.client.get(INVOICES, headers=api.headers).json()["items"] == []


def test_the_billable_lines_carry_the_agreed_price_and_currency_so_a_manual_invoice_can_start_from_them(api, delivered):
    lines = api.client.get("/api/v1/sales/billable-lines", params={"client_id": delivered["client"]["id"]}, headers=api.headers).json()
    agreed = {l["product_sku"]: (d(l["agreed_unit_price"]), l["agreed_currency_code"], l["order_number"]) for l in lines}
    assert agreed == {"BOLT-1": (30, "USD", "SO-000001"), "FLOUR": (Decimal("12.5"), "USD", "SO-000001")}


def test_billable_lines_of_an_older_order_have_no_agreed_price(api, goods, session_factory):
    client = api.new_client("Old Co")
    order = make_order(api, client, (goods["bolt"], 2, "5"))
    make_it_an_older_order(session_factory)  # (before the dispatch: a dispatched list's items are frozen by the database)
    dispatch_all(api, order, (goods["bolt"], 2))
    (line,) = api.client.get("/api/v1/sales/billable-lines", params={"client_id": client["id"]}, headers=api.headers).json()
    assert line["agreed_unit_price"] is None and line["agreed_currency_code"] is None


def test_the_agreed_price_is_a_default_not_a_rule_a_draft_may_still_be_priced_otherwise(api, delivered):
    made = generate(api, delivered["order"]).json()["invoice"]
    line = next(l for l in made["lines"] if l["product_sku"] == "BOLT-1")
    changed = api.client.put(f"{INVOICES}/{made['id']}/lines", json={"lines": [{"dispatch_line_id": line["allocations"][0]["dispatch_line_id"], "quantity": "10", "unit_price": "29"}]}, headers=api.headers)
    assert changed.status_code == 200 and d(changed.json()["lines"][0]["unit_price"]) == 29  # the invoice's own rules apply; the order's agreed price is untouched


def test_a_product_with_no_catalog_price_is_invoiced_at_its_agreed_price(api, goods):
    client = api.new_client("Acme Ltd")
    order = make_order(api, client, (goods["plain"], 3, "7"))
    dispatch_all(api, order, (goods["plain"], 3))
    invoice = generate(api, order).json()["invoice"]
    assert d(invoice["total"]) == 21


def test_an_inventory_outage_does_not_matter_the_prices_are_the_orders_own(api, delivered, inventory):
    inventory.mode = "down"
    response = generate(api, delivered["order"])
    inventory.mode = None
    assert response.status_code == 201 and d(response.json()["invoice"]["total"]) == 350


def test_an_inactive_client_gets_no_new_invoice(api, delivered):
    api.client.post(f"/api/v1/sales/clients/{delivered['client']['id']}/deactivate", headers=api.headers)
    refused = generate(api, delivered["order"])
    assert refused.status_code == 409 and "inactive" in str(refused.json()["detail"])
    assert api.client.get(INVOICES, headers=api.headers).json()["items"] == []


def test_it_changes_no_stock(api, delivered, inventory):
    before = dict(inventory.stock)
    writes = list(inventory.deduction_writes())
    generate(api, delivered["order"])
    assert inventory.stock == before and inventory.deduction_writes() == writes


def test_another_organizations_order_is_a_404_and_nothing_is_made(two_orgs, delivered):
    beta = two_orgs["beta"]
    response = generate(beta, delivered["order"])
    assert response.status_code == 404
    assert beta.client.get(INVOICES, headers=beta.headers).json()["items"] == []
    assert generate(two_orgs["alpha"], {"id": str(uuid.uuid4())}).status_code == 404


def test_it_needs_a_signed_in_organization_administrator(api, delivered, client):
    assert client.post(f"{ORDERS}/{delivered['order']['id']}/invoice").status_code == 401
    assert client.post(f"{ORDERS}/{delivered['order']['id']}/invoice", headers=bearer("nobody")).status_code == 401


def test_a_malformed_id_is_a_422(api):
    assert api.client.post(f"{ORDERS}/not-a-uuid/invoice", headers=api.headers).status_code == 422
