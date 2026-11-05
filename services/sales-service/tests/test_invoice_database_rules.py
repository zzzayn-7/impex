"""Rules the DATABASE enforces by itself, with the API bypassed (raw SQL): the invoice life cycle, the freeze of issued invoices, the
no-double-invoicing rule, the append-only payment record and the payment status that always follows from the payments."""
import threading
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from test_dispatch_database_rules import add_line, confirm, make_dispatch, make_world, start_posting


def run(engine, sql, **params):
    with engine.begin() as conn:
        return conn.execute(text(sql), params)


def refused(engine, sql, **params) -> str:
    with pytest.raises((DBAPIError, IntegrityError)) as caught:
        run(engine, sql, **params)
    return str(caught.value.orig)


def confirmed_world(engine, quantities=("10", "4"), org=None, number="DL-000001", dispatch_number="DS-000001"):
    """A client, a Ready list and ONE confirmed dispatch of every item in full."""
    world = make_world(engine, quantities=quantities, org=org, number=number)
    dispatch = make_dispatch(engine, world, dispatch_number)
    world["dispatch"] = dispatch
    world["lines"] = [add_line(engine, world, dispatch, i, q) for i, q in enumerate(quantities)]
    start_posting(engine, dispatch)
    confirm(engine, dispatch)
    return world


def new_invoice(engine, world, client=None, org=None, currency="USD"):
    invoice = uuid.uuid4()
    run(engine,
        "INSERT INTO invoices (id, organization_id, client_id, invoice_date, due_date, currency_code, created_by, created_by_email) "
        "VALUES (:id, :o, :c, current_date, current_date + 30, :cur, :u, 'a@b.c')",
        id=invoice, o=org or world["org"], c=client or world["client"], cur=currency, u=uuid.uuid4())
    return invoice


def add_invoice_line(engine, world, invoice, index=0, quantity="10", price="2", dispatch_line=None, product=None):
    """An invoice line (exact arithmetic, no tax) with its allocation to the dispatch line; the invoice header totals follow."""
    line, quantity, price = uuid.uuid4(), Decimal(quantity), Decimal(price)
    amount = (quantity * price).quantize(Decimal("0.0001"))
    run(engine,
        "INSERT INTO invoice_lines (id, organization_id, invoice_id, product_id, product_sku, product_name, unit, quantity, unit_price, "
        "line_subtotal, line_net, line_tax, line_total) VALUES (:id, :o, :i, :p, 'SKU', 'Thing', 'pcs', :q, :price, :a, :a, 0, :a)",
        id=line, o=world["org"], i=invoice, p=product or world["products"][index], q=quantity, price=price, a=amount)
    run(engine,
        "INSERT INTO invoice_allocations (organization_id, invoice_id, invoice_line_id, dispatch_line_id, quantity) VALUES (:o, :i, :l, :d, :q)",
        o=world["org"], i=invoice, l=line, d=dispatch_line or world["lines"][index], q=quantity)
    totals(engine, invoice)
    return line


def totals(engine, invoice):
    run(engine,
        "UPDATE invoices SET subtotal = s.v, total = s.v FROM (SELECT COALESCE(sum(line_total), 0) AS v FROM invoice_lines WHERE invoice_id = :i) s WHERE id = :i",
        i=invoice)


def issue(engine, invoice, number="INV-000001"):
    run(engine, "UPDATE invoices SET status = 'issued', number = :n, issued_at = now(), issued_by = :u, issued_by_email = 'a@b.c' WHERE id = :id",
        n=number, u=uuid.uuid4(), id=invoice)


def issued_invoice(engine, world, number="INV-000001", quantity="10", price="2.5", index=0):
    invoice = new_invoice(engine, world)
    add_invoice_line(engine, world, invoice, index, quantity, price)
    issue(engine, invoice, number)
    return invoice


def pay(engine, world, invoice, amount, key=None, kind="payment", reverses=None, notes=None, currency="USD", method="cash"):
    payment = uuid.uuid4()
    run(engine,
        "INSERT INTO invoice_payments (id, organization_id, invoice_id, kind, reverses_payment_id, payment_date, amount, currency_code, method, notes, "
        "idempotency_key, request_hash, recorded_by, recorded_by_email) VALUES (:id, :o, :i, :k, :r, current_date, :a, :cur, :m, :n, :key, 'h', :u, 'a@b.c')",
        id=payment, o=world["org"], i=invoice, k=kind, r=reverses, a=Decimal(amount), cur=currency, m=method, n=notes, key=key or f"key-{payment}", u=uuid.uuid4())
    return payment


def row(engine, invoice):
    return run(engine, "SELECT status, paid_total, outstanding, total FROM invoices WHERE id = :i", i=invoice).one()


# =====================================================================================================
# Life cycle
# =====================================================================================================
def test_an_invoice_starts_as_an_unnumbered_unpaid_draft(engine):
    w = confirmed_world(engine)
    base = ("INSERT INTO invoices (organization_id, client_id, invoice_date, due_date, currency_code, created_by, created_by_email{extra}) "
            "VALUES (:o, :c, current_date, current_date, 'USD', :u, 'a@b.c'{values})")
    common = dict(o=w["org"], c=w["client"], u=uuid.uuid4())
    assert "starts as" in refused(engine, base.format(extra=", status", values=", 'issued'"), **common)
    assert "starts as" in refused(engine, base.format(extra=", number", values=", 'INV-9'"), **common)
    assert "starts as" in refused(engine, base.format(extra=", paid_total, total, subtotal", values=", 5, 5, 5"), **common)


def test_a_draft_can_only_be_issued_or_voided(engine):
    w = confirmed_world(engine)
    invoice = new_invoice(engine, w)
    add_invoice_line(engine, w, invoice)
    for target in ("partially_paid", "paid", "bogus"):
        assert refused(engine, "UPDATE invoices SET status = :s WHERE id = :id", s=target, id=invoice)
    assert row(engine, invoice).status == "draft"


def test_issuing_needs_a_number_and_an_issuer(engine):
    w = confirmed_world(engine)
    invoice = new_invoice(engine, w)
    add_invoice_line(engine, w, invoice)
    assert refused(engine, "UPDATE invoices SET status = 'issued' WHERE id = :id", id=invoice)
    assert refused(engine, "UPDATE invoices SET status = 'issued', number = 'INV-1' WHERE id = :id", id=invoice)
    assert refused(engine, "UPDATE invoices SET status = 'issued', issued_at = now(), issued_by = gen_random_uuid(), issued_by_email = 'a@b.c' WHERE id = :id", id=invoice)


def test_an_invoice_without_lines_or_with_a_total_of_zero_is_not_issued(engine):
    w = confirmed_world(engine)
    empty = new_invoice(engine, w)
    assert "without lines" in refused(engine, "UPDATE invoices SET status = 'issued', number = 'INV-1', issued_at = now(), issued_by = gen_random_uuid(), issued_by_email = 'a@b.c' WHERE id = :id", id=empty)
    free = new_invoice(engine, w)
    add_invoice_line(engine, w, free, price="0")
    assert "total of zero" in refused(engine, "UPDATE invoices SET status = 'issued', number = 'INV-1', issued_at = now(), issued_by = gen_random_uuid(), issued_by_email = 'a@b.c' WHERE id = :id", id=free)


def test_the_header_totals_must_be_the_sums_of_the_lines_when_issuing(engine):
    w = confirmed_world(engine)
    invoice = new_invoice(engine, w)
    add_invoice_line(engine, w, invoice)
    run(engine, "UPDATE invoices SET total = total + 1, subtotal = subtotal + 1 WHERE id = :id", id=invoice)
    assert "sums of its lines" in refused(engine, "UPDATE invoices SET status = 'issued', number = 'INV-1', issued_at = now(), issued_by = gen_random_uuid(), issued_by_email = 'a@b.c' WHERE id = :id", id=invoice)


def test_every_line_must_be_fully_backed_by_dispatched_goods(engine):
    w = confirmed_world(engine)
    invoice = new_invoice(engine, w)
    line = add_invoice_line(engine, w, invoice, quantity="10")
    run(engine, "UPDATE invoice_allocations SET quantity = 6 WHERE invoice_line_id = :l", l=line)
    assert "fully backed" in refused(engine, "UPDATE invoices SET status = 'issued', number = 'INV-1', issued_at = now(), issued_by = gen_random_uuid(), issued_by_email = 'a@b.c' WHERE id = :id", id=invoice)


def test_the_same_dispatched_quantity_cannot_be_on_two_issued_invoices(engine):
    w = confirmed_world(engine)
    first, second = new_invoice(engine, w), new_invoice(engine, w)
    add_invoice_line(engine, w, first, quantity="10")
    add_invoice_line(engine, w, second, quantity="3")  # drafts reserve nothing: both exist
    issue(engine, first)
    assert "more than was dispatched" in refused(engine, "UPDATE invoices SET status = 'issued', number = 'INV-2', issued_at = now(), issued_by = gen_random_uuid(), issued_by_email = 'a@b.c' WHERE id = :id", id=second)
    assert row(engine, second).status == "draft"


def test_a_voided_invoice_frees_its_quantity(engine):
    w = confirmed_world(engine)
    first = issued_invoice(engine, w)
    run(engine, "UPDATE invoices SET status = 'void', voided_at = now(), voided_by_email = 'a@b.c', void_reason = 'wrong client' WHERE id = :id", id=first)
    second = new_invoice(engine, w)
    add_invoice_line(engine, w, second, quantity="10")
    issue(engine, second, "INV-000002")
    assert row(engine, second).status == "issued"


def test_two_invoices_issued_at_the_same_moment_cannot_both_bill_the_goods(engine):
    w = confirmed_world(engine)
    invoices = [new_invoice(engine, w) for _ in range(4)]
    for invoice in invoices:
        add_invoice_line(engine, w, invoice, quantity="10")
    outcomes = []

    def go(invoice, n):
        try:
            issue(engine, invoice, f"INV-{n:06d}")
            outcomes.append("issued")
        except (DBAPIError, IntegrityError):
            outcomes.append("refused")

    threads = [threading.Thread(target=go, args=(invoice, n)) for n, invoice in enumerate(invoices, 1)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(outcomes) == ["issued", "refused", "refused", "refused"]


# =====================================================================================================
# Frozen once issued
# =====================================================================================================
@pytest.mark.parametrize("assignment", [
    "total = 1", "subtotal = 1", "discount_total = 1", "tax_total = 1", "due_date = current_date + 90", "invoice_date = current_date - 1", "notes = 'changed'",
    "currency_code = 'EUR'", "number = 'INV-999999'", "client_name = 'Someone else'", "seller_name = 'Someone else'", "client_address = 'Elsewhere'",
    "created_by_email = 'x@y.z'", "issued_by_email = 'x@y.z'",
])
def test_the_commercial_details_of_an_issued_invoice_are_frozen(engine, assignment):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w)
    assert refused(engine, f"UPDATE invoices SET {assignment} WHERE id = :id", id=invoice)
    pay(engine, w, invoice, "5")  # the same is true once it is partially paid
    assert refused(engine, f"UPDATE invoices SET {assignment} WHERE id = :id", id=invoice)


def test_the_client_and_identity_of_an_invoice_never_change(engine):
    w = confirmed_world(engine)
    other = make_world(engine, org=w["org"], number="DL-000002")
    invoice = new_invoice(engine, w)
    assert "identity" in refused(engine, "UPDATE invoices SET client_id = :c WHERE id = :id", c=other["client"], id=invoice)
    assert "identity" in refused(engine, "UPDATE invoices SET organization_id = gen_random_uuid() WHERE id = :id", id=invoice)
    assert "identity" in refused(engine, "UPDATE invoices SET created_by = gen_random_uuid() WHERE id = :id", id=invoice)


def test_an_issued_invoice_cannot_go_back_to_a_draft_or_skip_to_paid(engine):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w)
    assert "must follow" in refused(engine, "UPDATE invoices SET status = 'draft' WHERE id = :id", id=invoice)
    assert row(engine, invoice).status == "issued"
    assert "must follow" in refused(engine, "UPDATE invoices SET status = 'paid', paid_total = total WHERE id = :id", id=invoice)
    assert "must follow" in refused(engine, "UPDATE invoices SET paid_total = 5 WHERE id = :id", id=invoice)
    assert "must follow" in refused(engine, "UPDATE invoices SET status = 'partially_paid' WHERE id = :id", id=invoice)
    assert row(engine, invoice).status == "issued"


def test_invoices_are_never_deleted(engine):
    w = confirmed_world(engine)
    draft, issued = new_invoice(engine, w), issued_invoice(engine, w)
    for invoice in (draft, issued):
        assert "never deleted" in refused(engine, "DELETE FROM invoices WHERE id = :id", id=invoice)
    assert run(engine, "SELECT count(*) FROM invoices WHERE id IN (:a, :b)", a=draft, b=issued).scalar() == 2


def test_a_void_invoice_is_kept_for_history_and_can_never_change(engine):
    w = confirmed_world(engine)
    invoice = new_invoice(engine, w)
    run(engine, "UPDATE invoices SET status = 'void', voided_at = now(), voided_by_email = 'a@b.c' WHERE id = :id", id=invoice)  # a draft needs no reason
    for sql in ("status = 'draft'", "status = 'issued'", "notes = 'x'", "total = 5", "void_reason = 'later'"):
        assert "kept for history" in refused(engine, f"UPDATE invoices SET {sql} WHERE id = :id", id=invoice)


def test_voiding_needs_the_time_and_the_person_and_an_issued_invoice_needs_a_reason(engine):
    w = confirmed_world(engine)
    draft, issued = new_invoice(engine, w), issued_invoice(engine, w)
    assert refused(engine, "UPDATE invoices SET status = 'void' WHERE id = :id", id=draft)  # nobody, never
    assert refused(engine, "UPDATE invoices SET status = 'void', voided_at = now(), voided_by_email = 'a@b.c' WHERE id = :id", id=issued)  # no reason
    run(engine, "UPDATE invoices SET status = 'void', voided_at = now(), voided_by_email = 'a@b.c', void_reason = 'wrong client' WHERE id = :id", id=issued)
    assert row(engine, issued).status == "void"
    assert refused(engine, "UPDATE invoices SET void_reason = 'x' WHERE id = :id", id=draft)  # a reason belongs to a void invoice only


def test_an_invoice_with_payments_cannot_be_voided(engine):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w)
    payment = pay(engine, w, invoice, "5")
    void = "UPDATE invoices SET status = 'void', voided_at = now(), voided_by_email = 'a@b.c', void_reason = 'oops' WHERE id = :id"
    assert "payments on record" in refused(engine, void, id=invoice)
    pay(engine, w, invoice, "5", kind="reversal", reverses=payment, notes="entered twice")
    run(engine, void, id=invoice)  # the net is zero again: the history stays, the invoice can go
    assert row(engine, invoice).status == "void"
    assert run(engine, "SELECT count(*) FROM invoice_payments WHERE invoice_id = :i", i=invoice).scalar() == 2


def test_a_paid_invoice_cannot_be_voided_either(engine):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w, price="1")
    pay(engine, w, invoice, "10")
    assert row(engine, invoice).status == "paid"
    assert "payments on record" in refused(engine, "UPDATE invoices SET status = 'void', voided_at = now(), voided_by_email = 'a@b.c', void_reason = 'oops' WHERE id = :id", id=invoice)


# =====================================================================================================
# Lines and allocations
# =====================================================================================================
def test_line_arithmetic_is_checked_by_the_database(engine):
    w = confirmed_world(engine)
    invoice = new_invoice(engine, w)
    base = ("INSERT INTO invoice_lines (organization_id, invoice_id, product_id, product_sku, product_name, unit, quantity, unit_price, discount_amount, tax_rate, "
            "line_subtotal, line_net, line_tax, line_total) VALUES (:o, :i, :p, 'S', 'N', 'pcs', {values})")
    common = dict(o=w["org"], i=invoice, p=w["products"][0])
    run(engine, base.format(values="3, 0.3333, 0, 7.5, 0.9999, 0.9999, 0.0750, 1.0749"), **common)  # 0.9999 x 7.5% = 0.07499 -> 0.0750
    for bad in (
        "3, 0.3333, 0, 0, 1.0000, 1.0000, 0, 1.0000",  # subtotal is not quantity x price
        "3, 0.3333, 1, 0, 0.9999, 0.9999, 0, 0.9999",  # net ignores the discount
        "3, 0.3333, 0, 7.5, 0.9999, 0.9999, 0.0749, 1.0748",  # tax rounded the wrong way
        "3, 0.3333, 0, 7.5, 0.9999, 0.9999, 0.0750, 1.0000",  # total is not net + tax
        "3, 0.3333, 5, 0, 0.9999, -4.0001, 0, -4.0001",  # discount larger than the line
        "0, 0.3333, 0, 0, 0, 0, 0, 0",  # no quantity
        "3, -1, 0, 0, -3, -3, 0, -3",  # negative price
        "3, 0.3333, 0, 101, 0.9999, 0.9999, 1.0099, 2.0098",  # tax above 100 %
    ):
        assert refused(engine, base.format(values=bad), **common), bad


def test_lines_and_allocations_of_an_issued_invoice_are_frozen(engine):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w)
    assert "frozen" in refused(engine, "UPDATE invoice_lines SET unit_price = 1 WHERE invoice_id = :i", i=invoice)
    assert "frozen" in refused(engine, "DELETE FROM invoice_lines WHERE invoice_id = :i", i=invoice)
    assert "frozen" in refused(engine, "DELETE FROM invoice_allocations WHERE invoice_id = :i", i=invoice)
    assert "frozen" in refused(engine, "UPDATE invoice_allocations SET quantity = 1 WHERE invoice_id = :i", i=invoice)
    assert "frozen" in refused(engine,
        "INSERT INTO invoice_lines (organization_id, invoice_id, product_id, product_sku, product_name, unit, quantity, unit_price, line_subtotal, line_net, line_tax, line_total) "
        "VALUES (:o, :i, :p, 'S', 'N', 'pcs', 1, 1, 1, 1, 0, 1)", o=w["org"], i=invoice, p=w["products"][1])


def test_the_lines_of_a_draft_can_be_replaced(engine):
    w = confirmed_world(engine)
    invoice = new_invoice(engine, w)
    add_invoice_line(engine, w, invoice)
    run(engine, "DELETE FROM invoice_allocations WHERE invoice_id = :i", i=invoice)
    run(engine, "DELETE FROM invoice_lines WHERE invoice_id = :i", i=invoice)
    add_invoice_line(engine, w, invoice, quantity="4", price="3")
    totals(engine, invoice)
    assert row(engine, invoice).total == Decimal("12.0000")


def test_only_confirmed_dispatches_of_the_invoices_own_client_can_be_billed(engine):
    w = confirmed_world(engine)
    # another client of the same organization, with its own confirmed dispatch
    other = confirmed_world(engine, org=w["org"], number="DL-000002", dispatch_number="DS-000002")
    invoice = new_invoice(engine, w)
    line = add_invoice_line(engine, w, invoice, index=0)
    insert = "INSERT INTO invoice_allocations (organization_id, invoice_id, invoice_line_id, dispatch_line_id, quantity) VALUES (:o, :i, :l, :d, 1)"
    assert "own client" in refused(engine, insert, o=w["org"], i=invoice, l=line, d=other["lines"][0])
    # a dispatch that is only a draft, or still being posted, is not billable
    drafted = make_world(engine, org=w["org"], number="DL-000003")
    draft_dispatch = make_dispatch(engine, drafted, "DS-000003")
    draft_line = add_line(engine, drafted, draft_dispatch, 0, "5")
    draft_invoice = new_invoice(engine, drafted)
    draft_invoice_line = uuid.uuid4()
    run(engine,
        "INSERT INTO invoice_lines (id, organization_id, invoice_id, product_id, product_sku, product_name, unit, quantity, unit_price, line_subtotal, line_net, line_tax, line_total) "
        "VALUES (:id, :o, :i, :p, 'S', 'N', 'pcs', 1, 1, 1, 1, 0, 1)", id=draft_invoice_line, o=w["org"], i=draft_invoice, p=drafted["products"][0])
    assert "CONFIRMED" in refused(engine, insert, o=w["org"], i=draft_invoice, l=draft_invoice_line, d=draft_line)
    start_posting(engine, draft_dispatch)
    assert "CONFIRMED" in refused(engine, insert, o=w["org"], i=draft_invoice, l=draft_invoice_line, d=draft_line)
    assert run(engine, "SELECT count(*) FROM invoice_allocations WHERE invoice_id = :i", i=draft_invoice).scalar() == 0


def test_an_allocation_matches_the_dispatched_product_unit_and_quantity(engine):
    w = confirmed_world(engine)
    invoice = new_invoice(engine, w)
    line = add_invoice_line(engine, w, invoice, index=0, quantity="10")
    other_line = uuid.uuid4()
    run(engine,
        "INSERT INTO invoice_lines (id, organization_id, invoice_id, product_id, product_sku, product_name, unit, quantity, unit_price, line_subtotal, line_net, line_tax, line_total) "
        "VALUES (:id, :o, :i, :p, 'S', 'N', 'pcs', 1, 1, 1, 1, 0, 1)", id=other_line, o=w["org"], i=invoice, p=w["products"][0])
    insert = "INSERT INTO invoice_allocations (organization_id, invoice_id, invoice_line_id, dispatch_line_id, quantity) VALUES (:o, :i, :l, :d, :q)"
    assert "larger than" in refused(engine, insert, o=w["org"], i=invoice, l=other_line, d=w["lines"][0], q=Decimal("10.0001"))
    assert "product and unit" in refused(engine, insert, o=w["org"], i=invoice, l=other_line, d=w["lines"][1], q=Decimal("1"))  # the second item is another product
    assert refused(engine, insert, o=w["org"], i=invoice, l=other_line, d=w["lines"][0], q=Decimal("0"))
    assert refused(engine, insert, o=w["org"], i=invoice, l=line, d=w["lines"][0], q=Decimal("1"))  # the same pair twice
    run(engine, insert, o=w["org"], i=invoice, l=other_line, d=w["lines"][0], q=Decimal("1"))


def test_nothing_crosses_organizations(engine):
    w, stranger = confirmed_world(engine), confirmed_world(engine, dispatch_number="DS-000001")
    assert refused(engine, "INSERT INTO invoices (organization_id, client_id, invoice_date, due_date, currency_code, created_by, created_by_email) "
                           "VALUES (:o, :c, current_date, current_date, 'USD', gen_random_uuid(), 'a@b.c')", o=w["org"], c=stranger["client"])  # another organization's client
    invoice = new_invoice(engine, w)
    line = add_invoice_line(engine, w, invoice)
    assert refused(engine, "INSERT INTO invoice_allocations (organization_id, invoice_id, invoice_line_id, dispatch_line_id, quantity) VALUES (:o, :i, :l, :d, 1)",
                   o=w["org"], i=invoice, l=line, d=stranger["lines"][1])  # another organization's dispatch line
    assert refused(engine, "INSERT INTO invoice_payments (organization_id, invoice_id, payment_date, amount, currency_code, method, idempotency_key, request_hash, recorded_by, recorded_by_email) "
                           "VALUES (:o, :i, current_date, 1, 'USD', 'cash', 'key-x', 'h', gen_random_uuid(), 'a@b.c')", o=stranger["org"], i=invoice)  # a payment filed under the wrong organization


# =====================================================================================================
# Payments
# =====================================================================================================
def test_payments_move_the_balance_and_the_status_in_the_database(engine):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w)  # 10 x 2.5 = 25
    pay(engine, w, invoice, "10")
    assert tuple(row(engine, invoice)) == ("partially_paid", Decimal("10.0000"), Decimal("15.0000"), Decimal("25.0000"))
    pay(engine, w, invoice, "15")
    assert tuple(row(engine, invoice)) == ("paid", Decimal("25.0000"), Decimal("0.0000"), Decimal("25.0000"))


def test_a_payment_can_never_exceed_the_outstanding_amount(engine):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w)
    assert "cannot exceed" in refused(engine, "INSERT INTO invoice_payments (organization_id, invoice_id, payment_date, amount, currency_code, method, idempotency_key, request_hash, recorded_by, recorded_by_email) "
                                              "VALUES (:o, :i, current_date, 25.0001, 'USD', 'cash', 'key-over', 'h', gen_random_uuid(), 'a@b.c')", o=w["org"], i=invoice)
    pay(engine, w, invoice, "25")
    assert "issued invoice that is not yet paid" in refused(engine, "INSERT INTO invoice_payments (organization_id, invoice_id, payment_date, amount, currency_code, method, idempotency_key, request_hash, recorded_by, recorded_by_email) "
                                                                    "VALUES (:o, :i, current_date, 0.0001, 'USD', 'cash', 'key-more', 'h', gen_random_uuid(), 'a@b.c')", o=w["org"], i=invoice)


def test_only_an_issued_invoice_takes_payments_and_only_in_its_currency(engine):
    w = confirmed_world(engine)
    draft, issued = new_invoice(engine, w), issued_invoice(engine, w)
    assert "issued invoice" in refused(engine, "INSERT INTO invoice_payments (organization_id, invoice_id, payment_date, amount, currency_code, method, idempotency_key, request_hash, recorded_by, recorded_by_email) "
                                               "VALUES (:o, :i, current_date, 1, 'USD', 'cash', 'key-d', 'h', gen_random_uuid(), 'a@b.c')", o=w["org"], i=draft)
    with pytest.raises((DBAPIError, IntegrityError)) as caught:
        pay(engine, w, issued, "1", currency="EUR")
    assert "currency of its invoice" in str(caught.value.orig)
    for bad in ({"amount": "0"}, {"amount": "-1"}, {"method": "bitcoin"}, {"currency": "usd"}):
        with pytest.raises((DBAPIError, IntegrityError)):
            pay(engine, w, issued, **{"amount": "1", **bad})


def test_a_payment_is_append_only(engine):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w)
    payment = pay(engine, w, invoice, "10")
    for sql in ("UPDATE invoice_payments SET amount = 1 WHERE id = :id", "UPDATE invoice_payments SET notes = 'edited' WHERE id = :id", "DELETE FROM invoice_payments WHERE id = :id"):
        assert "never edited or deleted" in refused(engine, sql, id=payment)
    assert row(engine, invoice).paid_total == Decimal("10.0000")


def test_the_same_key_records_a_payment_once(engine):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w)
    pay(engine, w, invoice, "10", key="same-key-1")
    assert "idempotency_key" in refused(engine, "INSERT INTO invoice_payments (organization_id, invoice_id, payment_date, amount, currency_code, method, idempotency_key, request_hash, recorded_by, recorded_by_email) "
                                                "VALUES (:o, :i, current_date, 10, 'USD', 'cash', 'same-key-1', 'h', gen_random_uuid(), 'a@b.c')", o=w["org"], i=invoice)
    assert row(engine, invoice).paid_total == Decimal("10.0000")


def test_a_reversal_undoes_one_whole_payment_once_and_needs_a_reason(engine):
    w = confirmed_world(engine)
    invoice, other = issued_invoice(engine, w), issued_invoice(engine, w, number="INV-000002", quantity="4", price="1", index=1)
    payment, foreign = pay(engine, w, invoice, "10"), pay(engine, w, other, "1")
    insert = ("INSERT INTO invoice_payments (organization_id, invoice_id, kind, reverses_payment_id, payment_date, amount, currency_code, method, notes, idempotency_key, request_hash, recorded_by, recorded_by_email) "
              "VALUES (:o, :i, 'reversal', :r, current_date, :a, 'USD', 'cash', :n, :k, 'h', gen_random_uuid(), 'a@b.c')")
    assert "whole payment" in refused(engine, insert, o=w["org"], i=invoice, r=payment, a=Decimal("4"), n="part", k="rev-1")
    assert "same invoice" in refused(engine, insert, o=w["org"], i=invoice, r=foreign, a=Decimal("1"), n="wrong invoice", k="rev-2")
    assert refused(engine, insert, o=w["org"], i=invoice, r=payment, a=Decimal("10"), n=None, k="rev-3")  # no reason
    assert refused(engine, insert, o=w["org"], i=invoice, r=payment, a=Decimal("10"), n="", k="rev-4")
    reversal = pay(engine, w, invoice, "10", kind="reversal", reverses=payment, notes="entered twice")
    assert tuple(row(engine, invoice)) == ("issued", Decimal("0.0000"), Decimal("25.0000"), Decimal("25.0000"))
    assert refused(engine, insert, o=w["org"], i=invoice, r=payment, a=Decimal("10"), n="again", k="rev-5")  # a payment is reversed once
    assert "same invoice" in refused(engine, insert, o=w["org"], i=invoice, r=reversal, a=Decimal("10"), n="undo the undo", k="rev-6")  # a reversal cannot be reversed
    assert run(engine, "SELECT count(*) FROM invoice_payments WHERE invoice_id = :i", i=invoice).scalar() == 2


def test_a_payment_that_is_not_a_reversal_cannot_point_at_one_and_the_reverse(engine):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w)
    payment = pay(engine, w, invoice, "10")
    assert refused(engine, "INSERT INTO invoice_payments (organization_id, invoice_id, kind, reverses_payment_id, payment_date, amount, currency_code, method, idempotency_key, request_hash, recorded_by, recorded_by_email) "
                           "VALUES (:o, :i, 'payment', :r, current_date, 1, 'USD', 'cash', 'k-1', 'h', gen_random_uuid(), 'a@b.c')", o=w["org"], i=invoice, r=payment)
    assert refused(engine, "INSERT INTO invoice_payments (organization_id, invoice_id, kind, payment_date, amount, currency_code, method, notes, idempotency_key, request_hash, recorded_by, recorded_by_email) "
                           "VALUES (:o, :i, 'reversal', current_date, 1, 'USD', 'cash', 'x', 'k-2', 'h', gen_random_uuid(), 'a@b.c')", o=w["org"], i=invoice)


def test_a_reversed_paid_invoice_returns_to_issued_and_can_be_paid_again(engine):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w, price="1")
    payment = pay(engine, w, invoice, "10")
    assert row(engine, invoice).status == "paid"
    pay(engine, w, invoice, "10", kind="reversal", reverses=payment, notes="bounced cheque")
    assert row(engine, invoice).status == "issued"
    pay(engine, w, invoice, "10")
    assert row(engine, invoice).status == "paid"


def test_simultaneous_payments_cannot_exceed_the_invoice(engine):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w)  # 25
    outcomes = []

    def go():
        try:
            pay(engine, w, invoice, "10")
            outcomes.append("recorded")
        except (DBAPIError, IntegrityError):
            outcomes.append("refused")

    threads = [threading.Thread(target=go) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(outcomes) == ["recorded", "recorded", "refused", "refused", "refused", "refused"]
    assert tuple(row(engine, invoice)) == ("partially_paid", Decimal("20.0000"), Decimal("5.0000"), Decimal("25.0000"))


def test_the_outstanding_amount_is_computed_by_the_database(engine):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w)
    assert refused(engine, "UPDATE invoices SET outstanding = 0 WHERE id = :id", id=invoice)


# =====================================================================================================
# Maintenance
# =====================================================================================================
def test_only_the_maintenance_switch_allows_the_records_to_be_cleaned_up(engine):
    w = confirmed_world(engine)
    invoice = issued_invoice(engine, w)
    pay(engine, w, invoice, "5")
    with engine.begin() as conn:
        conn.execute(text("SET LOCAL app.allow_ledger_maintenance = 'on'"))
        for table in ("invoice_payments", "invoice_allocations", "invoice_lines", "invoices"):
            conn.execute(text(f"DELETE FROM {table} WHERE {'id' if table == 'invoices' else 'invoice_id'} = :i"), {"i": invoice})
    assert run(engine, "SELECT count(*) FROM invoices WHERE id = :i", i=invoice).scalar() == 0
    other = new_invoice(engine, w)
    assert "never deleted" in refused(engine, "DELETE FROM invoices WHERE id = :i", i=other)  # the switch is per transaction: gone again
