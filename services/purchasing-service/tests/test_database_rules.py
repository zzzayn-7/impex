"""Rules the DATABASE enforces by itself, with the API bypassed (raw SQL): the order's life cycle and line freeze (including the
Step 16B correction: a line can never be moved between orders or organizations), and goods receipts, their immutability and the
no-over-receipt rule."""
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

PRODUCT_A, PRODUCT_B = uuid.uuid4(), uuid.uuid4()


def run(engine, sql, **params):
    with engine.begin() as conn:
        return conn.execute(text(sql), params)


def refused(engine, sql, **params) -> str:
    with pytest.raises(DBAPIError) as caught:
        run(engine, sql, **params)
    return str(caught.value.orig)


def make_world(engine, quantities=("10", "5"), status="ordered", org=None, number="PO-000001"):
    """A supplier and a purchase order with one line per quantity (products differ), then placed (unless status='draft')."""
    org = org or uuid.uuid4()
    supplier, order = uuid.uuid4(), uuid.uuid4()
    lines = [uuid.uuid4() for _ in quantities]
    products = [uuid.uuid4() for _ in quantities]
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO suppliers (id, organization_id, name, name_key) VALUES (:s, :o, :n, :n)"), {"s": supplier, "o": org, "n": f"Supplier {order}"})
        conn.execute(text(
            "INSERT INTO purchase_orders (id, organization_id, supplier_id, number, order_date, currency_code, created_by, created_by_email) "
            "VALUES (:id, :o, :s, :n, current_date, 'USD', :u, 'a@b.c')"), {"id": order, "o": org, "s": supplier, "n": number, "u": uuid.uuid4()})
        for line, product, quantity in zip(lines, products, quantities):
            conn.execute(text(
                "INSERT INTO purchase_order_lines (id, organization_id, purchase_order_id, product_id, product_sku, product_name, unit, quantity, unit_price, line_total) "
                "VALUES (:id, :o, :po, :p, 'SKU', 'Thing', 'pcs', :q, 1, :q)"), {"id": line, "o": org, "po": order, "p": product, "q": Decimal(quantity)})
        if status != "draft":
            conn.execute(text("UPDATE purchase_orders SET status = 'ordered', ordered_at = now(), ordered_by_email = 'a@b.c' WHERE id = :id"), {"id": order})
    if status == "cancelled":
        run(engine, "UPDATE purchase_orders SET status = 'cancelled', cancelled_at = now(), cancelled_by_email = 'a@b.c' WHERE id = :id", id=order)
    return {"org": org, "supplier": supplier, "order": order, "lines": lines, "products": products}


def status_of(engine, table, row_id) -> str:
    return run(engine, f"SELECT status FROM {table} WHERE id = :id", id=row_id).scalar()


def make_receipt(engine, world, number="GR-000001"):
    receipt = uuid.uuid4()
    run(engine,
        "INSERT INTO goods_receipts (id, organization_id, purchase_order_id, number, received_date, posting_key, created_by, created_by_email) "
        "VALUES (:id, :o, :po, :n, current_date, 'goods-receipt-' || CAST(:id AS text), :u, 'a@b.c')",
        id=receipt, o=world["org"], po=world["order"], n=number, u=uuid.uuid4())
    return receipt


def add_line(engine, world, receipt, index=0, accepted="3", rejected="0", unit="pcs", product=None, order_line=None):
    line = uuid.uuid4()
    run(engine,
        "INSERT INTO goods_receipt_lines (id, organization_id, goods_receipt_id, purchase_order_line_id, product_id, product_sku, product_name, unit, "
        "accepted_quantity, rejected_quantity) VALUES (:id, :o, :r, :pl, :p, 'SKU', 'Thing', :unit, :a, :j)",
        id=line, o=world["org"], r=receipt, pl=order_line or world["lines"][index], p=product or world["products"][index], unit=unit,
        a=Decimal(accepted), j=Decimal(rejected))
    return line


def start_posting(engine, receipt):
    run(engine, "UPDATE goods_receipts SET status = 'posting', posting_started_at = now(), posting_attempts = 1 WHERE id = :id", id=receipt)


def confirm(engine, receipt):
    run(engine, "UPDATE goods_receipt_lines SET inventory_movement_id = gen_random_uuid() WHERE goods_receipt_id = :id AND accepted_quantity > 0", id=receipt)
    run(engine, "UPDATE goods_receipts SET status = 'confirmed', inventory_operation_id = gen_random_uuid(), confirmed_at = now(), confirmed_by_email = 'a@b.c' WHERE id = :id", id=receipt)


# =====================================================================================================
# Step 16B correction: a purchase-order line can never be moved to another order or organization
# =====================================================================================================
def test_a_line_of_an_ordered_order_cannot_be_moved_to_a_draft_order(engine):
    ordered, draft = make_world(engine), make_world(engine, quantities=("7",), status="draft", number="PO-000002")
    moved = ordered["lines"][0]
    message = refused(engine, "UPDATE purchase_order_lines SET purchase_order_id = :d WHERE id = :l", d=draft["order"], l=moved)
    assert "cannot be moved" in message
    # the same-organization version of the attack, where the composite foreign key would accept the new order
    same_org = make_world(engine, quantities=("7",), status="draft", org=ordered["org"], number="PO-000003")
    assert "cannot be moved" in refused(engine, "UPDATE purchase_order_lines SET purchase_order_id = :d WHERE id = :l", d=same_org["order"], l=moved)
    assert run(engine, "SELECT purchase_order_id FROM purchase_order_lines WHERE id = :l", l=moved).scalar() == ordered["order"]


def test_a_line_of_a_draft_order_cannot_be_moved_into_an_ordered_order(engine):
    org = uuid.uuid4()
    ordered, draft = make_world(engine, org=org), make_world(engine, quantities=("7",), status="draft", org=org, number="PO-000002")
    assert "cannot be moved" in refused(engine, "UPDATE purchase_order_lines SET purchase_order_id = :o WHERE id = :l", o=ordered["order"], l=draft["lines"][0])


def test_a_line_of_a_cancelled_order_cannot_be_moved_either(engine):
    org = uuid.uuid4()
    cancelled, draft = make_world(engine, status="cancelled", org=org), make_world(engine, quantities=("7",), status="draft", org=org, number="PO-000002")
    assert "cannot be moved" in refused(engine, "UPDATE purchase_order_lines SET purchase_order_id = :d WHERE id = :l", d=draft["order"], l=cancelled["lines"][0])


def test_a_line_cannot_change_organization_or_id(engine):
    one, two = make_world(engine, status="draft"), make_world(engine, quantities=("7",), status="draft", number="PO-000002")
    for sql, params in (
        ("UPDATE purchase_order_lines SET organization_id = :o WHERE id = :l", {"o": two["org"], "l": one["lines"][0]}),
        ("UPDATE purchase_order_lines SET id = gen_random_uuid() WHERE id = :l", {"l": one["lines"][0]}),
        ("UPDATE purchase_order_lines SET organization_id = :o, purchase_order_id = :po WHERE id = :l", {"o": two["org"], "po": two["order"], "l": one["lines"][0]}),
    ):
        assert "cannot be moved" in refused(engine, sql, **params)


def test_a_line_of_a_draft_order_can_still_be_edited_in_place(engine):
    draft = make_world(engine, status="draft")
    run(engine, "UPDATE purchase_order_lines SET quantity = 12, line_total = 12 WHERE id = :l", l=draft["lines"][0])
    assert run(engine, "SELECT quantity FROM purchase_order_lines WHERE id = :l", l=draft["lines"][0]).scalar() == Decimal("12")


def test_the_identity_of_an_order_never_changes_even_while_it_is_a_draft(engine):
    draft = make_world(engine, status="draft")
    for column, value in (("id", "gen_random_uuid()"), ("organization_id", "gen_random_uuid()"), ("number", "'PO-424242'"), ("created_by", "gen_random_uuid()")):
        assert "identity" in refused(engine, f"UPDATE purchase_orders SET {column} = {value} WHERE id = :id", id=draft["order"]), column


# =====================================================================================================
# The order's statuses
# =====================================================================================================
def test_the_only_moves_are_the_documented_ones(engine):
    draft, ordered = make_world(engine, status="draft"), make_world(engine, number="PO-000002")
    assert "can only be placed or cancelled" in refused(engine, "UPDATE purchase_orders SET status = 'received' WHERE id = :id", id=draft["order"])
    assert "can only be placed or cancelled" in refused(engine, "UPDATE purchase_orders SET status = 'partially_received' WHERE id = :id", id=draft["order"])
    assert "cannot" in refused(engine, "UPDATE purchase_orders SET status = 'draft' WHERE id = :id", id=ordered["order"])
    cancelled = make_world(engine, status="cancelled", number="PO-000003")
    for target in ("ordered", "draft", "received", "partially_received"):
        assert "cannot" in refused(engine, "UPDATE purchase_orders SET status = :t WHERE id = :id", t=target, id=cancelled["order"])


def test_an_order_is_partially_received_or_received_only_when_the_confirmed_receipts_say_so(engine):
    w = make_world(engine, quantities=("10", "5"))
    assert "some, but not all" in refused(engine, "UPDATE purchase_orders SET status = 'partially_received' WHERE id = :id", id=w["order"])
    assert "fully received" in refused(engine, "UPDATE purchase_orders SET status = 'received' WHERE id = :id", id=w["order"])

    first = make_receipt(engine, w)
    add_line(engine, w, first, 0, "10")
    start_posting(engine, first)
    # a receipt that is only being posted does not count as received
    assert "some, but not all" in refused(engine, "UPDATE purchase_orders SET status = 'partially_received' WHERE id = :id", id=w["order"])
    confirm(engine, first)
    assert "fully received" in refused(engine, "UPDATE purchase_orders SET status = 'received' WHERE id = :id", id=w["order"])
    run(engine, "UPDATE purchase_orders SET status = 'partially_received' WHERE id = :id", id=w["order"])

    second = make_receipt(engine, w, "GR-000002")
    add_line(engine, w, second, 1, "5")
    start_posting(engine, second)
    confirm(engine, second)
    run(engine, "UPDATE purchase_orders SET status = 'received' WHERE id = :id", id=w["order"])
    for target in ("ordered", "partially_received", "cancelled", "draft"):
        assert "cannot" in refused(engine, "UPDATE purchase_orders SET status = :t WHERE id = :id", t=target, id=w["order"])


def test_an_order_with_goods_received_or_being_received_cannot_be_cancelled(engine):
    posting, confirmed, quiet = make_world(engine), make_world(engine, number="PO-000002"), make_world(engine, number="PO-000003")
    receipt = make_receipt(engine, posting)
    add_line(engine, posting, receipt, 0, "2")
    start_posting(engine, receipt)
    assert "cannot be cancelled" in refused(engine, "UPDATE purchase_orders SET status = 'cancelled', cancelled_at = now() WHERE id = :id", id=posting["order"])

    receipt = make_receipt(engine, confirmed, "GR-000002")
    add_line(engine, confirmed, receipt, 0, "2")
    start_posting(engine, receipt)
    confirm(engine, receipt)
    run(engine, "UPDATE purchase_orders SET status = 'partially_received' WHERE id = :id", id=confirmed["order"])
    assert "cannot" in refused(engine, "UPDATE purchase_orders SET status = 'cancelled', cancelled_at = now() WHERE id = :id", id=confirmed["order"])

    make_receipt(engine, quiet, "GR-000003")  # only a draft receipt: the order may still be cancelled
    run(engine, "UPDATE purchase_orders SET status = 'cancelled', cancelled_at = now(), cancelled_by_email = 'a@b.c' WHERE id = :id", id=quiet["order"])


def test_the_lines_of_received_orders_are_frozen_too(engine):
    w = make_world(engine, quantities=("4",))
    receipt = make_receipt(engine, w)
    add_line(engine, w, receipt, 0, "4")
    start_posting(engine, receipt)
    confirm(engine, receipt)
    run(engine, "UPDATE purchase_orders SET status = 'received' WHERE id = :id", id=w["order"])
    assert "frozen" in refused(engine, "UPDATE purchase_order_lines SET quantity = 99, line_total = 99 WHERE id = :l", l=w["lines"][0])
    assert "frozen" in refused(engine, "DELETE FROM purchase_order_lines WHERE id = :l", l=w["lines"][0])
    assert "frozen" in refused(engine, "UPDATE purchase_orders SET notes = 'x' WHERE id = :id", id=w["order"])


# =====================================================================================================
# Goods receipts
# =====================================================================================================
def test_receipts_exist_only_against_ordered_or_partially_received_orders(engine):
    for status in ("draft", "cancelled"):
        w = make_world(engine, status=status, number=f"PO-{status}")
        assert "Ordered or Partially Received" in refused(
            engine,
            "INSERT INTO goods_receipts (id, organization_id, purchase_order_id, number, received_date, posting_key, created_by, created_by_email) "
            "VALUES (:id, :o, :po, 'GR-X', current_date, 'goods-receipt-' || CAST(:id AS text), :u, 'a@b.c')",
            id=uuid.uuid4(), o=w["org"], po=w["order"], u=uuid.uuid4())
    make_receipt(engine, make_world(engine, number="PO-ok"))


def test_a_receipt_starts_as_a_draft_and_its_key_comes_from_its_id(engine):
    w = make_world(engine)
    base = ("INSERT INTO goods_receipts (id, organization_id, purchase_order_id, number, received_date, posting_key, created_by, created_by_email{extra}) "
            "VALUES (:id, :o, :po, 'GR-X', current_date, {key}, :u, 'a@b.c'{values})")
    ident = uuid.uuid4()
    common = dict(id=ident, o=w["org"], po=w["order"], u=uuid.uuid4())
    assert "starts as a draft" in refused(engine, base.format(extra=", status", key="'goods-receipt-' || CAST(:id AS text)", values=", 'confirmed'"), **common)
    assert "posting_key_from_id" in refused(engine, base.format(extra="", key="'something-else-entirely'", values=""), **common)


def test_receipts_are_never_deleted(engine):
    w = make_world(engine)
    receipt = make_receipt(engine, w)
    line = add_line(engine, w, receipt)
    assert "never deleted" in refused(engine, "DELETE FROM goods_receipts WHERE id = :id", id=receipt)
    run(engine, "DELETE FROM goods_receipt_lines WHERE id = :id", id=line)  # a draft's line may be removed
    assert status_of(engine, "goods_receipts", receipt) == "draft"


def test_the_maintenance_switch_lets_verification_scripts_clean_up_their_own_data(engine):
    w = make_world(engine)
    receipt = make_receipt(engine, w)
    add_line(engine, w, receipt, 0, "2")
    start_posting(engine, receipt)
    confirm(engine, receipt)
    with engine.begin() as conn:
        conn.execute(text("SET LOCAL app.allow_ledger_maintenance = 'on'"))
        conn.execute(text("DELETE FROM goods_receipt_lines WHERE goods_receipt_id = :id"), {"id": receipt})
        conn.execute(text("DELETE FROM goods_receipts WHERE id = :id"), {"id": receipt})
    assert run(engine, "SELECT count(*) FROM goods_receipts WHERE id = :id", id=receipt).scalar() == 0


def test_a_receipt_line_must_be_on_the_receipts_order_with_the_same_product_and_unit(engine):
    w, other = make_world(engine), make_world(engine, number="PO-000002")
    receipt = make_receipt(engine, w)
    assert "not on the purchase order" in refused(
        engine,
        "INSERT INTO goods_receipt_lines (organization_id, goods_receipt_id, purchase_order_line_id, product_id, product_sku, product_name, unit, accepted_quantity) "
        "VALUES (:o, :r, :pl, :p, 'S', 'N', 'pcs', 1)", o=w["org"], r=receipt, pl=other["lines"][0], p=other["products"][0])
    assert "product and the unit" in refused(
        engine,
        "INSERT INTO goods_receipt_lines (organization_id, goods_receipt_id, purchase_order_line_id, product_id, product_sku, product_name, unit, accepted_quantity) "
        "VALUES (:o, :r, :pl, gen_random_uuid(), 'S', 'N', 'pcs', 1)", o=w["org"], r=receipt, pl=w["lines"][0])
    assert "product and the unit" in str(refused_call(engine, w, receipt, unit="kg"))


def refused_call(engine, w, receipt, **kwargs):
    with pytest.raises(DBAPIError) as caught:
        add_line(engine, w, receipt, **kwargs)
    return caught.value.orig


def test_a_receipt_line_cannot_cross_organizations(engine):
    w, other = make_world(engine), make_world(engine, number="PO-000002")
    receipt = make_receipt(engine, w)
    with pytest.raises(DBAPIError):
        run(engine,
            "INSERT INTO goods_receipt_lines (organization_id, goods_receipt_id, purchase_order_line_id, product_id, product_sku, product_name, unit, accepted_quantity) "
            "VALUES (:o, :r, :pl, :p, 'S', 'N', 'pcs', 1)", o=other["org"], r=receipt, pl=w["lines"][0], p=w["products"][0])


def test_quantity_rules_on_a_line(engine):
    w = make_world(engine)
    receipt = make_receipt(engine, w)
    with pytest.raises(DBAPIError):
        add_line(engine, w, receipt, accepted="0", rejected="0")  # nothing at all
    with pytest.raises(DBAPIError):
        add_line(engine, w, receipt, accepted="-1")
    add_line(engine, w, receipt, accepted="0", rejected="2")  # all rejected: fine


def test_one_line_per_order_line_per_receipt(engine):
    w = make_world(engine)
    receipt = make_receipt(engine, w)
    add_line(engine, w, receipt)
    with pytest.raises(DBAPIError):
        add_line(engine, w, receipt)


def test_nothing_can_be_confirmed_that_accepts_no_goods(engine):
    w = make_world(engine)
    receipt = make_receipt(engine, w)
    add_line(engine, w, receipt, accepted="0", rejected="2")
    assert "accepts nothing" in refused(engine, "UPDATE goods_receipts SET status = 'posting', posting_started_at = now() WHERE id = :id", id=receipt)
    empty = make_receipt(engine, w, "GR-000002")
    assert "accepts nothing" in refused(engine, "UPDATE goods_receipts SET status = 'posting', posting_started_at = now() WHERE id = :id", id=empty)


def test_more_than_was_ordered_can_never_be_received(engine):
    w = make_world(engine, quantities=("10",))
    too_much = make_receipt(engine, w)
    add_line(engine, w, too_much, accepted="10.0001")
    assert "exceed" in refused(engine, "UPDATE goods_receipts SET status = 'posting', posting_started_at = now() WHERE id = :id", id=too_much)

    first, second = make_receipt(engine, w, "GR-000002"), make_receipt(engine, w, "GR-000003")
    add_line(engine, w, first, accepted="6")
    add_line(engine, w, second, accepted="6")
    start_posting(engine, first)  # reserves 6 of 10, although nothing is confirmed yet
    assert "exceed" in refused(engine, "UPDATE goods_receipts SET status = 'posting', posting_started_at = now() WHERE id = :id", id=second)
    run(engine, "UPDATE goods_receipt_lines SET accepted_quantity = 4 WHERE goods_receipt_id = :id", id=second)
    start_posting(engine, second)  # exactly the remaining 4
    assert status_of(engine, "goods_receipts", second) == "posting"


def test_a_rejected_posting_returns_the_reservation(engine):
    w = make_world(engine, quantities=("10",))
    first, second = make_receipt(engine, w), make_receipt(engine, w, "GR-000002")
    add_line(engine, w, first, accepted="8")
    add_line(engine, w, second, accepted="8")
    start_posting(engine, first)
    run(engine, "UPDATE goods_receipts SET status = 'draft' WHERE id = :id", id=first)  # Inventory definitively refused
    start_posting(engine, second)


def test_concurrent_receipts_cannot_both_reserve_the_same_goods(engine):
    import threading

    w = make_world(engine, quantities=("10",))
    receipts = []
    for index in range(4):
        receipt = make_receipt(engine, w, f"GR-00000{index + 1}")
        add_line(engine, w, receipt, accepted="4")
        receipts.append(receipt)
    outcomes = []

    def start(receipt):
        try:
            start_posting(engine, receipt)
            outcomes.append("posting")
        except DBAPIError:
            outcomes.append("refused")

    threads = [threading.Thread(target=start, args=(r,)) for r in receipts]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert sorted(outcomes) == ["posting", "posting", "refused", "refused"]  # 4 + 4 fits in 10, a third 4 does not


def test_a_receipt_is_not_confirmed_until_every_accepted_line_has_its_movement(engine):
    w = make_world(engine)
    receipt = make_receipt(engine, w)
    first = add_line(engine, w, receipt, 0, "3")
    add_line(engine, w, receipt, 1, "0", "1")
    start_posting(engine, receipt)
    confirmed = "UPDATE goods_receipts SET status = 'confirmed', inventory_operation_id = gen_random_uuid(), confirmed_at = now(), confirmed_by_email = 'a@b.c' WHERE id = :id"
    assert "before every accepted line" in refused(engine, confirmed, id=receipt)
    run(engine, "UPDATE goods_receipt_lines SET inventory_movement_id = gen_random_uuid() WHERE id = :id", id=first)
    run(engine, confirmed, id=receipt)  # the rejected-only line needs no movement
    assert status_of(engine, "goods_receipts", receipt) == "confirmed"


def test_confirmed_needs_the_inventory_operation_and_a_time(engine):
    w = make_world(engine)
    receipt = make_receipt(engine, w)
    add_line(engine, w, receipt)
    start_posting(engine, receipt)
    run(engine, "UPDATE goods_receipt_lines SET inventory_movement_id = gen_random_uuid() WHERE goods_receipt_id = :id", id=receipt)
    with pytest.raises(DBAPIError):
        run(engine, "UPDATE goods_receipts SET status = 'confirmed' WHERE id = :id", id=receipt)
    with pytest.raises(DBAPIError):  # an operation id on a receipt that is not confirmed
        run(engine, "UPDATE goods_receipts SET inventory_operation_id = gen_random_uuid() WHERE id = :id", id=receipt)


def test_a_confirmed_receipt_can_never_be_changed_or_deleted(engine):
    w = make_world(engine)
    receipt = make_receipt(engine, w)
    line = add_line(engine, w, receipt)
    start_posting(engine, receipt)
    confirm(engine, receipt)
    for sql in (
        "UPDATE goods_receipts SET notes = 'edited' WHERE id = :id",
        "UPDATE goods_receipts SET status = 'draft' WHERE id = :id",
        "UPDATE goods_receipts SET status = 'cancelled', cancelled_at = now() WHERE id = :id",
        "UPDATE goods_receipts SET status = 'posting' WHERE id = :id",
        "UPDATE goods_receipts SET received_date = current_date - 1 WHERE id = :id",
        "UPDATE goods_receipts SET inventory_operation_id = gen_random_uuid() WHERE id = :id",
        "UPDATE goods_receipts SET confirmed_at = now() WHERE id = :id",
        "DELETE FROM goods_receipts WHERE id = :id",
    ):
        assert "never" in refused(engine, sql, id=receipt), sql
    for sql in (
        "UPDATE goods_receipt_lines SET accepted_quantity = 99 WHERE id = :l",
        "UPDATE goods_receipt_lines SET rejected_quantity = 5 WHERE id = :l",
        "UPDATE goods_receipt_lines SET inventory_movement_id = gen_random_uuid() WHERE id = :l",
        "UPDATE goods_receipt_lines SET notes = 'x' WHERE id = :l",
        "DELETE FROM goods_receipt_lines WHERE id = :l",
    ):
        assert "confirmed" in refused(engine, sql, l=line), sql
    with pytest.raises(DBAPIError):
        add_line(engine, w, receipt, 1, "1")  # no new line either


def test_a_receipt_being_posted_is_frozen_except_for_its_bookkeeping_and_the_movement_ids(engine):
    w = make_world(engine)
    receipt = make_receipt(engine, w)
    line = add_line(engine, w, receipt)
    start_posting(engine, receipt)
    assert "frozen" in refused(engine, "UPDATE goods_receipts SET notes = 'x' WHERE id = :id", id=receipt)
    assert "frozen" in refused(engine, "UPDATE goods_receipts SET received_date = current_date - 3 WHERE id = :id", id=receipt)
    assert "frozen" in refused(engine, "UPDATE goods_receipt_lines SET accepted_quantity = 1 WHERE id = :l", l=line)
    assert "frozen" in refused(engine, "UPDATE goods_receipt_lines SET rejected_quantity = 5 WHERE id = :l", l=line)
    assert "cannot be removed" in refused(engine, "DELETE FROM goods_receipt_lines WHERE id = :l", l=line)
    assert "draft" in refused(engine, "INSERT INTO goods_receipt_lines (organization_id, goods_receipt_id, purchase_order_line_id, product_id, product_sku, product_name, unit, accepted_quantity) "
                                      "VALUES (:o, :r, :pl, :p, 'S', 'N', 'pcs', 1)", o=w["org"], r=receipt, pl=w["lines"][1], p=w["products"][1])
    run(engine, "UPDATE goods_receipts SET posting_attempts = 2, last_posting_error = 'timeout', last_posting_attempt_at = now() WHERE id = :id", id=receipt)
    run(engine, "UPDATE goods_receipt_lines SET inventory_movement_id = gen_random_uuid() WHERE id = :l", l=line)
    assert "frozen" in refused(engine, "UPDATE goods_receipt_lines SET inventory_movement_id = gen_random_uuid() WHERE id = :l", l=line)  # only once


def test_a_draft_receipt_can_be_edited_and_cancelled_and_a_cancelled_one_stays(engine):
    w = make_world(engine)
    receipt = make_receipt(engine, w)
    line = add_line(engine, w, receipt)
    run(engine, "UPDATE goods_receipts SET notes = 'counted twice', supplier_reference = 'DN-7' WHERE id = :id", id=receipt)
    run(engine, "UPDATE goods_receipt_lines SET accepted_quantity = 5, rejected_quantity = 1 WHERE id = :l", l=line)
    assert "can only be confirmed (posted) or cancelled" in refused(engine, "UPDATE goods_receipts SET status = 'confirmed' WHERE id = :id", id=receipt)
    run(engine, "UPDATE goods_receipts SET status = 'cancelled', cancelled_at = now(), cancelled_by_email = 'a@b.c' WHERE id = :id", id=receipt)
    assert "never" in refused(engine, "UPDATE goods_receipts SET status = 'draft' WHERE id = :id", id=receipt)
    assert "never" in refused(engine, "UPDATE goods_receipts SET notes = 'again' WHERE id = :id", id=receipt)


def test_a_receipt_cannot_be_reassigned_to_another_order_or_organization(engine):
    w, other = make_world(engine), make_world(engine, number="PO-000002")
    receipt = make_receipt(engine, w)
    for sql, params in (
        ("UPDATE goods_receipts SET purchase_order_id = :po WHERE id = :id", {"po": other["order"]}),
        ("UPDATE goods_receipts SET organization_id = :o WHERE id = :id", {"o": other["org"]}),
        ("UPDATE goods_receipts SET number = 'GR-999' WHERE id = :id", {}),
        ("UPDATE goods_receipts SET posting_key = 'goods-receipt-' || CAST(gen_random_uuid() AS text) WHERE id = :id", {}),
    ):
        with pytest.raises(DBAPIError):
            run(engine, sql, id=receipt, **params)


def test_numbers_and_keys_are_unique_per_organization(engine):
    w = make_world(engine)
    make_receipt(engine, w, "GR-000001")
    with pytest.raises(DBAPIError):
        make_receipt(engine, w, "GR-000001")
    other = make_world(engine, number="PO-000002")
    make_receipt(engine, other, "GR-000001")  # same number in another organization: fine
