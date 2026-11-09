"""Stock reservations: stock booked for sales orders. The Inventory Service owns them; nothing can take booked stock."""
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app import reservations, stock
from app.auth import TenantContext
from app.schemas import ReservationLine, ReservationSet

from test_dispatches import DISPATCHES_URL, line as dispatch_line
from test_stock import run_in_parallel

RESERVATIONS_URL = "/api/v1/inventory/reservations"
SECRET = {"X-Internal-Key": "test-reservation-key"}


@pytest.fixture(autouse=True)
def reservation_secret(monkeypatch):
    monkeypatch.setenv("RESERVATION_API_KEY", "test-reservation-key")


def order_line(product, quantity, line_id=None):
    return {"line_id": line_id or str(uuid.uuid4()), "product_id": product["id"], "quantity": str(quantity), "unit": product["unit"]}


def reserve(api, order_id, lines, number="SO-000001", key=None, secret=True):
    headers = {**api.headers, "Idempotency-Key": key or f"reserve-{uuid.uuid4()}", **(SECRET if secret else {})}
    return api.client.post(RESERVATIONS_URL, json={"source_id": order_id, "source_reference": number, "lines": lines}, headers=headers)


def release(api, order_id, number="SO-000001", key=None):
    headers = {**api.headers, "Idempotency-Key": key or f"release-{uuid.uuid4()}", **SECRET}
    return api.client.post(f"{RESERVATIONS_URL}/release", json={"source_id": order_id, "source_reference": number}, headers=headers)


def figures(api, product):
    body = api.client.get("/api/v1/inventory/stock/summary", params={"product_id": product["id"]}, headers=api.headers).json()
    (item,) = body["items"]
    return tuple(str(Decimal(item[k]).quantize(Decimal("0.0001"))) for k in ("total_quantity", "reserved_quantity", "available_quantity"))


@pytest.fixture
def water(api):
    product = api.product(sku="WATER", name="Water bottle", unit="pcs")
    api.add(product, 500)
    return product


# --- the 500 / 400 / 100 story ------------------------------------------------------------------------------
def test_reserving_leaves_physical_stock_alone_and_reduces_what_is_available(api, water):
    order = str(uuid.uuid4())
    response = reserve(api, order, [order_line(water, 400)])
    assert response.status_code == 201, response.text
    assert figures(api, water) == ("500.0000", "400.0000", "100.0000")
    assert api.quantity(water) == "500.0000"
    assert len(api.movements(limit=50)["items"]) == 1  # only the opening stock-in: a reservation never touches the ledger


def test_a_second_order_can_take_only_what_is_still_available(api, water):
    reserve(api, str(uuid.uuid4()), [order_line(water, 400)])
    refused = reserve(api, str(uuid.uuid4()), [order_line(water, 150)], number="SO-000002")
    assert refused.status_code == 409
    detail = refused.json()["detail"]
    assert detail["code"] == "insufficient_available"
    assert "Only 100 pcs of Water bottle are available" in detail["message"] and "400 pcs are already reserved for other orders" in detail["message"]
    assert detail["shortages"][0]["available"] == "100.0000" and detail["shortages"][0]["reserved_elsewhere"] == "400.0000"
    assert figures(api, water) == ("500.0000", "400.0000", "100.0000")  # the refusal changed nothing

    assert reserve(api, str(uuid.uuid4()), [order_line(water, 100)], number="SO-000002").status_code == 201
    assert figures(api, water) == ("500.0000", "500.0000", "0.0000")
    assert reserve(api, str(uuid.uuid4()), [order_line(water, 1)], number="SO-000003").status_code == 409  # nothing left to book


def test_different_orders_may_contain_the_same_product(api, water):
    assert reserve(api, str(uuid.uuid4()), [order_line(water, 10)]).status_code == 201
    assert reserve(api, str(uuid.uuid4()), [order_line(water, 20)], number="SO-000002").status_code == 201
    assert figures(api, water)[1] == "30.0000"


# --- all or nothing ---------------------------------------------------------------------------------------
def test_a_multi_product_order_is_booked_completely_or_not_at_all(api, water):
    bolt = api.product(sku="BOLT", name="Bolt", unit="pcs")
    api.add(bolt, 5)
    refused = reserve(api, str(uuid.uuid4()), [order_line(water, 100), order_line(bolt, 6)])
    assert refused.status_code == 409
    assert figures(api, water)[1] == "0.0000" and figures(api, bolt)[1] == "0.0000"  # the water was NOT booked either

    assert reserve(api, str(uuid.uuid4()), [order_line(water, 100), order_line(bolt, 5)]).status_code == 201
    assert figures(api, water)[1] == "100.0000" and figures(api, bolt)[1] == "5.0000"


def test_quantities_follow_the_units_rules(api):
    pieces = api.product(sku="PCS", name="Pieces", unit="pcs")
    kilos = api.product(sku="KG", name="Flour", unit="kg")
    api.add(pieces, 10)
    api.add(kilos, "10.5")
    assert reserve(api, str(uuid.uuid4()), [order_line(pieces, "2.5")]).status_code == 422
    assert reserve(api, str(uuid.uuid4()), [order_line(kilos, "2.5")]).status_code == 201
    assert figures(api, kilos) == ("10.5000", "2.5000", "8.0000")
    wrong_unit = {**order_line(pieces, 1), "unit": "box"}
    assert reserve(api, str(uuid.uuid4()), [wrong_unit]).status_code == 409


# --- changing an order ---------------------------------------------------------------------------------------
def test_reducing_releases_and_increasing_books_only_the_difference(api, water):
    order, row = str(uuid.uuid4()), str(uuid.uuid4())
    reserve(api, order, [order_line(water, 400, row)])
    reduced = reserve(api, order, [order_line(water, 250, row)])
    assert reduced.status_code == 201 and figures(api, water) == ("500.0000", "250.0000", "250.0000")
    state = reduced.json()["lines"][0]
    assert (state["original_quantity"], state["released_quantity"], state["remaining_quantity"], state["status"]) == ("400.0000", "150.0000", "250.0000", "active")

    increased = reserve(api, order, [order_line(water, 450, row)])
    assert increased.status_code == 201 and figures(api, water) == ("500.0000", "450.0000", "50.0000")

    too_much = reserve(api, order, [order_line(water, 600, row)])
    assert too_much.status_code == 409 and figures(api, water) == ("500.0000", "450.0000", "50.0000")  # refused as a whole


def test_an_increase_counts_the_orders_own_booking_as_its_own(api, water):
    other = str(uuid.uuid4())
    reserve(api, other, [order_line(water, 300)], number="SO-000002")
    order, row = str(uuid.uuid4()), str(uuid.uuid4())
    reserve(api, order, [order_line(water, 100, row)])
    assert reserve(api, order, [order_line(water, 200, row)]).status_code == 201  # 100 more of the 100 still free
    assert reserve(api, order, [order_line(water, 201, row)]).status_code == 409


def test_lines_left_out_of_the_request_are_released(api, water):
    bolt = api.product(sku="BOLT", name="Bolt", unit="pcs")
    api.add(bolt, 50)
    order, w, b = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    reserve(api, order, [order_line(water, 10, w), order_line(bolt, 5, b)])
    assert reserve(api, order, [order_line(water, 10, w)]).status_code == 201
    assert figures(api, bolt)[1] == "0.0000" and figures(api, water)[1] == "10.0000"


def test_releasing_an_order_gives_everything_back_and_is_idempotent(api, water):
    order = str(uuid.uuid4())
    reserve(api, order, [order_line(water, 400)])
    first = release(api, order, key="release-key-0001")
    assert first.status_code == 201 and figures(api, water) == ("500.0000", "0.0000", "500.0000")
    assert first.json()["lines"][0]["status"] == "released"
    again = release(api, order, key="release-key-0001")
    assert again.status_code == 200 and again.json()["replayed"] is True
    assert release(api, order).status_code == 201  # a new key finds nothing left to release and changes nothing
    assert figures(api, water) == ("500.0000", "0.0000", "500.0000")


# --- retries -------------------------------------------------------------------------------------------------------
def test_retrying_with_the_same_key_replays_the_first_answer_and_books_nothing_twice(api, water):
    order, row = str(uuid.uuid4()), str(uuid.uuid4())
    first = reserve(api, order, [order_line(water, 100, row)], key="reserve-key-0001")
    again = reserve(api, order, [order_line(water, 100, row)], key="reserve-key-0001")
    assert first.status_code == 201 and again.status_code == 200 and again.json()["replayed"] is True
    assert again.json()["operation_id"] == first.json()["operation_id"]
    assert figures(api, water)[1] == "100.0000"
    reused = reserve(api, order, [order_line(water, 200, row)], key="reserve-key-0001")
    assert reused.status_code == 409 and "different request" in reused.json()["detail"]
    assert figures(api, water)[1] == "100.0000"


def test_a_pending_request_can_be_looked_up_by_its_key(api, water):
    assert api.client.get(f"{RESERVATIONS_URL}/by-key/never-used-key", headers=api.headers).status_code == 404
    order = str(uuid.uuid4())
    reserve(api, order, [order_line(water, 7)], key="reserve-lookup-01")
    found = api.client.get(f"{RESERVATIONS_URL}/by-key/reserve-lookup-01", headers=api.headers)
    assert found.status_code == 200 and found.json()["lines"][0]["remaining_quantity"] == "7.0000"
    source = api.client.get(f"{RESERVATIONS_URL}/source/{order}", headers=api.headers).json()
    assert [l["remaining_quantity"] for l in source["lines"]] == ["7.0000"]


# --- nothing can take booked stock -------------------------------------------------------------------------------
def test_a_manual_stock_out_cannot_take_reserved_units(api, water):
    reserve(api, str(uuid.uuid4()), [order_line(water, 400)])
    refused = api.change("out", product_id=water["id"], quantity="200")
    assert refused.status_code == 409
    assert "Insufficient available stock: 100 pcs of Water bottle available, 200 requested" in refused.json()["detail"] and "400 pcs is reserved" in refused.json()["detail"]
    assert api.change("out", product_id=water["id"], quantity="100").status_code == 201
    assert figures(api, water) == ("400.0000", "400.0000", "0.0000")
    assert api.change("out", product_id=water["id"], quantity="1").status_code == 409


def test_a_dispatch_of_something_else_cannot_take_reserved_units_either(api, water):
    reserve(api, str(uuid.uuid4()), [order_line(water, 450)])
    headers = {**api.headers, "Idempotency-Key": f"dispatch-{uuid.uuid4()}"}
    body = {"dispatch_number": "DS-000001", "lines": [dispatch_line(water, 60)]}
    assert api.client.post(DISPATCHES_URL, json=body, headers=headers).status_code == 409
    assert figures(api, water) == ("500.0000", "450.0000", "50.0000")


def test_the_database_itself_refuses_reserved_above_on_hand(api, water, engine):
    with pytest.raises((IntegrityError, DBAPIError)):
        with engine.begin() as conn:
            conn.execute(text("UPDATE stock_balances SET reserved_quantity = quantity + 1"))
    with pytest.raises((IntegrityError, DBAPIError)):
        with engine.begin() as conn:
            conn.execute(text("UPDATE stock_balances SET reserved_quantity = 100, quantity = 50"))


def test_opening_and_stock_in_raise_the_available_stock(api, water):
    reserve(api, str(uuid.uuid4()), [order_line(water, 500)])
    assert figures(api, water)[2] == "0.0000"
    api.add(water, 80)  # goods received
    assert figures(api, water) == ("580.0000", "500.0000", "80.0000")


# --- dispatching consumes the reservation ----------------------------------------------------------------------------
def dispatch(api, lines, number="DS-000001", key=None, secret=True):
    headers = {**api.headers, "Idempotency-Key": key or f"dispatch-{uuid.uuid4()}", **(SECRET if secret else {})}
    return api.client.post(DISPATCHES_URL, json={"dispatch_number": number, "lines": lines}, headers=headers)


def consuming(product, quantity, order_line_id):
    return {**dispatch_line(product, quantity), "order_line_id": order_line_id}


def test_confirmed_dispatches_deduct_stock_and_consume_the_reservation_together(api, water):
    order, row = str(uuid.uuid4()), str(uuid.uuid4())
    reserve(api, order, [order_line(water, 400, row)])
    assert dispatch(api, [consuming(water, 250, row)]).status_code == 201
    assert figures(api, water) == ("250.0000", "150.0000", "100.0000")  # physical 250, reserved 150, available 100
    assert dispatch(api, [consuming(water, 150, row)], number="DS-000002").status_code == 201
    assert figures(api, water) == ("100.0000", "0.0000", "100.0000")
    state = api.client.get(f"{RESERVATIONS_URL}/source/{order}", headers=api.headers).json()["lines"][0]
    assert (state["consumed_quantity"], state["remaining_quantity"], state["status"]) == ("400.0000", "0.0000", "fulfilled")
    assert dispatch(api, [consuming(water, 1, row)], number="DS-000003").status_code == 409  # nothing reserved is left


def test_a_dispatch_cannot_exceed_what_is_reserved_for_its_order_line(api, water):
    order, row = str(uuid.uuid4()), str(uuid.uuid4())
    reserve(api, order, [order_line(water, 100, row)])
    refused = dispatch(api, [consuming(water, 101, row)])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "exceeds_reservation"
    assert figures(api, water) == ("500.0000", "100.0000", "400.0000")


def test_retrying_a_confirmation_never_consumes_twice(api, water):
    order, row = str(uuid.uuid4()), str(uuid.uuid4())
    reserve(api, order, [order_line(water, 100, row)])
    body = [consuming(water, 40, row)]
    first = dispatch(api, body, key="dispatch-key-retry-1")
    again = dispatch(api, body, key="dispatch-key-retry-1")
    assert first.status_code == 201 and again.status_code == 200 and again.json()["replayed"] is True
    assert figures(api, water) == ("460.0000", "60.0000", "400.0000")


def test_only_the_sales_service_can_dispatch_against_a_reservation(api, water):
    order, row = str(uuid.uuid4()), str(uuid.uuid4())
    reserve(api, order, [order_line(water, 100, row)])
    refused = dispatch(api, [consuming(water, 10, row)], secret=False)
    assert refused.status_code == 403
    assert figures(api, water) == ("500.0000", "100.0000", "400.0000")


def test_an_order_line_of_another_product_cannot_be_consumed(api, water):
    bolt = api.product(sku="BOLT", name="Bolt", unit="pcs")
    api.add(bolt, 50)
    order, row = str(uuid.uuid4()), str(uuid.uuid4())
    reserve(api, order, [order_line(water, 100, row)])
    assert dispatch(api, [consuming(bolt, 10, row)]).status_code == 409
    assert figures(api, bolt) == ("50.0000", "0.0000", "50.0000")


def test_an_order_cannot_be_reduced_below_what_was_dispatched(api, water):
    order, row = str(uuid.uuid4()), str(uuid.uuid4())
    reserve(api, order, [order_line(water, 400, row)])
    dispatch(api, [consuming(water, 250, row)])
    refused = reserve(api, order, [order_line(water, 200, row)])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "below_dispatched"
    ok = reserve(api, order, [order_line(water, 300, row)])  # 250 dispatched, 50 still wanted: release 100 of the remaining 150
    assert ok.status_code == 201 and figures(api, water) == ("250.0000", "50.0000", "200.0000")
    assert release(api, order).status_code == 201
    assert figures(api, water) == ("250.0000", "0.0000", "250.0000")


# --- who may call -------------------------------------------------------------------------------------------------------
def test_reservations_cannot_be_written_without_the_shared_secret(api, water):
    assert reserve(api, str(uuid.uuid4()), [order_line(water, 10)], secret=False).status_code == 403
    headers = {**api.headers, "Idempotency-Key": "release-nokey-01"}
    assert api.client.post(f"{RESERVATIONS_URL}/release", json={"source_id": str(uuid.uuid4()), "source_reference": "SO-1"}, headers=headers).status_code == 403
    wrong = {**api.headers, "Idempotency-Key": "reserve-wrongkey1", "X-Internal-Key": "guess"}
    body = {"source_id": str(uuid.uuid4()), "source_reference": "SO-1", "lines": [order_line(water, 1)]}
    assert api.client.post(RESERVATIONS_URL, json=body, headers=wrong).status_code == 403
    assert figures(api, water)[1] == "0.0000"


def test_an_unconfigured_secret_refuses_everything(api, water, monkeypatch):
    monkeypatch.delenv("RESERVATION_API_KEY")
    assert reserve(api, str(uuid.uuid4()), [order_line(water, 10)]).status_code == 503


def test_the_organization_is_always_the_tokens(two_orgs, water):
    beta = two_orgs["beta"]
    stranger = reserve(beta, str(uuid.uuid4()), [order_line(water, 10)])  # alpha's product, beta's token
    assert stranger.status_code == 404
    mine = two_orgs["alpha"]
    order = str(uuid.uuid4())
    reserve(mine, order, [order_line(water, 10)])
    assert beta.client.get(f"{RESERVATIONS_URL}/source/{order}", headers=beta.headers).json()["lines"] == []  # beta cannot see alpha's booking
    assert release(beta, order).status_code == 201 and figures(mine, water)[1] == "10.0000"  # ...and cannot release it


def test_a_missing_idempotency_key_is_refused(api, water):
    response = api.client.post(RESERVATIONS_URL, json={"source_id": str(uuid.uuid4()), "source_reference": "SO-1", "lines": []}, headers={**api.headers, **SECRET})
    assert response.status_code == 400


# --- concurrency ----------------------------------------------------------------------------------------------------------
def tenant_for(two_orgs):
    return TenantContext(organization_id=uuid.UUID(two_orgs["alpha_id"]), user_id=str(uuid.uuid4()), email="parallel@example.org", full_name="P")


def test_simultaneous_orders_cannot_book_the_same_final_units(api, two_orgs, water, session_factory):
    tenant = tenant_for(two_orgs)

    def job(index):
        payload = ReservationSet(source_id=uuid.uuid4(), source_reference=f"SO-{index:06d}", lines=[ReservationLine(line_id=uuid.uuid4(), product_id=water["id"], quantity="150", unit="pcs")])
        return lambda db: reservations.reserve(db, tenant, payload, f"parallel-reserve-{index:03d}")

    outcomes = run_in_parallel(session_factory, [job(i) for i in range(8)])
    assert [o for o in outcomes if o[0] == "error"] == []
    assert len([o for o in outcomes if o[0] == "ok"]) == 3 and len([o for o in outcomes if o == ("http", 409)]) == 5  # 500 / 150 = 3 orders
    assert figures(api, water) == ("500.0000", "450.0000", "50.0000")


def test_a_manual_stock_out_racing_orders_never_takes_booked_stock(api, two_orgs, water, session_factory):
    tenant = tenant_for(two_orgs)
    payload = ReservationSet(source_id=uuid.uuid4(), source_reference="SO-000001", lines=[ReservationLine(line_id=uuid.uuid4(), product_id=water["id"], quantity="400", unit="pcs")])
    from app.schemas import StockChange

    out = StockChange(product_id=water["id"], quantity="150")
    jobs = [lambda db: reservations.reserve(db, tenant, payload, "race-reserve-001")] + [lambda db, i=i: stock.execute_change(db, tenant, "out", out, f"race-out-{i:03d}") for i in range(4)]
    outcomes = run_in_parallel(session_factory, jobs)
    assert [o for o in outcomes if o[0] == "error"] == []
    total, reserved, available = figures(api, water)
    assert float(total) >= float(reserved) >= 0 and float(available) >= 0  # whatever order they ran in, the invariant held


def test_multi_product_orders_in_opposite_orders_cannot_deadlock(api, two_orgs, water, session_factory):
    bolt = api.product(sku="BOLT", name="Bolt", unit="pcs")
    api.add(bolt, 500)
    tenant = tenant_for(two_orgs)

    def job(index, first, second):
        payload = ReservationSet(
            source_id=uuid.uuid4(), source_reference=f"SO-{index:06d}",
            lines=[ReservationLine(line_id=uuid.uuid4(), product_id=first["id"], quantity="10", unit="pcs"), ReservationLine(line_id=uuid.uuid4(), product_id=second["id"], quantity="10", unit="pcs")],
        )
        return lambda db: reservations.reserve(db, tenant, payload, f"parallel-multi-{index:03d}")

    outcomes = run_in_parallel(session_factory, [job(i, water, bolt) if i % 2 else job(i, bolt, water) for i in range(10)])
    assert all(o[0] == "ok" for o in outcomes), outcomes
    assert figures(api, water)[1] == "100.0000" and figures(api, bolt)[1] == "100.0000"


def test_the_balance_column_always_equals_the_sum_of_the_active_reservations(api, two_orgs, water, session_factory):
    tenant = tenant_for(two_orgs)
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    reserve(api, a, [order_line(water, 120)])
    reserve(api, b, [order_line(water, 80)], number="SO-000002")
    release(api, a)
    with session_factory() as db:
        totals = reservations.reserved_totals(db, tenant, [uuid.UUID(water["id"])])
    assert totals[uuid.UUID(water["id"])] == 80 and figures(api, water)[1] == "80.0000"
