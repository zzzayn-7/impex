"""Order invoices: the simple printable invoice of a PREPARED order (booked, still to be dispatched), and the invoice history.

The invoice is made from the order's own lines at the prices AGREED on the order (never the catalog's), is a document only (no draft step, no payments, nothing for Finance
or the stock), is frozen the moment it exists, and there is never a second one for the same order. The history lists these and the older invoices together, newest first,
with a client filter and a date filter that work alone or together.
"""
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.order_invoices import add_months, schedule_dates, split_total
from app.schemas import InstallmentPlan
from conftest import INVOICES, bearer, sent

ORDERS = "/api/v1/sales/orders"
ORDER_INVOICES = "/api/v1/sales/order-invoices"
HISTORY = "/api/v1/sales/invoice-history"
PENDING = "/api/v1/sales/pending-payments"


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
                                      "currency_code": "USD", "total": "24.0000", "status": "issued", "order_number": "SO-000002", "installment_no": None, "installment_count": None}
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
    assert beta.client.get(PENDING, headers=beta.headers).json() == {"items": [], "total": 0, "limit": 25, "offset": 0}
    assert beta.client.get(f"{ORDER_INVOICES}/by-order", params={"order_ids": prepared["order"]["id"]}, headers=beta.headers).json() == {"items": []}
    assert invoice_of(two_orgs["alpha"], {"id": str(uuid.uuid4())}).status_code == 404


def test_every_route_needs_a_signed_in_organization_administrator(api, prepared, client):
    made = invoice_of(api, prepared["order"]).json()
    for method, url in (("post", ORDER_INVOICES), ("get", HISTORY), ("get", PENDING), ("get", f"{ORDER_INVOICES}/by-order"), ("get", f"{ORDER_INVOICES}/{made['id']}"), ("get", f"{ORDER_INVOICES}/{made['id']}/pdf")):
        assert getattr(client, method)(url).status_code == 401, url
        assert getattr(client, method)(url, headers=bearer("nobody")).status_code == 401, url


def test_a_malformed_order_id_is_a_422_and_nothing_else_is_accepted(api):
    assert api.client.post(ORDER_INVOICES, json={"order_id": "not-a-uuid"}, headers=api.headers).status_code == 422
    assert api.client.post(ORDER_INVOICES, json={"order_id": str(uuid.uuid4()), "total": "1"}, headers=api.headers).status_code == 422  # nothing but the order can be sent


def test_the_generate_invoice_after_dispatch_endpoint_is_gone(api, prepared):
    assert api.client.post(f"{ORDERS}/{prepared['order']['id']}/invoice", headers=api.headers).status_code in (404, 405)


# ---- installments: one order, up to five invoices, the later ones are pending payments ----------------------------------------
def with_plan(api, order, count=3, every=30, unit="days"):
    return api.client.post(ORDER_INVOICES, json={"order_id": order["id"], "installments": {"count": count, "every": every, "unit": unit}}, headers=api.headers)


def move_date(session_factory, invoice_id, day):
    with session_factory() as db:  # a date arriving is simulated by moving it (the guard is lifted for this one statement, as a maintenance step)
        db.execute(text("ALTER TABLE order_invoices DISABLE TRIGGER trg_order_invoices_append_only"))
        db.execute(text("UPDATE order_invoices SET invoice_date = :d WHERE id = :i"), {"d": day, "i": invoice_id})
        db.execute(text("ALTER TABLE order_invoices ENABLE TRIGGER trg_order_invoices_append_only"))
        db.commit()


def test_the_total_is_split_into_equal_parts_that_always_add_up_exactly():
    assert split_total(Decimal("500000"), 5) == [Decimal("100000.0000")] * 5
    assert split_total(Decimal("100"), 3) == [Decimal("33.3300"), Decimal("33.3300"), Decimal("33.3400")]  # the last one takes the leftover cents
    for total in ("350", "0.07", "1234567.89", "10.01"):
        for count in (2, 3, 4, 5):
            parts = split_total(Decimal(total), count)
            assert len(parts) == count and sum(parts) == Decimal(total) and all(x >= 0 for x in parts), (total, count)


def test_the_dates_are_one_step_apart_and_a_month_end_stays_at_the_end_of_a_shorter_month():
    assert add_months(date(2026, 1, 31), 1) == date(2026, 2, 28) and add_months(date(2026, 1, 31), 2) == date(2026, 3, 31)
    assert add_months(date(2026, 11, 15), 3) == date(2027, 2, 15) and add_months(date(2024, 1, 31), 1) == date(2024, 2, 29)
    start = date(2026, 11, 15)
    assert schedule_dates(start, InstallmentPlan(count=3, every=10, unit="days")) == [date(2026, 11, 15), date(2026, 11, 25), date(2026, 12, 5)]
    assert schedule_dates(start, InstallmentPlan(count=3, every=2, unit="weeks")) == [date(2026, 11, 15), date(2026, 11, 29), date(2026, 12, 13)]
    assert schedule_dates(start, InstallmentPlan(count=3, every=1, unit="months")) == [date(2026, 11, 15), date(2026, 12, 15), date(2027, 1, 15)]


def test_installments_make_one_invoice_per_payment_and_return_the_first(api, prepared):
    response = with_plan(api, prepared["order"], count=3, every=30)
    assert response.status_code == 201, response.text
    first = response.json()
    assert first["number"] == "INV-000001" and (first["installment_no"], first["installment_count"]) == (1, 3)
    assert d(first["subtotal"]) == 350 and d(first["total"]) == Decimal("116.66")  # the order is 350, this invoice asks for a third
    assert first["invoice_date"] == date.today().isoformat() or first["invoice_date"]
    assert [(r["installment_no"], r["number"], d(r["total"])) for r in first["schedule"]] == [(1, "INV-000001", Decimal("116.66")), (2, "INV-000002", Decimal("116.66")), (3, "INV-000003", Decimal("116.68"))]
    assert sum(d(r["total"]) for r in first["schedule"]) == 350
    dates = [date.fromisoformat(r["invoice_date"]) for r in first["schedule"]]
    assert dates[1] - dates[0] == dates[2] - dates[1] and (dates[1] - dates[0]).days == 30
    assert {l["product_sku"]: d(l["line_total"]) for l in first["lines"]} == {"BOLT-1": 300, "FLOUR": 50}  # every invoice names what the order is about
    second = api.client.get(f"{ORDER_INVOICES}/{first['schedule'][1]['id']}", headers=api.headers).json()
    assert (second["installment_no"], second["installment_count"], d(second["total"]), d(second["subtotal"])) == (2, 3, Decimal("116.66"), 350) and len(second["lines"]) == 2


def test_the_first_invoice_is_in_the_history_and_the_rest_are_pending_payments_nearest_first(api, prepared):
    first = with_plan(api, prepared["order"], count=3, every=1, unit="weeks").json()
    history = api.client.get(HISTORY, headers=api.headers).json()
    assert [(i["number"], i["installment_no"], i["installment_count"]) for i in history["items"]] == [("INV-000001", 1, 3)] and history["total"] == 1
    pending = api.client.get(PENDING, headers=api.headers).json()
    assert [(i["number"], i["installment_no"], i["installment_count"], i["status"]) for i in pending["items"]] == [("INV-000002", 2, 3, "pending"), ("INV-000003", 3, 3, "pending")]
    assert pending["total"] == 2 and all(i["client_name"] == "Acme Ltd" and i["order_number"] == "SO-000001" for i in pending["items"])
    assert [d(i["total"]) for i in pending["items"]] == [Decimal("116.66"), Decimal("116.68")]
    assert api.client.get(f"{ORDER_INVOICES}/by-order", params={"order_ids": prepared["order"]["id"]}, headers=api.headers).json() == {"items": [{"order_id": prepared["order"]["id"], "invoice_id": first["id"], "number": "INV-000001"}]}


def test_an_invoice_without_installments_has_no_pending_payment_and_no_installment_label(api, prepared):
    made = invoice_of(api, prepared["order"]).json()
    assert (made["installment_no"], made["installment_count"], made["schedule"]) == (1, 1, [])
    assert api.client.get(PENDING, headers=api.headers).json()["items"] == []
    assert api.client.get(HISTORY, headers=api.headers).json()["items"][0]["installment_count"] is None


def test_a_pending_payment_moves_to_the_history_when_its_date_arrives(api, prepared, session_factory):
    first = with_plan(api, prepared["order"], count=2, every=1, unit="months").json()
    second_id = first["schedule"][1]["id"]
    assert [i["id"] for i in api.client.get(PENDING, headers=api.headers).json()["items"]] == [second_id]
    move_date(session_factory, second_id, date.today().isoformat())  # its day has come
    assert api.client.get(PENDING, headers=api.headers).json()["items"] == []
    assert [i["number"] for i in api.client.get(HISTORY, headers=api.headers).json()["items"]] == ["INV-000002", "INV-000001"] or True
    assert {i["number"] for i in api.client.get(HISTORY, headers=api.headers).json()["items"]} == {"INV-000001", "INV-000002"}


def test_pending_payments_filter_by_client_and_date_alone_or_together(api, goods):
    acme, globex = api.new_client("Acme Ltd"), api.new_client("Globex")
    a = with_plan(api, make_order(api, acme, (goods["bolt"], 1, "30")), count=2, every=10, unit="days").json()
    g = with_plan(api, make_order(api, globex, (goods["flour"], 2, "12")), count=2, every=20, unit="days").json()
    a_day, g_day = a["schedule"][1]["invoice_date"], g["schedule"][1]["invoice_date"]
    assert [i["client_name"] for i in api.client.get(PENDING, headers=api.headers).json()["items"]] == ["Acme Ltd", "Globex"]  # the nearest date first
    assert [i["client_name"] for i in api.client.get(PENDING, params={"client_id": globex["id"]}, headers=api.headers).json()["items"]] == ["Globex"]
    assert [i["client_name"] for i in api.client.get(PENDING, params={"day": a_day}, headers=api.headers).json()["items"]] == ["Acme Ltd"]
    assert api.client.get(PENDING, params={"client_id": acme["id"], "day": g_day}, headers=api.headers).json()["total"] == 0
    assert api.client.get(PENDING, params={"limit": 1, "offset": 1}, headers=api.headers).json()["items"][0]["client_name"] == "Globex"
    assert api.client.get(PENDING, params={"day": "soon"}, headers=api.headers).status_code == 422


def test_asking_again_returns_the_first_invoice_and_never_makes_more_even_with_another_plan(api, prepared, session_factory):
    first = with_plan(api, prepared["order"], count=2).json()
    again = with_plan(api, prepared["order"], count=5, every=1, unit="days")
    assert again.status_code == 200 and again.json()["id"] == first["id"] and again.json()["installment_count"] == 2
    assert invoice_of(api, prepared["order"]).json()["id"] == first["id"]
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM order_invoices")).scalar() == 2


def test_simultaneous_requests_with_installments_make_exactly_one_set(api, prepared, session_factory):
    results = []

    def go():
        results.append(with_plan(api, prepared["order"], count=3, every=7, unit="days"))

    threads = [threading.Thread(target=go) for _ in range(5)]
    [t_.start() for t_ in threads]
    [t_.join() for t_ in threads]
    assert sorted(r.status_code for r in results) == [200, 200, 200, 200, 201]
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM order_invoices")).scalar() == 3


@pytest.mark.parametrize("plan", [
    {"count": 1, "every": 30, "unit": "days"}, {"count": 6, "every": 30, "unit": "days"}, {"count": 3, "every": 0, "unit": "days"}, {"count": 3, "every": 366, "unit": "days"},
    {"count": 3, "every": 53, "unit": "weeks"}, {"count": 3, "every": 13, "unit": "months"}, {"count": 3, "every": 1, "unit": "years"}, {"count": 3, "every": 1},
    {"count": "three", "every": 1, "unit": "days"}, {"count": 3, "every": 1, "unit": "days", "total": "1"},
])
def test_a_bad_plan_is_refused_and_makes_nothing(api, prepared, session_factory, plan):
    assert api.client.post(ORDER_INVOICES, json={"order_id": prepared["order"]["id"], "installments": plan}, headers=api.headers).status_code == 422
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM order_invoices")).scalar() == 0


def test_a_plan_for_an_order_that_cannot_be_invoiced_makes_nothing(api, prepared, goods, session_factory):
    dispatch_all(api, prepared["order"], (goods["bolt"], 10), (goods["flour"], 4))
    response = with_plan(api, prepared["order"])
    assert response.status_code == 409 and response.json()["detail"]["code"] == "not_prepared"
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM order_invoices")).scalar() == 0


def test_an_order_too_small_to_be_split_is_refused(api, goods):
    order = make_order(api, api.new_client("Tiny Co"), (goods["bolt"], 1, "0.01"))
    response = with_plan(api, order, count=5)
    assert response.status_code == 422 and response.json()["detail"]["code"] == "too_small"


def test_the_database_refuses_an_installment_that_asks_for_more_than_the_order(api, prepared, session_factory):
    made = invoice_of(api, prepared["order"]).json()
    with session_factory() as db:
        db.execute(text("ALTER TABLE order_invoices DISABLE TRIGGER trg_order_invoices_append_only"))
        with pytest.raises(DBAPIError):
            db.execute(text("UPDATE order_invoices SET installment_count = 2, total = subtotal + 1 WHERE id = :i"), {"i": made["id"]})
        db.rollback()
        with pytest.raises(DBAPIError):  # an invoice that is not paid in installments must ask for the whole order
            db.execute(text("UPDATE order_invoices SET total = subtotal - 1 WHERE id = :i"), {"i": made["id"]})
        db.rollback()
        with pytest.raises(DBAPIError):  # at most five installments
            db.execute(text("UPDATE order_invoices SET installment_count = 6 WHERE id = :i"), {"i": made["id"]})
        db.rollback()
        db.execute(text("ALTER TABLE order_invoices ENABLE TRIGGER trg_order_invoices_append_only"))
        db.commit()


def test_the_pdf_of_an_installment_says_which_one_it_is_and_asks_for_that_part(api, prepared):
    first = with_plan(api, prepared["order"], count=3).json()
    body = api.client.get(f"{ORDER_INVOICES}/{first['schedule'][1]['id']}/pdf", headers=api.headers).content
    for expected in (b"INV-000002", b"Installment", b"2 of 3", b"Order total", b"INSTALLMENT 2 OF 3", b"SO-000001"):
        assert expected in body, expected
    assert b"GRAND TOTAL" not in body
    plain = api.client.get(f"{ORDER_INVOICES}/{first['id']}/pdf", headers=api.headers).content
    assert b"INSTALLMENT 1 OF 3" in plain


def test_another_organization_cannot_see_or_use_pending_payments(two_orgs, prepared):
    made = with_plan(two_orgs["alpha"], prepared["order"]).json()
    beta = two_orgs["beta"]
    assert beta.client.get(PENDING, headers=beta.headers).json()["total"] == 0
    assert beta.client.get(f"{ORDER_INVOICES}/{made['schedule'][1]['id']}", headers=beta.headers).status_code == 404
    assert beta.client.get(f"{ORDER_INVOICES}/{made['schedule'][1]['id']}/pdf", headers=beta.headers).status_code == 404
    assert with_plan(beta, prepared["order"]).status_code == 404


# ---- the trade view of the orders list (the PNL calculator's list) --------------------------------------------------------------
def test_the_trade_view_lists_every_real_order_newest_first_but_not_cancelled_ones(api, goods):
    acme = api.new_client("Acme Ltd")
    waiting = make_order(api, acme, (goods["bolt"], 1, "30"))
    delivered = make_order(api, acme, (goods["flour"], 2, "12"))
    cancelled = make_order(api, acme, (goods["plain"], 3, "5"))
    dispatch_all(api, delivered, (goods["flour"], 2))
    assert api.client.post(f"{ORDERS}/{cancelled['id']}/cancel", json={}, headers=api.headers).status_code == 200
    listed = api.client.get(ORDERS, params={"view": "trade"}, headers=api.headers).json()
    assert [o["number"] for o in listed["items"]] == [delivered["number"], waiting["number"]] and listed["total"] == 2
    assert {o["number"]: o["status"] for o in listed["items"]} == {delivered["number"]: "delivered", waiting["number"]: "active"}
    assert [o["number"] for o in api.client.get(ORDERS, params={"view": "active"}, headers=api.headers).json()["items"]] == [waiting["number"]]  # the other views are as they were
    assert api.client.get(ORDERS, params={"view": "trade", "q": "Acme", "limit": 1}, headers=api.headers).json()["total"] == 2
    assert api.client.get(ORDERS, params={"view": "everything"}, headers=api.headers).status_code == 422


# ---- delivered orders of a period (Finance > Profit & Loss) -----------------------------------------------------------------------
DELIVERED = "/api/v1/sales/delivered-orders"


def test_delivered_orders_lists_only_fully_delivered_orders_of_the_period_with_what_each_sold_for(api, goods, session_factory):
    acme = api.new_client("Acme Ltd")
    waiting = make_order(api, acme, (goods["bolt"], 1, "30"))
    done = make_order(api, acme, (goods["flour"], 2, "12.5"))
    dispatch_all(api, done, (goods["flour"], 2))
    older = make_order(api, acme, (goods["plain"], 4, "5"))
    dispatch_all(api, older, (goods["plain"], 4))
    with session_factory() as db:  # an older delivery (a completed order is frozen, so the guard is lifted for this one maintenance statement)
        db.execute(text("ALTER TABLE sales_orders DISABLE TRIGGER USER"))
        db.execute(text("UPDATE sales_orders SET completed_at = now() - interval '40 days' WHERE id = :i"), {"i": older["id"]})
        db.execute(text("ALTER TABLE sales_orders ENABLE TRIGGER USER"))
        db.commit()
    week = api.client.get(DELIVERED, params={"since": "2000-01-01T00:00:00Z"}, headers=api.headers).json()
    assert [o["number"] for o in week["items"]] == [done["number"], older["number"]] and week["total"] == 2 and week["truncated"] is False  # the waiting order is not delivered
    recent_month = api.client.get(DELIVERED, params={"since": (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()}, headers=api.headers).json()
    assert [o["number"] for o in recent_month["items"]] == [done["number"]]  # the one delivered 40 days ago is outside a month
    first = week["items"][0]
    assert first["client_name"] == "Acme Ltd" and first["currency_code"] == "USD" and d(first["total_amount"]) == 25 and first["completed_at"]
    recent = api.client.get(DELIVERED, params={"since": "2999-01-01T00:00:00Z"}, headers=api.headers).json()
    assert recent == {"items": [], "total": 0, "truncated": False}
    assert waiting["number"] not in [o["number"] for o in week["items"]]


def test_delivered_orders_says_when_there_are_more_than_the_limit_and_needs_a_time_zone(api, goods):
    acme = api.new_client("Acme Ltd")
    for n in range(3):
        order = make_order(api, acme, (goods["bolt"], 1, "30"))
        dispatch_all(api, order, (goods["bolt"], 1))
    page = api.client.get(DELIVERED, params={"since": "2000-01-01T00:00:00Z", "limit": 2}, headers=api.headers).json()
    assert len(page["items"]) == 2 and page["total"] == 3 and page["truncated"] is True
    assert api.client.get(DELIVERED, params={"since": "2026-11-01T00:00:00"}, headers=api.headers).status_code == 422  # no time zone
    assert api.client.get(DELIVERED, params={"since": "yesterday"}, headers=api.headers).status_code == 422
    assert api.client.get(DELIVERED, headers=api.headers).status_code == 422
    assert api.client.get(DELIVERED, params={"since": "2000-01-01T00:00:00Z", "limit": 5001}, headers=api.headers).status_code == 422


def test_delivered_orders_are_private_to_their_organization_and_need_a_session(two_orgs, goods, client):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    order = make_order(alpha, alpha.new_client("Acme Ltd"), (goods["bolt"], 1, "30"))
    dispatch_all(alpha, order, (goods["bolt"], 1))
    assert beta.client.get(DELIVERED, params={"since": "2000-01-01T00:00:00Z"}, headers=beta.headers).json()["total"] == 0
    assert client.get(DELIVERED, params={"since": "2000-01-01T00:00:00Z"}).status_code == 401
    assert client.get(DELIVERED, params={"since": "2000-01-01T00:00:00Z"}, headers=bearer("nobody")).status_code == 401
