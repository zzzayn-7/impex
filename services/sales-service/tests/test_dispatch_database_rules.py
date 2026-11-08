"""Rules the DATABASE enforces by itself, with the API bypassed (raw SQL): the delivery list's life cycle and the freeze of its items,
dispatches, their immutability, and the no-over-dispatch rule."""
import threading
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError


def run(engine, sql, **params):
    with engine.begin() as conn:
        return conn.execute(text(sql), params)


def refused(engine, sql, **params) -> str:
    with pytest.raises(DBAPIError) as caught:
        run(engine, sql, **params)
    return str(caught.value.orig)


def make_world(engine, quantities=("15", "4"), status="ready", org=None, number="DL-000001"):
    """A client and a delivery list with one item per quantity (products differ), then set to `status` (draft / ready / cancelled)."""
    org = org or uuid.uuid4()
    client, delivery_list = uuid.uuid4(), uuid.uuid4()
    items, products = [uuid.uuid4() for _ in quantities], [uuid.uuid4() for _ in quantities]
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO clients (id, organization_id, name, name_key) VALUES (:c, :o, :n, :n)"), {"c": client, "o": org, "n": f"Client {delivery_list}"})
        conn.execute(text("INSERT INTO delivery_lists (id, organization_id, client_id, number, created_by, created_by_email) VALUES (:id, :o, :c, :n, :u, 'a@b.c')"),
                     {"id": delivery_list, "o": org, "c": client, "n": number, "u": uuid.uuid4()})
        for item, product, quantity in zip(items, products, quantities):
            conn.execute(text(
                "INSERT INTO delivery_list_items (id, organization_id, delivery_list_id, product_id, product_sku, product_name, quantity, unit) "
                "VALUES (:id, :o, :dl, :p, 'SKU', 'Thing', :q, 'pcs')"), {"id": item, "o": org, "dl": delivery_list, "p": product, "q": Decimal(quantity)})
        if status != "draft":
            conn.execute(text("UPDATE delivery_lists SET status = 'ready' WHERE id = :id"), {"id": delivery_list})
    if status == "cancelled":
        run(engine, "UPDATE delivery_lists SET status = 'cancelled' WHERE id = :id", id=delivery_list)
    return {"org": org, "client": client, "list": delivery_list, "items": items, "products": products}


def status_of(engine, table, row_id) -> str:
    return run(engine, f"SELECT status FROM {table} WHERE id = :id", id=row_id).scalar()


def make_dispatch(engine, world, number="DS-000001"):
    dispatch = uuid.uuid4()
    run(engine,
        "INSERT INTO dispatches (id, organization_id, delivery_list_id, client_id, number, dispatch_date, posting_key, created_by, created_by_email) "
        "VALUES (:id, :o, :dl, :c, :n, current_date, 'dispatch-' || CAST(:id AS text), :u, 'a@b.c')",
        id=dispatch, o=world["org"], dl=world["list"], c=world["client"], n=number, u=uuid.uuid4())
    return dispatch


def add_line(engine, world, dispatch, index=0, quantity="3", unit="pcs", product=None, item=None):
    line = uuid.uuid4()
    run(engine,
        "INSERT INTO dispatch_lines (id, organization_id, dispatch_id, delivery_list_item_id, product_id, product_sku, product_name, unit, quantity) "
        "VALUES (:id, :o, :d, :i, :p, 'SKU', 'Thing', :unit, :q)",
        id=line, o=world["org"], d=dispatch, i=item or world["items"][index], p=product or world["products"][index], unit=unit, q=Decimal(quantity))
    return line


def start_posting(engine, dispatch):
    run(engine, "UPDATE dispatches SET status = 'posting', posting_started_at = now(), posting_attempts = 1 WHERE id = :id", id=dispatch)


def confirm(engine, dispatch):
    run(engine, "UPDATE dispatch_lines SET inventory_movement_id = gen_random_uuid() WHERE dispatch_id = :id", id=dispatch)
    run(engine, "UPDATE dispatches SET status = 'confirmed', inventory_operation_id = gen_random_uuid(), confirmed_at = now(), confirmed_by_email = 'a@b.c' WHERE id = :id", id=dispatch)


UPDATE_LIST = "UPDATE delivery_lists SET status = :s WHERE id = :id"


# =====================================================================================================
# The delivery list's life cycle
# =====================================================================================================
def test_the_only_moves_are_the_documented_ones(engine):
    draft, ready = make_world(engine, status="draft"), make_world(engine, number="DL-000002")
    for target in ("dispatched", "partially_dispatched"):
        assert "cannot become" in refused(engine, UPDATE_LIST, s=target, id=draft["list"])
    cancelled = make_world(engine, status="cancelled", number="DL-000003")
    for target in ("ready", "draft", "dispatched", "partially_dispatched"):
        assert "cannot become" in refused(engine, UPDATE_LIST, s=target, id=cancelled["list"])
    assert "cannot become" in refused(engine, UPDATE_LIST, s="bogus", id=ready["list"])


def test_existing_behaviour_is_unchanged(engine):
    w = make_world(engine, status="draft")
    for target in ("ready", "draft", "ready", "cancelled"):
        run(engine, UPDATE_LIST, s=target, id=w["list"])
    assert status_of(engine, "delivery_lists", w["list"]) == "cancelled"


def test_a_list_is_dispatched_or_partially_dispatched_only_as_the_confirmed_dispatches_say(engine):
    w = make_world(engine, quantities=("15", "4"))
    assert "some, but not all" in refused(engine, UPDATE_LIST, s="partially_dispatched", id=w["list"])
    assert "fully dispatched" in refused(engine, UPDATE_LIST, s="dispatched", id=w["list"])

    first = make_dispatch(engine, w)
    add_line(engine, w, first, 0, "15")
    start_posting(engine, first)
    assert "some, but not all" in refused(engine, UPDATE_LIST, s="partially_dispatched", id=w["list"])  # being posted does not count
    confirm(engine, first)
    assert "fully dispatched" in refused(engine, UPDATE_LIST, s="dispatched", id=w["list"])
    run(engine, UPDATE_LIST, s="partially_dispatched", id=w["list"])

    second = make_dispatch(engine, w, "DS-000002")
    add_line(engine, w, second, 1, "4")
    start_posting(engine, second)
    confirm(engine, second)
    run(engine, UPDATE_LIST, s="dispatched", id=w["list"])
    for target in ("ready", "draft", "partially_dispatched", "cancelled"):
        assert "cannot become" in refused(engine, UPDATE_LIST, s=target, id=w["list"])


def test_a_list_with_dispatches_cannot_be_reopened(engine):
    quiet, drafted, posting = make_world(engine), make_world(engine, number="DL-000002"), make_world(engine, number="DL-000003")
    run(engine, UPDATE_LIST, s="draft", id=quiet["list"])
    make_dispatch(engine, drafted)
    assert "cannot be reopened" in refused(engine, UPDATE_LIST, s="draft", id=drafted["list"])  # even a draft dispatch: the app cancels it first
    d = make_dispatch(engine, posting)
    add_line(engine, posting, d)
    start_posting(engine, d)
    assert "cannot be reopened" in refused(engine, UPDATE_LIST, s="draft", id=posting["list"])
    run(engine, UPDATE_LIST, s="ready", id=quiet["list"])
    run(engine, "UPDATE dispatches SET status = 'cancelled', cancelled_at = now() WHERE id = :id", id=make_dispatch(engine, quiet, "DS-000009"))
    run(engine, UPDATE_LIST, s="draft", id=quiet["list"])  # a cancelled dispatch does not block reopening


def test_a_list_with_goods_dispatched_or_being_dispatched_cannot_be_cancelled(engine):
    posting, drafted = make_world(engine), make_world(engine, number="DL-000002")
    d = make_dispatch(engine, posting)
    add_line(engine, posting, d)
    start_posting(engine, d)
    assert "cannot be cancelled" in refused(engine, UPDATE_LIST, s="cancelled", id=posting["list"])
    make_dispatch(engine, drafted)
    run(engine, UPDATE_LIST, s="cancelled", id=drafted["list"])  # only a draft dispatch: allowed (the application cancels it too)


def test_the_identity_of_a_list_never_changes(engine):
    w = make_world(engine, status="draft")
    for column, value in (("id", "gen_random_uuid()"), ("organization_id", "gen_random_uuid()"), ("number", "'DL-424242'"), ("client_id", "gen_random_uuid()"), ("created_by", "gen_random_uuid()")):
        assert "identity" in refused(engine, f"UPDATE delivery_lists SET {column} = {value} WHERE id = :id", id=w["list"]), column


# =====================================================================================================
# Items are frozen once the list is not a draft
# =====================================================================================================
def test_items_of_a_list_that_is_not_a_draft_are_frozen(engine):
    w = make_world(engine)
    assert "frozen" in refused(engine, "UPDATE delivery_list_items SET quantity = 99 WHERE id = :i", i=w["items"][0])
    assert "frozen" in refused(engine, "DELETE FROM delivery_list_items WHERE id = :i", i=w["items"][0])
    assert "frozen" in refused(engine,
        "INSERT INTO delivery_list_items (organization_id, delivery_list_id, product_id, product_sku, product_name, quantity, unit) VALUES (:o, :dl, gen_random_uuid(), 'S', 'N', 1, 'pcs')",
        o=w["org"], dl=w["list"])
    run(engine, UPDATE_LIST, s="draft", id=w["list"])
    run(engine, "UPDATE delivery_list_items SET quantity = 99 WHERE id = :i", i=w["items"][0])  # a draft is still freely editable


def test_an_item_cannot_be_moved_between_lists(engine):
    org = uuid.uuid4()
    ready, draft = make_world(engine, org=org), make_world(engine, status="draft", org=org, number="DL-000002")
    assert "cannot be moved" in refused(engine, "UPDATE delivery_list_items SET delivery_list_id = :d WHERE id = :i", d=draft["list"], i=ready["items"][0])
    assert "cannot be moved" in refused(engine, "UPDATE delivery_list_items SET delivery_list_id = :r WHERE id = :i", r=ready["list"], i=draft["items"][0])
    assert "cannot be moved" in refused(engine, "UPDATE delivery_list_items SET organization_id = gen_random_uuid() WHERE id = :i", i=draft["items"][0])
    assert "cannot be moved" in refused(engine, "UPDATE delivery_list_items SET id = gen_random_uuid() WHERE id = :i", i=draft["items"][0])


def test_the_maintenance_switch_lets_verification_scripts_clean_up_their_own_data(engine):
    w = make_world(engine)
    d = make_dispatch(engine, w)
    add_line(engine, w, d, 0, "2")
    start_posting(engine, d)
    confirm(engine, d)
    with engine.begin() as conn:
        conn.execute(text("SET LOCAL app.allow_ledger_maintenance = 'on'"))
        conn.execute(text("DELETE FROM dispatch_lines WHERE dispatch_id = :id"), {"id": d})
        conn.execute(text("DELETE FROM dispatches WHERE id = :id"), {"id": d})
        conn.execute(text("DELETE FROM delivery_list_items WHERE delivery_list_id = :id"), {"id": w["list"]})
    assert run(engine, "SELECT count(*) FROM dispatches WHERE id = :id", id=d).scalar() == 0


# =====================================================================================================
# Dispatches
# =====================================================================================================
def test_dispatches_exist_only_against_ready_or_partially_dispatched_lists_of_the_same_client(engine):
    for status in ("draft", "cancelled"):
        w = make_world(engine, status=status, number=f"DL-{status}")
        assert "Ready or Partially Dispatched" in refused(
            engine,
            "INSERT INTO dispatches (id, organization_id, delivery_list_id, client_id, number, dispatch_date, posting_key, created_by, created_by_email) "
            "VALUES (:id, :o, :dl, :c, 'DS-X', current_date, 'dispatch-' || CAST(:id AS text), :u, 'a@b.c')",
            id=uuid.uuid4(), o=w["org"], dl=w["list"], c=w["client"], u=uuid.uuid4())
    w = make_world(engine, number="DL-ok")
    assert "client of its delivery list" in refused(
        engine,
        "INSERT INTO dispatches (id, organization_id, delivery_list_id, client_id, number, dispatch_date, posting_key, created_by, created_by_email) "
        "VALUES (:id, :o, :dl, :c, 'DS-Y', current_date, 'dispatch-' || CAST(:id AS text), :u, 'a@b.c')",
        id=uuid.uuid4(), o=w["org"], dl=w["list"], c=make_world(engine, org=w["org"], number="DL-other")["client"], u=uuid.uuid4())
    make_dispatch(engine, w)


def test_a_dispatch_starts_as_a_draft_and_its_key_comes_from_its_id(engine):
    w = make_world(engine)
    base = ("INSERT INTO dispatches (id, organization_id, delivery_list_id, client_id, number, dispatch_date, posting_key, created_by, created_by_email{extra}) "
            "VALUES (:id, :o, :dl, :c, 'DS-X', current_date, {key}, :u, 'a@b.c'{values})")
    common = dict(id=uuid.uuid4(), o=w["org"], dl=w["list"], c=w["client"], u=uuid.uuid4())
    assert "starts as a draft" in refused(engine, base.format(extra=", status", key="'dispatch-' || CAST(:id AS text)", values=", 'confirmed'"), **common)
    assert "posting_key_from_id" in refused(engine, base.format(extra="", key="'something-else'", values=""), **common)


def test_dispatches_are_never_deleted(engine):
    w = make_world(engine)
    d = make_dispatch(engine, w)
    line = add_line(engine, w, d)
    assert "never deleted" in refused(engine, "DELETE FROM dispatches WHERE id = :id", id=d)
    run(engine, "DELETE FROM dispatch_lines WHERE id = :id", id=line)  # a draft's line may be removed
    assert status_of(engine, "dispatches", d) == "draft"


def test_a_dispatch_line_must_be_an_item_of_the_dispatchs_list_with_the_same_product_and_unit(engine):
    w, other = make_world(engine), make_world(engine, number="DL-000002")
    d = make_dispatch(engine, w)
    insert = ("INSERT INTO dispatch_lines (organization_id, dispatch_id, delivery_list_item_id, product_id, product_sku, product_name, unit, quantity) "
              "VALUES (:o, :d, :i, :p, 'S', 'N', :u, 1)")
    assert "not on the delivery list" in refused(engine, insert, o=w["org"], d=d, i=other["items"][0], p=other["products"][0], u="pcs")
    assert "product and the unit" in refused(engine, insert, o=w["org"], d=d, i=w["items"][0], p=uuid.uuid4(), u="pcs")
    assert "product and the unit" in refused(engine, insert, o=w["org"], d=d, i=w["items"][0], p=w["products"][0], u="kg")


def test_quantity_and_uniqueness_rules_on_a_line(engine):
    w = make_world(engine)
    d = make_dispatch(engine, w)
    for bad in ("0", "-1"):
        with pytest.raises(DBAPIError):
            add_line(engine, w, d, quantity=bad)
    add_line(engine, w, d, 0, "1")
    with pytest.raises(DBAPIError):
        add_line(engine, w, d, 0, "1")  # the same item twice on one dispatch
    add_line(engine, w, d, 1, "1")  # another item: fine


def test_nothing_can_be_confirmed_without_lines(engine):
    w = make_world(engine)
    empty = make_dispatch(engine, w)
    assert "without lines" in refused(engine, "UPDATE dispatches SET status = 'posting', posting_started_at = now() WHERE id = :id", id=empty)


def test_more_than_requested_can_never_be_dispatched(engine):
    w = make_world(engine, quantities=("10",))
    too_much = make_dispatch(engine, w)
    add_line(engine, w, too_much, 0, "10.0001")
    assert "exceed" in refused(engine, "UPDATE dispatches SET status = 'posting', posting_started_at = now() WHERE id = :id", id=too_much)

    first, second = make_dispatch(engine, w, "DS-000003"), make_dispatch(engine, w, "DS-000004")
    add_line(engine, w, first, 0, "6")
    add_line(engine, w, second, 0, "6")
    start_posting(engine, first)  # reserves 6 of 10 although nothing is confirmed yet
    assert "exceed" in refused(engine, "UPDATE dispatches SET status = 'posting', posting_started_at = now() WHERE id = :id", id=second)
    run(engine, "UPDATE dispatch_lines SET quantity = 4 WHERE dispatch_id = :id", id=second)
    start_posting(engine, second)
    assert status_of(engine, "dispatches", second) == "posting"


def test_a_rejected_posting_returns_the_reservation(engine):
    w = make_world(engine, quantities=("10",))
    first, second = make_dispatch(engine, w), make_dispatch(engine, w, "DS-000002")
    add_line(engine, w, first, 0, "8")
    add_line(engine, w, second, 0, "8")
    start_posting(engine, first)
    run(engine, "UPDATE dispatches SET status = 'draft' WHERE id = :id", id=first)
    start_posting(engine, second)


def test_concurrent_dispatches_cannot_both_reserve_the_same_goods(engine):
    w = make_world(engine, quantities=("10",))
    dispatches = []
    for index in range(4):
        d = make_dispatch(engine, w, f"DS-00000{index + 1}")
        add_line(engine, w, d, 0, "4")
        dispatches.append(d)
    outcomes = []

    def start(d):
        try:
            start_posting(engine, d)
            outcomes.append("posting")
        except DBAPIError:
            outcomes.append("refused")

    threads = [threading.Thread(target=start, args=(d,)) for d in dispatches]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert sorted(outcomes) == ["posting", "posting", "refused", "refused"]  # 4 + 4 fits in 10, a third 4 does not


def test_a_dispatch_is_not_confirmed_until_every_line_has_its_movement(engine):
    w = make_world(engine)
    d = make_dispatch(engine, w)
    first = add_line(engine, w, d, 0, "3")
    add_line(engine, w, d, 1, "1")
    start_posting(engine, d)
    confirmed = "UPDATE dispatches SET status = 'confirmed', inventory_operation_id = gen_random_uuid(), confirmed_at = now(), confirmed_by_email = 'a@b.c' WHERE id = :id"
    assert "before every line" in refused(engine, confirmed, id=d)
    run(engine, "UPDATE dispatch_lines SET inventory_movement_id = gen_random_uuid() WHERE id = :id", id=first)
    assert "before every line" in refused(engine, confirmed, id=d)  # one line is still missing its movement
    run(engine, "UPDATE dispatch_lines SET inventory_movement_id = gen_random_uuid() WHERE dispatch_id = :id AND inventory_movement_id IS NULL", id=d)
    run(engine, confirmed, id=d)
    assert status_of(engine, "dispatches", d) == "confirmed"


def test_confirmed_needs_the_operation_and_nothing_is_confirmed_before(engine):
    w = make_world(engine)
    d = make_dispatch(engine, w)
    add_line(engine, w, d)
    start_posting(engine, d)
    run(engine, "UPDATE dispatch_lines SET inventory_movement_id = gen_random_uuid() WHERE dispatch_id = :id", id=d)
    with pytest.raises(DBAPIError):
        run(engine, "UPDATE dispatches SET status = 'confirmed' WHERE id = :id", id=d)
    with pytest.raises(DBAPIError):
        run(engine, "UPDATE dispatches SET inventory_operation_id = gen_random_uuid() WHERE id = :id", id=d)


def test_a_confirmed_dispatch_can_never_be_changed_or_deleted(engine):
    w = make_world(engine)
    d = make_dispatch(engine, w)
    line = add_line(engine, w, d)
    start_posting(engine, d)
    confirm(engine, d)
    for sql in (
        "UPDATE dispatches SET notes = 'edited' WHERE id = :id", "UPDATE dispatches SET status = 'draft' WHERE id = :id",
        "UPDATE dispatches SET status = 'cancelled', cancelled_at = now() WHERE id = :id", "UPDATE dispatches SET tracking_reference = 'X' WHERE id = :id",
        "UPDATE dispatches SET inventory_operation_id = gen_random_uuid() WHERE id = :id", "DELETE FROM dispatches WHERE id = :id",
    ):
        assert "never" in refused(engine, sql, id=d), sql
    for sql in (
        "UPDATE dispatch_lines SET quantity = 99 WHERE id = :l",
        "UPDATE dispatch_lines SET inventory_movement_id = gen_random_uuid() WHERE id = :l", "DELETE FROM dispatch_lines WHERE id = :l",
    ):
        assert "confirmed" in refused(engine, sql, l=line), sql
    with pytest.raises(DBAPIError):
        add_line(engine, w, d, 1, "1")


def test_a_dispatch_being_posted_is_frozen_except_for_its_bookkeeping_and_the_movement_ids(engine):
    w = make_world(engine)
    d = make_dispatch(engine, w)
    line = add_line(engine, w, d)
    start_posting(engine, d)
    assert "frozen" in refused(engine, "UPDATE dispatches SET notes = 'x' WHERE id = :id", id=d)
    assert "frozen" in refused(engine, "UPDATE dispatches SET delivery_address = 'elsewhere' WHERE id = :id", id=d)
    assert "frozen" in refused(engine, "UPDATE dispatch_lines SET quantity = 1 WHERE id = :l", l=line)
    assert "cannot be removed" in refused(engine, "DELETE FROM dispatch_lines WHERE id = :l", l=line)
    run(engine, "UPDATE dispatches SET posting_attempts = 2, last_posting_error = 'timeout', last_posting_attempt_at = now() WHERE id = :id", id=d)
    run(engine, "UPDATE dispatch_lines SET inventory_movement_id = gen_random_uuid() WHERE id = :l", l=line)
    assert "frozen" in refused(engine, "UPDATE dispatch_lines SET inventory_movement_id = gen_random_uuid() WHERE id = :l", l=line)  # only once


def test_a_draft_can_be_edited_and_cancelled_and_a_cancelled_one_stays(engine):
    w = make_world(engine)
    d = make_dispatch(engine, w)
    line = add_line(engine, w, d)
    run(engine, "UPDATE dispatches SET notes = 'counted twice', tracking_reference = 'TRK' WHERE id = :id", id=d)
    run(engine, "UPDATE dispatch_lines SET quantity = 5 WHERE id = :l", l=line)
    assert "can only be confirmed (posted) or cancelled" in refused(engine, "UPDATE dispatches SET status = 'confirmed' WHERE id = :id", id=d)
    run(engine, "UPDATE dispatches SET status = 'cancelled', cancelled_at = now(), cancelled_by_email = 'a@b.c' WHERE id = :id", id=d)
    assert "never" in refused(engine, "UPDATE dispatches SET status = 'draft' WHERE id = :id", id=d)
    assert "never" in refused(engine, "UPDATE dispatches SET notes = 'again' WHERE id = :id", id=d)


def test_a_dispatch_cannot_be_reassigned_to_another_list_client_or_organization(engine):
    w, other = make_world(engine), make_world(engine, number="DL-000002")
    d = make_dispatch(engine, w)
    for sql, params in (
        ("UPDATE dispatches SET delivery_list_id = :x WHERE id = :id", {"x": other["list"]}), ("UPDATE dispatches SET organization_id = :x WHERE id = :id", {"x": other["org"]}),
        ("UPDATE dispatches SET client_id = :x WHERE id = :id", {"x": other["client"]}), ("UPDATE dispatches SET number = 'DS-999' WHERE id = :id", {}),
        ("UPDATE dispatches SET posting_key = 'dispatch-' || CAST(gen_random_uuid() AS text) WHERE id = :id", {}),
    ):
        with pytest.raises(DBAPIError):
            run(engine, sql, id=d, **params)


def test_numbers_and_keys_are_unique_per_organization(engine):
    w = make_world(engine)
    make_dispatch(engine, w, "DS-000001")
    with pytest.raises(DBAPIError):
        make_dispatch(engine, w, "DS-000001")
    make_dispatch(engine, make_world(engine, number="DL-000002"), "DS-000001")  # the same number in another organization: fine
