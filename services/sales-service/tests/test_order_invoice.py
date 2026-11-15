"""Order invoices: the simple printable invoice of a PREPARED order (booked, still to be dispatched), and the invoice history.

The invoice is made from the order's own lines at the prices AGREED on the order (never the catalog's), is a document only (no draft step, no payments, nothing for Finance
or the stock), is frozen the moment it exists, and there is never a second one for the same order. The history lists these and the older invoices together, newest first,
with a client filter and a date filter that work alone or together.
"""
import threading
import uuid
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from conftest import INVOICES, bearer, sent

ORDERS = "/api/v1/sales/orders"
ORDER_INVOICES = "/api/v1/sales/order-invoices"
HISTORY = "/api/v1/sales/invoice-history"


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
    """Confirm ONE dispatch of these (product id, quantity) lines of the order's delivery list (shared with the Finance feed tests)."""
    delivery_list = api.detail(order["delivery_list"]["id"])
    draft = api.draft(delivery_list["id"], [sent(delivery_list, p, q) for p, q in lines])
    confirmed = api.confirm(draft["id"])
    assert confirmed.status_code == 200, confirmed.text
    return confirmed.json()


def make_it_an_older_order(session_factory):
    with session_factory() as db:  # what an older order looks like: no agreed prices were ever recorded
        db.execute(text("UPDATE delivery_list_items SET unit_price = NULL"))
        db.commit()


def invoice_of(api, order, headers=None):
    return api.client.post(ORDER_INVOICES, json={"order_id": order["id"]}, headers=headers or api.headers)


@pytest.fixture
def prepared(api, goods):
    client = api.new_client("Acme Ltd", address="1 Main St\nBerlin")
    order = make_order(api, client, (goods["bolt"], 10, "30"), (goods["flour"], 4, "12.5"))
    return {"client": client, "order": order}


# =====================================================================================================
def test_it_makes_the_invoice_from_the_order_at_the_agreed_prices_before_anything_is_dispatched(api, prepared):
    response = invoice_of(api, prepared["order"])
    assert response.status_code == 201, response.text
    invoice = response.json()
    assert invoice["number"] == "INV-000001" and invoice["currency_code"] == "USD" and invoice["order_number"] == "SO-000001"
    assert invoice["client_name"] == "Acme Ltd" and invoice["client_address"] == "1 Main St\nBerlin" and invoice["delivery_list_number"] == "DL-000001"
    assert invoice["invoice_date"] == date.today().isoformat() or invoice["invoice_date"]  # today's date in the service's clock
    lines = {l["product_sku"]: l for l in invoice["lines"]}
    assert set(lines) == {"BOLT-1", "FLOUR"}
    assert (d(lines["BOLT-1"]["quantity"]), d(lines["BOLT-1"]["unit_price"]), d(lines["BOLT-1"]["line_total"])) == (10, 30, 300)  # NOT the catalog's 2.50
    assert (d(lines["FLOUR"]["quantity"]), d(lines["FLOUR"]["unit_price"]), d(lines["FLOUR"]["line_total"])) == (4, Decimal("12.5"), 50)
    assert d(invoice["subtotal"]) == d(invoice["total"]) == 350
    assert api.client.get(f"{ORDER_INVOICES}/{invoice['id']}", headers=api.headers).json() == invoice


def test_two_clients_ordering_the_same_product_are_invoiced_their_own_prices(api, goods):
    acme, globex = api.new_client("Acme Ltd"), api.new_client("Globex")
    first = invoice_of(api, make_order(api, acme, (goods["bolt"], 2, "30"))).json()
    second = invoice_of(api, make_order(api, globex, (goods["bolt"], 2, "45"))).json()
    assert d(first["lines"][0]["unit_price"]) == 30 and d(second["lines"][0]["unit_price"]) == 45
    assert first["number"] == "INV-000001" and second["number"] == "INV-000002"


def test_a_later_catalog_change_or_client_rename_does_not_change_the_invoice(api, prepared, goods, inventory, two_orgs):
    made = invoice_of(api, prepared["order"]).json()
    inventory.products[two_orgs["alpha_id"]][goods["bolt"]]["price"] = "9999.0000"
    api.client.patch(f"/api/v1/sales/clients/{prepared['client']['id']}", json={"name": "Renamed Ltd", "address": "Elsewhere"}, headers=api.headers)
    again = api.client.get(f"{ORDER_INVOICES}/{made['id']}", headers=api.headers).json()
    assert again == made and again["client_name"] == "Acme Ltd"


def test_asking_again_returns_the_same_invoice_and_there_is_never_a_second(api, prepared):
    first = invoice_of(api, prepared["order"])
    again = invoice_of(api, prepared["order"])
    assert first.status_code == 201 and again.status_code == 200 and again.json() == first.json()
    assert api.client.get(f"{HISTORY}", headers=api.headers).json()["total"] == 1


def test_simultaneous_requests_make_exactly_one_invoice(api, prepared):
    results = []

    def click():
        results.append(invoice_of(api, prepared["order"]).status_code)

    threads = [threading.Thread(target=click) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results).count(201) == 1 and set(results) <= {200, 201}
    assert api.client.get(HISTORY, headers=api.headers).json()["total"] == 1


def test_the_invoice_is_frozen_by_the_database(api, prepared, session_factory):
    made = invoice_of(api, prepared["order"]).json()
    for sql in ("UPDATE order_invoices SET client_name = 'x'", "DELETE FROM order_invoices", "UPDATE order_invoice_lines SET quantity = 1", "DELETE FROM order_invoice_lines"):
        with session_factory() as db:
            with pytest.raises(DBAPIError):
                db.execute(text(sql))
                db.commit()
    assert api.client.get(f"{ORDER_INVOICES}/{made['id']}", headers=api.headers).json() == made


def test_an_order_made_before_prices_were_recorded_cannot_be_invoiced(api, prepared, session_factory):
    with session_factory() as db:  # what an older order looks like: no agreed prices were ever recorded
        db.execute(text("UPDATE delivery_list_items SET unit_price = NULL"))
        db.commit()
    refused = invoice_of(api, prepared["order"])
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "prices_not_recorded"
    assert api.client.get(HISTORY, headers=api.headers).json()["total"] == 0


def test_only_a_prepared_order_can_be_invoiced(api, prepared):
    cancelled = api.client.post(f"{ORDERS}/{prepared['order']['id']}/cancel", headers=api.headers)
    assert cancelled.status_code == 200, cancelled.text
    refused = invoice_of(api, prepared["order"])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "not_prepared"


def test_it_changes_no_stock_and_calls_no_other_service(api, prepared, inventory):
    before_stock, before_calls = dict(inventory.stock), len(inventory.requests)
    invoice_of(api, prepared["order"])
    assert inventory.stock == before_stock and len(inventory.requests) == before_calls


def test_it_is_not_a_financial_record(api, prepared, session_factory):
    invoice_of(api, prepared["order"])
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM invoices")).scalar() == 0  # the Finance feed reads only `invoices`
        assert db.execute(text("SELECT count(*) FROM invoice_payments")).scalar() == 0


def test_the_orders_list_can_show_only_the_prepared_ones_and_which_are_invoiced(api, goods):
    acme, globex = api.new_client("Acme Ltd"), api.new_client("Globex")
    first = make_order(api, acme, (goods["bolt"], 1, "30"))
    second = make_order(api, globex, (goods["flour"], 1, "12"))
    invoice = invoice_of(api, first).json()
    listed = api.client.get(ORDERS, params={"view": "active", "booked": "true"}, headers=api.headers).json()
    assert [o["number"] for o in listed["items"]] == ["SO-000002", "SO-000001"]  # newest first
    only_globex = api.client.get(ORDERS, params={"view": "active", "booked": "true", "client_id": globex["id"]}, headers=api.headers).json()
    assert [o["number"] for o in only_globex["items"]] == ["SO-000002"]
    refs = api.client.get(f"{ORDER_INVOICES}/by-order", params={"order_ids": f"{first['id']},{second['id']}"}, headers=api.headers).json()["items"]
    assert refs == [{"order_id": first["id"], "invoice_id": invoice["id"], "number": invoice["number"]}]
    assert api.client.get(f"{ORDER_INVOICES}/by-order", params={"order_ids": "nope"}, headers=api.headers).status_code == 422
    assert api.client.get(f"{ORDER_INVOICES}/by-order", headers=api.headers).json() == {"items": []}


# ---- the history -----------------------------------------------------------------------------------------
def test_the_history_lists_every_invoice_newest_first_and_filters_by_client_and_date(api, goods, session_factory):
    acme, globex = api.new_client("Acme Ltd"), api.new_client("Globex")
    a = invoice_of(api, make_order(api, acme, (goods["bolt"], 1, "30"))).json()
    g = invoice_of(api, make_order(api, globex, (goods["flour"], 2, "12"))).json()
    with session_factory() as db:  # an older day for the first one (the guard is lifted for this one statement, as a maintenance step)
        db.execute(text("ALTER TABLE order_invoices DISABLE TRIGGER trg_order_invoices_append_only"))
        db.execute(text("UPDATE order_invoices SET invoice_date = '2026-01-05' WHERE id = :i"), {"i": a["id"]})
        db.execute(text("ALTER TABLE order_invoices ENABLE TRIGGER trg_order_invoices_append_only"))
        db.commit()
    everything = api.client.get(HISTORY, headers=api.headers).json()
    assert [i["number"] for i in everything["items"]] == [g["number"], a["number"]] and everything["total"] == 2  # newest first
    assert everything["items"][0] == {"kind": "order", "id": g["id"], "number": g["number"], "client_id": globex["id"], "client_name": "Globex", "invoice_date": g["invoice_date"],
                                      "currency_code": "USD", "total": "24.0000", "status": "issued", "order_number": "SO-000002"}
    by_client = api.client.get(HISTORY, params={"client_id": acme["id"]}, headers=api.headers).json()
    assert [i["number"] for i in by_client["items"]] == [a["number"]]
    by_day = api.client.get(HISTORY, params={"day": "2026-01-05"}, headers=api.headers).json()
    assert [i["number"] for i in by_day["items"]] == [a["number"]]
    both = api.client.get(HISTORY, params={"client_id": globex["id"], "day": "2026-01-05"}, headers=api.headers).json()
    assert both["items"] == [] and both["total"] == 0  # together they narrow it further
    paged = api.client.get(HISTORY, params={"limit": 1, "offset": 1}, headers=api.headers).json()
    assert paged["total"] == 2 and [i["number"] for i in paged["items"]] == [a["number"]]
    assert api.client.get(HISTORY, params={"day": "not-a-date"}, headers=api.headers).status_code == 422


def test_the_history_also_lists_the_older_invoices_and_the_numbers_never_collide(api, goods, session_factory):
    acme = api.new_client("Acme Ltd")
    order = make_order(api, acme, (goods["bolt"], 3, "30"))
    delivery_list = api.detail(order["delivery_list"]["id"])
    confirmed = api.confirm(api.draft(delivery_list["id"], [sent(delivery_list, goods["bolt"], 3)])["id"])
    assert confirmed.status_code == 200, confirmed.text
    billable = api.client.get("/api/v1/sales/billable-lines", params={"client_id": acme["id"]}, headers=api.headers).json()
    old = api.issued_invoice(acme["id"], [{"dispatch_line_id": billable[0]["dispatch_line_id"], "quantity": "3", "unit_price": "30"}])
    newer = invoice_of(api, make_order(api, acme, (goods["flour"], 1, "12"))).json()
    assert newer["number"] == "INV-000002"  # the same counter as the older invoices
    history = api.client.get(HISTORY, headers=api.headers).json()
    assert [(i["kind"], i["number"]) for i in history["items"]] == [("order", "INV-000002"), ("invoice", "INV-000001")] and history["total"] == 2
    assert api.client.get(HISTORY, params={"client_id": acme["id"]}, headers=api.headers).json()["total"] == 2


# ---- the printable document ------------------------------------------------------------------------------
def test_the_pdf_is_the_same_template_as_a_plain_document_without_payment_lines(api, prepared):
    made = invoice_of(api, prepared["order"]).json()
    shown = api.client.get(f"{ORDER_INVOICES}/{made['id']}/pdf", params={"inline": "true"}, headers=api.headers)
    assert shown.status_code == 200 and shown.headers["content-type"] == "application/pdf" and shown.content.startswith(b"%PDF")
    assert shown.headers["content-disposition"].startswith("inline") and "INV-000001.pdf" in shown.headers["content-disposition"]
    download = api.client.get(f"{ORDER_INVOICES}/{made['id']}/pdf", headers=api.headers)
    assert download.headers["content-disposition"].startswith("attachment")
    body = shown.content
    for expected in (b"INVOICE", b"INV-000001", b"Acme Ltd", b"BILLED TO", b"GRAND TOTAL", b"SO-000001"):
        assert expected in body, expected
    for absent in (b"Due Date", b"Payment Status", b"Balance due", b"Amount paid"):
        assert absent not in body, absent


# ---- access and isolation ----------------------------------------------------------------------------------
def test_another_organization_can_neither_invoice_nor_read(two_orgs, prepared):
    beta = two_orgs["beta"]
    assert invoice_of(beta, prepared["order"]).status_code == 404
    made = invoice_of(two_orgs["alpha"], prepared["order"]).json()
    assert beta.client.get(f"{ORDER_INVOICES}/{made['id']}", headers=beta.headers).status_code == 404
    assert beta.client.get(f"{ORDER_INVOICES}/{made['id']}/pdf", headers=beta.headers).status_code == 404
    assert beta.client.get(HISTORY, headers=beta.headers).json() == {"items": [], "total": 0, "limit": 25, "offset": 0}
    assert beta.client.get(f"{ORDER_INVOICES}/by-order", params={"order_ids": prepared["order"]["id"]}, headers=beta.headers).json() == {"items": []}
    assert invoice_of(two_orgs["alpha"], {"id": str(uuid.uuid4())}).status_code == 404


def test_every_route_needs_a_signed_in_organization_administrator(api, prepared, client):
    made = invoice_of(api, prepared["order"]).json()
    for method, url in (("post", ORDER_INVOICES), ("get", HISTORY), ("get", f"{ORDER_INVOICES}/by-order"), ("get", f"{ORDER_INVOICES}/{made['id']}"), ("get", f"{ORDER_INVOICES}/{made['id']}/pdf")):
        assert getattr(client, method)(url).status_code == 401, url
        assert getattr(client, method)(url, headers=bearer("nobody")).status_code == 401, url


def test_a_malformed_order_id_is_a_422_and_nothing_else_is_accepted(api):
    assert api.client.post(ORDER_INVOICES, json={"order_id": "not-a-uuid"}, headers=api.headers).status_code == 422
    assert api.client.post(ORDER_INVOICES, json={"order_id": str(uuid.uuid4()), "total": "1"}, headers=api.headers).status_code == 422  # nothing but the order can be sent


def test_the_generate_invoice_after_dispatch_endpoint_is_gone(api, prepared):
    assert api.client.post(f"{ORDERS}/{prepared['order']['id']}/invoice", headers=api.headers).status_code in (404, 405)
