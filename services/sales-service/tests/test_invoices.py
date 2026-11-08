"""Sales invoices and client payments: billing dispatched goods once, exact money, the payment record, and independence from inventory."""
import threading
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import text

from conftest import INVOICES, bill, sent


def d(value) -> Decimal:
    return Decimal(str(value))


@pytest.fixture
def depot(inventory, shop):
    inventory.set_stock(shop["bolt"], 60)
    return shop


@pytest.fixture
def world(api, depot):
    """Acme's list DL-000001 (15 bolts, 2 kg flour), Ready, with ONE confirmed dispatch of 10 bolts and 2 kg flour."""
    client = api.new_client("Acme Ltd", address="1 Main St\nBerlin")
    delivery_list = api.new_list(client["id"])
    api.add(delivery_list["id"], depot["bolt"], 15)
    api.add(delivery_list["id"], depot["flour"], 2)
    ready = api.status(delivery_list["id"], "ready").json()
    dispatch = api.confirmed_dispatch(depot, ready, [("bolt", 10), ("flour", 2)])
    return {"client": client, "list": ready, "dispatch": dispatch}


def totals(invoice):
    return tuple(invoice[k] for k in ("subtotal", "discount_total", "tax_total", "total", "paid_total", "outstanding"))


# =====================================================================================================
# Creating and issuing
# =====================================================================================================
def test_a_draft_bills_dispatched_goods_with_the_price_the_administrator_chose(api, depot, world):
    dispatch = world["dispatch"]
    invoice = api.draft_invoice(world["client"]["id"], [
        bill(dispatch, depot["bolt"], 10, "2.50", discount_amount="1.00", tax_rate="10", tax_label="VAT"),
        bill(dispatch, depot["flour"], "0.5", "3.3333"),
    ])
    assert invoice["status"] == "draft" and invoice["number"] is None and invoice["editable"] is True and invoice["currency_code"] == "USD"
    bolts = next(l for l in invoice["lines"] if l["product_sku"] == "BOLT-1")
    assert (bolts["quantity"], bolts["unit_price"], bolts["discount_amount"], bolts["tax_rate"], bolts["tax_label"]) == ("10.0000", "2.5000", "1.0000", "10.0000", "VAT")
    assert (bolts["line_subtotal"], bolts["line_net"], bolts["line_tax"], bolts["line_total"]) == ("25.0000", "24.0000", "2.4000", "26.4000")
    flour = next(l for l in invoice["lines"] if l["product_sku"] == "FLOUR")
    assert (flour["line_subtotal"], flour["line_tax"], flour["line_total"]) == ("1.6667", "0.0000", "1.6667")  # 0.5 x 3.3333 = 1.66665 -> 1.6667 (half up)
    assert totals(invoice) == ("26.6667", "1.0000", "2.4000", "28.0667", "0.0000", "28.0667")
    assert (bolts["product_name"], bolts["unit"]) == ("Steel bolt", "pcs")  # snapshots from the dispatch, not from the browser
    assert invoice["client"]["name"] == "Acme Ltd" and invoice["client_name"] == "Acme Ltd" and invoice["client_address"] == "1 Main St\nBerlin"
    assert invoice["seller_name"] == "Alpha Trading" and invoice["delivery_list"]["number"] == "DL-000001"
    assert bolts["allocations"][0]["dispatch_number"] == "DS-000001" and bolts["allocations"][0]["quantity"] == "10.0000"


@pytest.mark.parametrize("quantity, price, discount, rate, expected", [
    ("0.3333", "0.3333", "0", "0", ("0.1111", "0.1111", "0.0000", "0.1111")),            # 0.11108889 -> 0.1111
    ("1.5", "0.1", "0.05", "7.5", ("0.1500", "0.1000", "0.0075", "0.1075")),
    ("0.5", "0.0001", "0", "100", ("0.0001", "0.0001", "0.0001", "0.0002")),             # 0.00005 rounds half UP to 0.0001
    ("1.9999", "99.9999", "10", "17.5", ("199.9898", "189.9898", "33.2482", "223.2380")),  # 1.9999 x 99.9999 = 199.98980001 ; 189.9898 x 17.5% = 33.248215
    ("1", "0.3333", "0.1111", "33.3333", ("0.3333", "0.2222", "0.0741", "0.2963")),       # 0.2222 x 33.3333% = 0.07406...
    ("2", "49999999999999.9999", "0", "0", ("99999999999999.9998", "99999999999999.9998", "0.0000", "99999999999999.9998")),
    ("1.5", "1.015", "0.005", "5", ("1.5225", "1.5175", "0.0759", "1.5934")),            # 1.5175 x 5% = 0.075875 -> 0.0759
    ("1", "0", "0", "12", ("0.0000", "0.0000", "0.0000", "0.0000")),
])
def test_line_amounts_are_exact_and_rounded_half_up(api, depot, world, quantity, price, discount, rate, expected):
    response = api.invoice_request(world["client"]["id"], [bill(world["dispatch"], depot["flour"], quantity, price, discount_amount=discount, tax_rate=rate)])
    assert response.status_code == 201, response.text
    row = response.json()["lines"][0]
    assert (row["line_subtotal"], row["line_net"], row["line_tax"], row["line_total"]) == expected


def test_the_invoice_totals_are_the_sums_of_the_exact_line_amounts(api, depot, world):
    dispatch = world["dispatch"]
    invoice = api.draft_invoice(world["client"]["id"], [
        bill(dispatch, depot["bolt"], 3, "0.3333", tax_rate="7.5"), bill(dispatch, depot["flour"], 2, "0.1", discount_amount="0.05", tax_rate="17.5"),
    ])
    assert totals(invoice) == ("1.1999", "0.0500", "0.1013", "1.2512", "0.0000", "1.2512")  # 0.9999 + 0.2 ; tax 0.0750 + 0.0263 (0.02625 half up)
    assert d(invoice["total"]) == d(invoice["subtotal"]) - d(invoice["discount_total"]) + d(invoice["tax_total"]) == sum(d(l["line_total"]) for l in invoice["lines"])


def test_issuing_gives_the_next_number_and_freezes_the_invoice(api, depot, world):
    invoice = api.draft_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 10, "2")])
    issued = api.issue(invoice["id"])
    body = issued.json()
    assert issued.status_code == 200 and body["status"] == "issued" and body["number"] == "INV-000001" and body["issued_by_email"] == "admin-alpha@example.org" and body["issued_at"]
    assert body["editable"] is False and body["can_issue"] is False and body["can_record_payment"] is True
    again = api.issue(invoice["id"])
    assert again.status_code == 200 and again.json()["number"] == "INV-000001" and again.json()["issued_at"] == body["issued_at"]  # repeating changes nothing
    assert api.client.patch(f"{INVOICES}/{invoice['id']}", json={"notes": "x"}, headers=api.headers).status_code == 409
    assert api.client.put(f"{INVOICES}/{invoice['id']}/lines", json={"lines": []}, headers=api.headers).status_code == 409
    second = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["flour"], 2, "3")])
    assert second["number"] == "INV-000002"


def test_drafts_have_no_number_and_a_failed_issue_does_not_use_one_up(api, depot, world):
    dispatch = world["dispatch"]
    a = api.draft_invoice(world["client"]["id"], [bill(dispatch, depot["bolt"], 10, "2")])
    b = api.draft_invoice(world["client"]["id"], [bill(dispatch, depot["bolt"], 10, "2")])  # a draft reserves nothing: both may be drafted
    assert a["number"] is None and b["number"] is None
    assert api.issue(a["id"]).json()["number"] == "INV-000001"
    refused = api.issue(b["id"])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "over_invoiced"
    c = api.draft_invoice(world["client"]["id"], [bill(dispatch, depot["flour"], 2, "3")])
    assert api.issue(c["id"]).json()["number"] == "INV-000002"  # no gap: the refused issue consumed nothing


def test_a_draft_can_be_edited_and_its_totals_follow(api, depot, world):
    dispatch = world["dispatch"]
    invoice = api.draft_invoice(world["client"]["id"], [bill(dispatch, depot["bolt"], 10, "2")])
    changed = api.client.put(f"{INVOICES}/{invoice['id']}/lines", json={"lines": [bill(dispatch, depot["bolt"], 4, "5", discount_amount="2", tax_rate="10")]}, headers=api.headers).json()
    assert totals(changed) == ("20.0000", "2.0000", "1.8000", "19.8000", "0.0000", "19.8000") and len(changed["lines"]) == 1
    dated = api.client.patch(f"{INVOICES}/{invoice['id']}", json={"invoice_date": "2025-11-01", "due_date": "2025-12-01", "notes": "Net 30"}, headers=api.headers).json()
    assert (dated["invoice_date"], dated["due_date"], dated["notes"]) == ("2025-11-01", "2025-12-01", "Net 30")
    assert api.client.patch(f"{INVOICES}/{invoice['id']}", json={"due_date": "2025-10-01"}, headers=api.headers).status_code == 422  # before the invoice date


def test_an_invoice_without_lines_or_with_a_zero_total_cannot_be_issued(api, depot, world):
    empty = api.draft_invoice(world["client"]["id"], [])
    assert api.issue(empty["id"]).status_code == 409
    free = api.draft_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 1, "0")])
    refused = api.issue(free["id"])
    assert refused.status_code == 409 and "total of zero" in refused.json()["detail"]


# =====================================================================================================
# Billing dispatched goods once
# =====================================================================================================
def test_partial_invoicing_then_the_rest_and_never_more(api, depot, world):
    client, dispatch = world["client"]["id"], world["dispatch"]
    api.issued_invoice(client, [bill(dispatch, depot["bolt"], 6, "2")])
    lines = api.client.get(f"{INVOICES.replace('invoices', 'billable-lines')}", params={"client_id": client}, headers=api.headers).json()
    bolt = next(l for l in lines if l["product_sku"] == "BOLT-1")
    assert (bolt["dispatched_quantity"], bolt["invoiced_quantity"], bolt["remaining_quantity"]) == ("10.0000", "6.0000", "4.0000")
    refused = api.invoice_request(client, [bill(dispatch, depot["bolt"], 5, "2")])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "over_invoiced" and "at most 4" in refused.json()["detail"]["message"]
    api.issued_invoice(client, [bill(dispatch, depot["bolt"], 4, "2.1")])  # the remaining 4, at a different price
    assert api.invoice_request(client, [bill(dispatch, depot["bolt"], "0.0001", "2")]).status_code == 409
    assert next(l for l in api.client.get("/api/v1/sales/billable-lines", params={"client_id": client}, headers=api.headers).json() if l["product_sku"] == "BOLT-1")["remaining_quantity"] == "0.0000"


def test_the_same_dispatched_quantity_is_not_billed_twice_by_two_issued_invoices(api, depot, world):
    client, dispatch = world["client"]["id"], world["dispatch"]
    first = api.draft_invoice(client, [bill(dispatch, depot["bolt"], 10, "2")])
    second = api.draft_invoice(client, [bill(dispatch, depot["bolt"], 3, "2")])
    assert api.issue(first["id"]).status_code == 200
    refused = api.issue(second["id"])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "over_invoiced"
    assert api.get_invoice(second["id"])["status"] == "draft"


def test_drafts_show_up_as_informational_only(api, depot, world):
    client, dispatch = world["client"]["id"], world["dispatch"]
    api.draft_invoice(client, [bill(dispatch, depot["bolt"], 7, "2")])
    bolt = next(l for l in api.client.get("/api/v1/sales/billable-lines", params={"client_id": client}, headers=api.headers).json() if l["product_sku"] == "BOLT-1")
    assert (bolt["invoiced_quantity"], bolt["in_drafts_quantity"], bolt["remaining_quantity"]) == ("0.0000", "7.0000", "10.0000")


def test_one_invoice_can_bill_several_dispatches_of_one_list(api, depot, world):
    client = world["client"]["id"]
    second = api.confirmed_dispatch(depot, api.detail(world["list"]["id"]), [("bolt", 5)])
    invoice = api.issued_invoice(client, [bill(world["dispatch"], depot["bolt"], 10, "2"), bill(second, depot["bolt"], 5, "2")])
    assert invoice["delivery_list"]["number"] == "DL-000001" and len(invoice["lines"]) == 2
    assert sorted(a["dispatch_number"] for l in invoice["lines"] for a in l["allocations"]) == ["DS-000001", "DS-000002"]
    assert invoice["total"] == "30.0000"


def test_one_invoice_can_bill_two_delivery_lists_of_the_same_client(api, depot, world):
    client = world["client"]["id"]
    other_list = api.new_list(client)
    api.add(other_list["id"], depot["bolt"], 3)
    other_ready = api.status(other_list["id"], "ready").json()
    other = api.confirmed_dispatch(depot, other_ready, [("bolt", 3)])
    invoice = api.draft_invoice(client, [bill(world["dispatch"], depot["bolt"], 10, "2"), bill(other, depot["bolt"], 3, "2")])
    assert invoice["delivery_list"] is None and len(invoice["lines"]) == 2


def test_only_confirmed_dispatches_of_this_client_can_be_billed(api, depot, world):
    client = world["client"]["id"]
    draft_dispatch = api.draft(world["list"]["id"], [sent(api.detail(world["list"]["id"]), depot["bolt"], 2)])
    not_confirmed = {"dispatch_line_id": draft_dispatch["lines"][0]["id"], "quantity": "1", "unit_price": "2"}
    assert api.invoice_request(client, [not_confirmed]).status_code == 404  # a draft dispatch has not left stock yet
    other_client = api.new_client("Other Ltd")
    assert api.invoice_request(other_client["id"], [bill(world["dispatch"], depot["bolt"], 1, "2")]).status_code == 404  # another client's goods
    assert api.invoice_request(client, [{"dispatch_line_id": str(uuid.uuid4()), "quantity": "1", "unit_price": "2"}]).status_code == 404


def test_each_dispatch_line_appears_once_per_invoice_and_unknown_fields_are_refused(api, depot, world):
    client, dispatch = world["client"]["id"], world["dispatch"]
    twice = api.invoice_request(client, [bill(dispatch, depot["bolt"], 1, "2"), bill(dispatch, depot["bolt"], 2, "2")])
    assert twice.status_code == 422 and "only once" in twice.json()["detail"]
    for extra in ({"organization_id": str(uuid.uuid4())}, {"status": "paid"}, {"number": "INV-9"}, {"total": "1"}, {"paid_total": "1"}):
        assert api.invoice_request(client, [], **extra).status_code == 422
    for field in ("product_id", "product_name", "unit", "line_total", "catalog_price"):
        assert api.invoice_request(client, [{**bill(dispatch, depot["bolt"], 1, "2"), field: "x"}]).status_code == 422, field


def test_the_selling_price_is_independent_of_the_catalog_and_the_catalog_is_untouched(api, depot, inventory, world):
    before = (inventory.snapshot(), len(inventory.requests), len(inventory.ledger))
    invoice = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 10, "0.01")])  # far below any catalog price
    api.pay(invoice["id"], "0.10")
    assert (inventory.snapshot(), len(inventory.requests), len(inventory.ledger)) == before  # not one request reached the Inventory Service
    assert inventory.writes() == [("POST", "/api/v1/inventory/dispatches", "admin-alpha")]  # the dispatch of the fixture is the only write ever made


def test_invoicing_works_while_the_inventory_service_is_down(api, depot, inventory, world):
    inventory.mode = "down"
    invoice = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 10, "2")])
    assert api.pay(invoice["id"], "5").status_code == 201
    assert api.client.get(INVOICES, headers=api.headers).status_code == 200
    assert api.client.get(f"{INVOICES}/{invoice['id']}/pdf", headers=api.headers).status_code == 200


# =====================================================================================================
# Currency, dates, validation
# =====================================================================================================
def test_the_currency_must_be_a_real_iso_code_and_nothing_is_converted(api, depot, world):
    client, dispatch = world["client"]["id"], world["dispatch"]
    assert api.invoice_request(client, [bill(dispatch, depot["bolt"], 1, "2")], currency="eur").json()["currency_code"] == "EUR"
    for bad in ("XYZ", "US", "USDD", "12A", "€€€"):
        assert api.invoice_request(client, [], currency=bad).status_code == 422, bad
    pkr = api.issued_invoice(client, [bill(dispatch, depot["bolt"], 1, "2")], currency="PKR")
    assert pkr["currency_code"] == "PKR" and pkr["total"] == "2.0000"


@pytest.mark.parametrize("line_override", [
    {"quantity": "0"}, {"quantity": "-1"}, {"quantity": "abc"}, {"unit_price": "-0.01"}, {"unit_price": "1.00001"}, {"discount_amount": "-1"},
    {"tax_rate": "-1"}, {"tax_rate": "100.0001"}, {"tax_rate": "1.00001"}, {"unit_price": "100000000000000"},
])
def test_bad_amounts_are_refused(api, depot, world, line_override):
    line = {**bill(world["dispatch"], depot["bolt"], 1, "2"), **line_override}
    assert api.invoice_request(world["client"]["id"], [line]).status_code == 422


def test_a_discount_cannot_exceed_the_line_and_a_quantity_cannot_exceed_the_dispatch(api, depot, world):
    client, dispatch = world["client"]["id"], world["dispatch"]
    too_big = api.invoice_request(client, [bill(dispatch, depot["bolt"], 2, "5", discount_amount="10.0001")])
    assert too_big.status_code == 422 and "discount" in too_big.json()["detail"]
    assert api.invoice_request(client, [bill(dispatch, depot["bolt"], 2, "5", discount_amount="10")]).json()["total"] == "0.0000"  # a full discount is allowed on a draft
    assert api.invoice_request(client, [bill(dispatch, depot["bolt"], 11, "2")]).status_code == 409


def test_dates_are_checked(api, depot, world):
    client, dispatch = world["client"]["id"], world["dispatch"]
    line = bill(dispatch, depot["bolt"], 1, "2")
    assert api.invoice_request(client, [line], invoice_date="2999-01-01").status_code == 422
    assert api.invoice_request(client, [line], invoice_date="2025-11-10", due_date="2025-11-09").status_code == 422
    made = api.invoice_request(client, [line], invoice_date="2025-11-01").json()
    assert made["due_date"] == "2025-12-01"  # the default is 30 days


# =====================================================================================================
# Clients
# =====================================================================================================
def test_an_inactive_client_gets_no_new_invoice_but_can_still_pay(api, depot, world):
    client, dispatch = world["client"]["id"], world["dispatch"]
    draft = api.draft_invoice(client, [bill(dispatch, depot["bolt"], 5, "2")])
    issued = api.issued_invoice(client, [bill(dispatch, depot["flour"], 2, "3")])
    api.client.post(f"/api/v1/sales/clients/{client}/deactivate", headers=api.headers)
    refused = api.invoice_request(client, [bill(dispatch, depot["bolt"], 1, "2")])
    assert refused.status_code == 409 and "inactive" in refused.json()["detail"]
    assert api.issue(draft["id"]).status_code == 409
    assert api.client.put(f"{INVOICES}/{draft['id']}/lines", json={"lines": []}, headers=api.headers).status_code == 409
    assert api.pay(issued["id"], "6").status_code == 201  # money that arrives is recorded all the same
    assert api.get_invoice(issued["id"])["status"] == "paid"
    assert api.void(draft["id"]).status_code == 200  # and an unwanted draft can still be discarded


# =====================================================================================================
# Payments
# =====================================================================================================
@pytest.fixture
def invoice(api, depot, world):
    """INV-000001: 10 bolts at 2.50 = 25.00 (no tax), issued."""
    return api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 10, "2.50")])


def test_a_full_payment_marks_the_invoice_paid(api, invoice):
    paid = api.pay(invoice["id"], "25", method="cash", reference="RCPT-1", notes="at the counter")
    body = paid.json()
    assert paid.status_code == 201 and body["status"] == "paid" and (body["paid_total"], body["outstanding"]) == ("25.0000", "0.0000")
    (payment,) = body["payments"]
    assert (payment["kind"], payment["amount"], payment["currency_code"], payment["method"], payment["reference"], payment["notes"]) == ("payment", "25.0000", "USD", "cash", "RCPT-1", "at the counter")
    assert payment["recorded_by_email"] == "admin-alpha@example.org" and payment["payment_date"] and body["can_record_payment"] is False


def test_partial_and_multiple_payments_follow_the_outstanding_balance(api, invoice):
    first = api.pay(invoice["id"], "10").json()
    assert (first["status"], first["paid_total"], first["outstanding"]) == ("partially_paid", "10.0000", "15.0000")
    second = api.pay(invoice["id"], "0.0001").json()
    assert (second["paid_total"], second["outstanding"]) == ("10.0001", "14.9999")
    last = api.pay(invoice["id"], "14.9999").json()
    assert (last["status"], last["paid_total"], last["outstanding"]) == ("paid", "25.0000", "0.0000")
    assert [p["amount"] for p in last["payments"]] == ["10.0000", "0.0001", "14.9999"]  # the history, in order


def test_a_payment_above_the_outstanding_amount_is_refused(api, invoice):
    refused = api.pay(invoice["id"], "25.0001")
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "overpayment" and "no credit" in refused.json()["detail"]["message"].lower()
    api.pay(invoice["id"], "20")
    again = api.pay(invoice["id"], "5.0001")
    assert again.status_code == 409 and again.json()["detail"]["code"] == "overpayment"
    api.pay(invoice["id"], "5")
    paid = api.pay(invoice["id"], "0.0001")
    assert paid.status_code == 409 and "already paid in full" in paid.json()["detail"]["message"]
    assert api.get_invoice(invoice["id"])["paid_total"] == "25.0000"


def test_payments_need_an_issued_invoice(api, depot, world):
    draft = api.draft_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 2, "2")])
    refused = api.pay(draft["id"], "1")
    assert refused.status_code == 409 and "issued invoice" in refused.json()["detail"]
    api.void(draft["id"])
    assert api.pay(draft["id"], "1").status_code == 409


def test_a_repeated_payment_request_records_nothing_twice(api, invoice):
    first = api.pay(invoice["id"], "10", key="pay-key-0001")
    again = api.pay(invoice["id"], "10", key="pay-key-0001")
    assert (first.status_code, again.status_code) == (201, 200) and len(again.json()["payments"]) == 1 and again.json()["paid_total"] == "10.0000"
    different = api.pay(invoice["id"], "11", key="pay-key-0001")
    assert different.status_code == 409 and "different request" in different.json()["detail"]
    assert api.pay(invoice["id"], "10", key="short").status_code == 400
    assert api.client.post(f"{INVOICES}/{invoice['id']}/payments", json={"amount": "1", "method": "cash"}, headers=api.headers).status_code == 400  # a key is required
    assert api.get_invoice(invoice["id"])["paid_total"] == "10.0000"


def test_a_repeated_payment_still_replays_after_the_invoice_became_paid(api, invoice):
    assert api.pay(invoice["id"], "25", key="pay-key-0002").status_code == 201
    assert api.pay(invoice["id"], "25", key="pay-key-0002").status_code == 200  # a double click on the last payment is not an error


@pytest.mark.parametrize("override", [{"method": "bitcoin"}, {"amount": "0"}, {"amount": "-5"}, {"amount": "abc"}, {"amount": "1.00001"}, {"payment_date": "2999-01-01"}, {"currency_code": "EUR"}, {"recorded_by": "x"}])
def test_bad_payments_are_refused(api, invoice, override):
    body = {"amount": "1", "method": "cash", **override}
    response = api.client.post(f"{INVOICES}/{invoice['id']}/payments", json=body, headers={**api.headers, "Idempotency-Key": f"pay-{uuid.uuid4()}"})
    assert response.status_code == 422
    assert api.get_invoice(invoice["id"])["paid_total"] == "0.0000"


def test_simultaneous_payments_can_never_exceed_the_invoice(api, invoice, client):
    results = []

    def pay():
        results.append(client.post(f"{INVOICES}/{invoice['id']}/payments", json={"amount": "10", "method": "cash"}, headers={**api.headers, "Idempotency-Key": f"pay-{uuid.uuid4()}"}).status_code)

    threads = [threading.Thread(target=pay) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(results) == [201, 201, 409, 409, 409]  # 25 due: two 10s fit, a third does not
    body = api.get_invoice(invoice["id"])
    assert body["paid_total"] == "20.0000" and body["status"] == "partially_paid" and len(body["payments"]) == 2


def test_simultaneous_identical_payment_requests_record_one(api, invoice, client):
    results = []

    def pay():
        results.append(client.post(f"{INVOICES}/{invoice['id']}/payments", json={"amount": "10", "method": "cash"}, headers={**api.headers, "Idempotency-Key": "pay-double-click"}).status_code)

    threads = [threading.Thread(target=pay) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(results) == [200] * 5 + [201]
    assert len(api.get_invoice(invoice["id"])["payments"]) == 1


def test_simultaneous_issuing_of_competing_drafts_bills_the_goods_once(api, depot, world, client):
    drafts = [api.draft_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 10, "2")]) for _ in range(4)]
    results = []

    def issue(d_):
        results.append(client.post(f"{INVOICES}/{d_['id']}/issue", headers=api.headers).status_code)

    threads = [threading.Thread(target=issue, args=(x,)) for x in drafts]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(results) == [200, 409, 409, 409]
    issued = [x for x in drafts if api.get_invoice(x["id"])["status"] == "issued"]
    assert len(issued) == 1 and api.get_invoice(issued[0]["id"])["number"] == "INV-000001"


def test_simultaneous_creation_with_one_key_makes_one_invoice(api, depot, world, client):
    statuses, ids = [], []

    def go():
        response = client.post(INVOICES, json={"client_id": world["client"]["id"], "currency_code": "USD", "lines": [bill(world["dispatch"], depot["bolt"], 1, "2")]},
                               headers={**api.headers, "Idempotency-Key": "invoice-key-race"})
        statuses.append(response.status_code)
        if response.status_code in (200, 201):
            ids.append(response.json()["id"])

    threads = [threading.Thread(target=go) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert statuses.count(201) == 1 and len(set(ids)) == 1 and set(statuses) <= {200, 201, 409}
    assert api.client.get(INVOICES, headers=api.headers).json()["total"] == 1


def test_a_repeated_creation_returns_the_same_draft(api, depot, world):
    line = bill(world["dispatch"], depot["bolt"], 2, "2")
    first = api.invoice_request(world["client"]["id"], [line], key="invoice-key-0001")
    again = api.invoice_request(world["client"]["id"], [line], key="invoice-key-0001")
    assert (first.status_code, again.status_code) == (201, 200) and first.json()["id"] == again.json()["id"]
    assert api.invoice_request(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 3, "2")], key="invoice-key-0001").status_code == 409
    assert api.invoice_request(world["client"]["id"], [line], key="short").status_code == 400


# =====================================================================================================
# Reversals and voiding
# =====================================================================================================
def test_a_mistaken_payment_is_corrected_by_a_reversal_and_both_stay_on_record(api, invoice):
    paid = api.pay(invoice["id"], "25").json()
    payment_id = paid["payments"][0]["id"]
    reversed_ = api.reverse(invoice["id"], payment_id, reason="recorded twice by mistake")
    body = reversed_.json()
    assert reversed_.status_code == 201 and body["status"] == "issued" and (body["paid_total"], body["outstanding"]) == ("0.0000", "25.0000")
    original, reversal = body["payments"]
    assert (original["kind"], original["reversed"], original["amount"]) == ("payment", True, "25.0000")
    assert (reversal["kind"], reversal["amount"], reversal["notes"], reversal["reverses_payment_id"]) == ("reversal", "25.0000", "recorded twice by mistake", payment_id)
    assert api.pay(invoice["id"], "25").json()["status"] == "paid"  # the correct payment can now be recorded


def test_a_partial_reversal_state_is_derived_from_the_records(api, invoice):
    first = api.pay(invoice["id"], "10").json()["payments"][0]["id"]
    api.pay(invoice["id"], "15")
    body = api.reverse(invoice["id"], first).json()
    assert (body["status"], body["paid_total"], body["outstanding"]) == ("partially_paid", "15.0000", "10.0000")


def test_a_payment_is_reversed_once_and_a_reversal_cannot_be_reversed(api, invoice):
    pid = api.pay(invoice["id"], "10").json()["payments"][0]["id"]
    done = api.reverse(invoice["id"], pid).json()
    again = api.reverse(invoice["id"], pid)
    assert again.status_code == 409 and again.json()["detail"]["code"] == "already_reversed"
    reversal_id = done["payments"][1]["id"]
    assert api.reverse(invoice["id"], reversal_id).status_code == 404
    assert api.reverse(invoice["id"], str(uuid.uuid4())).status_code == 404
    assert len(api.get_invoice(invoice["id"])["payments"]) == 2


def test_a_reversal_is_idempotent_and_needs_a_reason(api, invoice):
    pid = api.pay(invoice["id"], "10").json()["payments"][0]["id"]
    first = api.reverse(invoice["id"], pid, key="rev-key-0001")
    again = api.reverse(invoice["id"], pid, key="rev-key-0001")
    assert (first.status_code, again.status_code) == (201, 200) and len(again.json()["payments"]) == 2
    other = api.pay(invoice["id"], "5").json()["payments"][-1]["id"]
    response = api.client.post(f"{INVOICES}/{invoice['id']}/payments/{other}/reverse", json={"reason": ""}, headers={**api.headers, "Idempotency-Key": "rev-key-0002"})
    assert response.status_code == 422
    assert api.client.post(f"{INVOICES}/{invoice['id']}/payments/{other}/reverse", json={}, headers={**api.headers, "Idempotency-Key": "rev-key-0003"}).status_code == 422


def test_an_invoice_with_payments_cannot_be_voided_but_an_unpaid_one_can(api, depot, world, invoice):
    pid = api.pay(invoice["id"], "10").json()["payments"][0]["id"]
    refused = api.void(invoice["id"])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "has_payments" and "Reverse the payments first" in refused.json()["detail"]["message"]
    api.pay(invoice["id"], "15")
    assert api.void(invoice["id"]).status_code == 409  # paid invoices are no different
    assert api.get_invoice(invoice["id"])["status"] == "paid"
    api.reverse(invoice["id"], pid)
    still = api.void(invoice["id"])
    assert still.status_code == 409  # 15 is still paid
    second = api.get_invoice(invoice["id"])["payments"][1]["id"]
    api.reverse(invoice["id"], second)
    voided = api.void(invoice["id"], reason="issued to the wrong client")
    body = voided.json()
    assert voided.status_code == 200 and body["status"] == "void" and body["void_reason"] == "issued to the wrong client" and body["number"] == "INV-000001"
    assert len(body["payments"]) == 4  # the whole payment history survived the voiding


def test_voiding_an_issued_invoice_needs_a_reason_and_frees_the_quantity(api, depot, world, invoice):
    assert api.client.post(f"{INVOICES}/{invoice['id']}/void", json={}, headers=api.headers).status_code == 422
    assert api.void(invoice["id"]).status_code == 200
    assert api.void(invoice["id"]).status_code == 200  # repeating is harmless
    rebilled = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 10, "2.40")])
    assert rebilled["number"] == "INV-000002" and rebilled["total"] == "24.0000"  # the voided invoice's quantity is billable again
    assert api.issue(invoice["id"]).status_code == 409 and api.pay(invoice["id"], "1").status_code == 409
    assert api.client.put(f"{INVOICES}/{invoice['id']}/lines", json={"lines": []}, headers=api.headers).status_code == 409


def test_a_draft_can_be_discarded_by_voiding_it(api, depot, world):
    draft = api.draft_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 3, "2")])
    voided = api.void(draft["id"], reason=None)
    assert voided.status_code == 200, voided.text
    assert voided.json()["status"] == "void" and voided.json()["number"] is None


def test_there_is_no_way_to_delete_or_overwrite(api, invoice):
    assert api.client.delete(f"{INVOICES}/{invoice['id']}", headers=api.headers).status_code == 405
    pid = api.pay(invoice["id"], "10").json()["payments"][0]["id"]
    for method in ("delete", "patch", "put"):
        assert api.client.request(method, f"{INVOICES}/{invoice['id']}/payments/{pid}", headers=api.headers).status_code in (404, 405)


# =====================================================================================================
# Listing, filters, the client's account
# =====================================================================================================
def test_the_list_filters_and_searches(api, depot, world):
    client = world["client"]["id"]
    other_client = api.new_client("Zenith Ltd")
    other_list = api.new_list(other_client["id"])
    api.add(other_list["id"], depot["bolt"], 4)
    other_dispatch = api.confirmed_dispatch(depot, api.status(other_list["id"], "ready").json(), [("bolt", 4)])
    unpaid = api.issued_invoice(client, [bill(world["dispatch"], depot["bolt"], 4, "2")], invoice_date="2025-01-10", due_date="2999-01-01")
    partial = api.issued_invoice(client, [bill(world["dispatch"], depot["bolt"], 4, "2")], invoice_date="2025-01-11", due_date="2999-01-01")
    api.pay(partial["id"], "3")
    paid = api.issued_invoice(client, [bill(world["dispatch"], depot["flour"], 2, "3")], invoice_date="2025-01-12", due_date="2025-01-20")
    api.pay(paid["id"], "6")  # past its due date, but settled: not overdue
    overdue = api.issued_invoice(other_client["id"], [bill(other_dispatch, depot["bolt"], 4, "2")], invoice_date="2025-01-02", due_date="2025-01-31")
    draft = api.draft_invoice(client, [bill(world["dispatch"], depot["bolt"], 1, "2")])

    def ids(**params):
        return [i["id"] for i in api.client.get(INVOICES, params=params, headers=api.headers).json()["items"]]

    assert set(ids(status="issued")) == {unpaid["id"], overdue["id"]} and ids(status="partially_paid") == [partial["id"]] and ids(status="paid") == [paid["id"]] and ids(status="draft") == [draft["id"]]
    assert set(ids(payment_status="unpaid")) == {unpaid["id"], overdue["id"]} and ids(payment_status="partial") == [partial["id"]] and ids(payment_status="paid") == [paid["id"]]
    assert ids(payment_status="overdue") == [overdue["id"]]  # not the future-dated ones, not the settled one, not the draft
    assert set(ids(client_id=other_client["id"])) == {overdue["id"]}
    assert ids(q="INV-000002") == [partial["id"]] and ids(q="zenith") == [overdue["id"]]
    assert set(ids(date_from="2025-01-11", date_to="2025-01-12")) == {partial["id"], paid["id"]}
    page = api.client.get(INVOICES, params={"limit": 2, "offset": 4}, headers=api.headers).json()
    assert page["total"] == 5 and len(page["items"]) == 1
    row = next(i for i in api.client.get(INVOICES, headers=api.headers).json()["items"] if i["id"] == partial["id"])
    assert (row["number"], row["total"], row["paid_total"], row["outstanding"], row["overdue"], row["line_count"]) == ("INV-000002", "8.0000", "3.0000", "5.0000", False, 1)


def test_the_client_account_shows_invoices_payments_and_the_outstanding_balance_per_currency(api, depot, world):
    client = world["client"]["id"]
    usd = api.issued_invoice(client, [bill(world["dispatch"], depot["bolt"], 10, "2.50")], invoice_date="2025-01-01", due_date="2025-01-31")
    api.pay(usd["id"], "10")
    api.issued_invoice(client, [bill(world["dispatch"], depot["flour"], 2, "100")], currency="PKR", due_date="2999-01-01")
    api.draft_invoice(client, [])  # drafts are not part of the balance
    account = api.client.get(f"/api/v1/sales/clients/{client}/account", headers=api.headers).json()
    balances = {b["currency_code"]: b for b in account["balances"]}
    assert (balances["USD"]["invoiced"], balances["USD"]["paid"], balances["USD"]["outstanding"], balances["USD"]["overdue"]) == ("25.0000", "10.0000", "15.0000", "15.0000")
    assert (balances["PKR"]["invoiced"], balances["PKR"]["outstanding"], balances["PKR"]["overdue"]) == ("200.0000", "200.0000", "0.0000")  # never added across currencies
    assert account["client"]["name"] == "Acme Ltd" and len(account["invoices"]) == 3
    assert [(p["invoice_number"], p["amount"]) for p in account["payments"]] == [("INV-000001", "10.0000")]


# =====================================================================================================
# PDF
# =====================================================================================================
def test_the_invoice_pdf_is_built_from_the_saved_invoice(api, depot, world):
    issued = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 10, "2.50", discount_amount="1", tax_rate="10", tax_label="VAT")], notes="Thank you")
    api.pay(issued["id"], "10", method="cash", reference="RCPT-9")
    response = api.client.get(f"{INVOICES}/{issued['id']}/pdf", headers=api.headers)
    assert response.status_code == 200 and response.headers["content-type"] == "application/pdf"
    assert 'filename="INV-000001.pdf"' in response.headers["content-disposition"] and response.headers["cache-control"] == "no-store"
    pdf = response.content
    assert pdf.startswith(b"%PDF-") and pdf.rstrip().endswith(b"%%EOF")
    for expected in (b"INV-000001", b"Alpha Trading", b"Acme Ltd", b"Steel bolt", b"BOLT-1", b"26.40", b"16.40", b"RCPT-9", b"PARTIALLY PAID", b"Thank you", b"does not certify"):
        assert expected in pdf, expected


def test_a_draft_and_a_void_invoice_have_a_pdf_too(api, depot, world):
    draft = api.draft_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 3, "2")])
    pdf = api.client.get(f"{INVOICES}/{draft['id']}/pdf", headers=api.headers)
    assert pdf.status_code == 200 and b"DRAFT" in pdf.content and 'filename="invoice-draft.pdf"' in pdf.headers["content-disposition"]
    api.void(draft["id"])
    assert b"VOID" in api.client.get(f"{INVOICES}/{draft['id']}/pdf", headers=api.headers).content


def test_names_with_markup_cannot_break_the_pdf(api, depot, world):
    client = api.new_client("A & B <Traders> \"Ltd\"")
    delivery_list = api.new_list(client["id"])
    api.add(delivery_list["id"], depot["bolt"], 2)
    dispatch = api.confirmed_dispatch(depot, api.status(delivery_list["id"], "ready").json(), [("bolt", 2)])
    issued = api.issued_invoice(client["id"], [bill(dispatch, depot["bolt"], 2, "2")], notes="<b>bold</b> & more")
    assert api.client.get(f"{INVOICES}/{issued['id']}/pdf", headers=api.headers).status_code == 200


# =====================================================================================================
# The database rows match the story
# =====================================================================================================
def test_the_database_keeps_the_paid_total_in_step_with_the_payments(api, invoice, session_factory):
    api.pay(invoice["id"], "10")
    with session_factory() as db:
        row = db.execute(text("SELECT status, paid_total, outstanding FROM invoices WHERE id = :id"), {"id": uuid.UUID(invoice["id"])}).one()
        count = db.execute(text("SELECT count(*) FROM invoice_payments WHERE invoice_id = :id"), {"id": uuid.UUID(invoice["id"])}).scalar()
    assert (row.status, row.paid_total, row.outstanding, count) == ("partially_paid", Decimal("10.0000"), Decimal("15.0000"), 1)


def test_the_account_flags_reversed_payments_and_counts_every_invoice_in_the_balance(api, depot, world):
    client = world["client"]["id"]
    inv = api.issued_invoice(client, [bill(world["dispatch"], depot["bolt"], 10, "2.50")])
    pid = api.pay(inv["id"], "10").json()["payments"][0]["id"]
    api.reverse(inv["id"], pid)
    account = api.client.get(f"/api/v1/sales/clients/{client}/account", headers=api.headers).json()
    by_id = {p["id"]: p for p in account["payments"]}
    assert by_id[pid]["reversed"] is True
    assert [p["kind"] for p in account["payments"] if p["id"] != pid] == ["reversal"]
    assert account["balances"] == [{"currency_code": "USD", "invoiced": "25.0000", "paid": "0.0000", "outstanding": "25.0000", "overdue": "0.0000"}]


def test_the_pdf_shows_amounts_exactly_as_stored_not_rounded_to_cents(api, depot, world):
    issued = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["flour"], "0.5", "3.3333"), bill(world["dispatch"], depot["bolt"], 3, "0.3333", tax_rate="7.5")])
    assert issued["total"] == "2.7416"  # 1.6667 + 0.9999 + tax 0.0750
    pdf = api.client.get(f"{INVOICES}/{issued['id']}/pdf", headers=api.headers).content
    for exact in (b"3.3333", b"0.3333", b"1.6667", b"2.7416"):
        assert exact in pdf, exact
