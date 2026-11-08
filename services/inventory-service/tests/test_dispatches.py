"""Client-dispatch posting (Step 17A): several quantities deducted from stock atomically, once, and traceably."""
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app import stock
from app.auth import TenantContext
from app.schemas import DispatchPost

from conftest import bearer
from test_stock import run_in_parallel

DISPATCHES_URL = "/api/v1/inventory/dispatches"


@pytest.fixture
def setup(api):
    world = {
        "bolt": api.product(sku="BOLT", name="Bolt", unit="pcs"),
        "flour": api.product(sku="FLOUR", name="Flour", unit="kg"),
    }
    api.add(world["bolt"], 100)
    api.add(world["flour"], "30.5")
    return world


def line(product, quantity, line_id=None, unit=None):
    return {"line_id": line_id or str(uuid.uuid4()), "product_id": product["id"], "quantity": str(quantity), "unit": unit or product["unit"]}


def post(api, lines, key=None, number="DS-000001", delivery_list="DL-000001", **extra):
    headers = {**api.headers, "Idempotency-Key": key or f"dispatch-{uuid.uuid4()}"}
    body = {"dispatch_number": number, "delivery_list_number": delivery_list, "lines": lines, **extra}
    return api.client.post(DISPATCHES_URL, json=body, headers=headers)


def ledger(api, **params):
    return api.movements(limit=200, **params)["items"]


# --- the happy path ----------------------------------------------------------------------------------------
def test_a_dispatch_deducts_every_line_and_records_where_it_came_from(api, setup):
    a, b, c = line(setup["bolt"], 10), line(setup["bolt"], 5), line(setup["flour"], "12.25")
    response = post(api, [a, b, c], key="dispatch-first-key")
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["replayed"] is False and body["dispatch_number"] == "DS-000001"
    assert "warehouse" not in response.text
    assert {m["line_id"]: (m["quantity"], m["balance_after"]) for m in body["movements"]} == {
        a["line_id"]: ("10.0000", "90.0000"), b["line_id"]: ("5.0000", "85.0000"), c["line_id"]: ("12.2500", "18.2500"),
    }
    assert api.quantity(setup["bolt"]) == "85.0000"
    assert api.quantity(setup["flour"]) == "18.2500"

    out = ledger(api, type="out")
    assert len(out) == 3 and {m["movement_type"] for m in out} == {"out"}
    assert {(m["source_type"], m["source_reference"]) for m in out} == {("client_dispatch", "DS-000001")}
    assert all(m["reason"] == "Client dispatch DS-000001 (DL-000001)" and m["created_by_email"] == "admin-alpha@example.org" for m in out)


def test_two_lines_for_the_same_product_accumulate(api, setup):
    assert post(api, [line(setup["bolt"], 6), line(setup["bolt"], 4)]).status_code == 201
    assert api.quantity(setup["bolt"]) == "90.0000"
    assert sorted(m["balance_after"] for m in ledger(api, type="out")) == ["90.0000", "94.0000"]


def test_a_dispatch_can_take_everything_but_never_more(api, setup):
    assert post(api, [line(setup["bolt"], 100), line(setup["flour"], "30.5")]).status_code == 201
    assert api.quantity(setup["bolt"]) == "0" and api.quantity(setup["flour"]) == "0"
    again = post(api, [line(setup["flour"], "0.0001")])
    assert again.status_code == 409 and "Insufficient stock" in again.json()["detail"] and "warehouse" not in again.text.lower()


def test_earlier_history_stays_and_the_ledger_grows_by_one_row_per_line(api, setup):
    before = len(ledger(api))
    post(api, [line(setup["bolt"], 1), line(setup["flour"], 1)])
    assert len(ledger(api)) == before + 2


# --- stock can never go negative; all or nothing ---------------------------------------------------------------
def test_insufficient_stock_refuses_the_whole_dispatch(api, setup):
    good, bad = line(setup["bolt"], 10), line(setup["flour"], "30.5001")
    response = post(api, [good, bad])
    assert response.status_code == 409 and "Insufficient stock" in response.json()["detail"] and "Flour" in response.json()["detail"]
    assert api.quantity(setup["bolt"]) == "100.0000" and api.quantity(setup["flour"]) == "30.5000"
    assert ledger(api, type="out") == []
    # and a refused attempt does not burn the key
    retry = post(api, [good], key="dispatch-reused-key")
    assert post(api, [good, bad], key="dispatch-reused-key-2").status_code == 409
    assert retry.status_code == 201


def test_two_lines_that_together_need_more_than_the_stock_are_refused(api, setup):
    response = post(api, [line(setup["bolt"], 60), line(setup["bolt"], 60)])
    assert response.status_code == 409 and api.quantity(setup["bolt"]) == "100.0000"


def test_a_failed_posting_does_not_burn_its_key(api, setup):
    bad = line(setup["bolt"], 5, unit="box")
    assert post(api, [bad], key="dispatch-retry-key").status_code == 409
    assert post(api, [{**bad, "unit": "pcs"}], key="dispatch-retry-key").status_code == 201


def test_concurrent_dispatches_can_never_overdraw_the_stock(api, two_orgs, setup, session_factory):
    tenant = TenantContext(organization_id=uuid.UUID(two_orgs["alpha_id"]), user_id=str(uuid.uuid4()), email="p@example.org", full_name="P")
    payloads = [DispatchPost(dispatch_number=f"DS-{i:06d}", lines=[line(setup["bolt"], 35)]) for i in range(8)]  # 100 in stock: two fit
    jobs = [lambda db, i=i: stock.execute_dispatch(db, tenant, payloads[i], f"dispatch-par-{i:02d}") for i in range(8)]
    outcomes = run_in_parallel(session_factory, jobs)
    assert [o for o in outcomes if o[0] == "error"] == []
    assert sum(1 for o in outcomes if o[0] == "ok") == 2 and sum(1 for o in outcomes if o == ("http", 409)) == 6
    assert api.quantity(setup["bolt"]) == "30.0000"


def test_dispatches_listing_products_in_opposite_orders_never_deadlock(api, two_orgs, setup, session_factory):
    tenant = TenantContext(organization_id=uuid.UUID(two_orgs["alpha_id"]), user_id=str(uuid.uuid4()), email="p@example.org", full_name="P")
    payloads = [
        DispatchPost(dispatch_number=f"DS-{i:06d}", lines=[line(setup["bolt"], 1), line(setup["flour"], 1)] if i % 2 else
                     [line(setup["flour"], 1), line(setup["bolt"], 1)])
        for i in range(8)
    ]
    jobs = [lambda db, i=i: stock.execute_dispatch(db, tenant, payloads[i], f"dispatch-opp-{i:02d}") for i in range(8)]
    outcomes = run_in_parallel(session_factory, jobs)
    assert [o for o in outcomes if o[0] != "ok"] == []
    assert api.quantity(setup["bolt"]) == "92.0000" and api.quantity(setup["flour"]) == "22.5000"


# --- retries and idempotency -----------------------------------------------------------------------------
def test_repeating_the_same_posting_replays_it_and_deducts_nothing(api, setup):
    lines = [line(setup["bolt"], 10), line(setup["bolt"], 5)]
    first, again = post(api, lines, key="dispatch-same"), post(api, lines, key="dispatch-same")
    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json()["replayed"] is True and again.json()["operation_id"] == first.json()["operation_id"] and again.json()["dispatch_number"] == "DS-000001"
    assert api.quantity(setup["bolt"]) == "85.0000" and len(ledger(api, type="out")) == 2


def test_the_same_key_with_a_different_dispatch_is_refused(api, setup):
    lines = [line(setup["bolt"], 10)]
    post(api, lines, key="dispatch-same")
    assert post(api, [{**lines[0], "quantity": "11"}], key="dispatch-same").status_code == 409
    assert api.quantity(setup["bolt"]) == "90.0000"


def test_a_dispatch_line_can_never_be_deducted_twice_even_under_a_new_key(api, setup):
    lines = [line(setup["bolt"], 10)]
    assert post(api, lines, key="dispatch-one").status_code == 201
    second = post(api, lines, key="dispatch-two")
    assert second.status_code == 409 and "already deducted" in second.json()["detail"]
    assert api.quantity(setup["bolt"]) == "90.0000"
    assert api.client.get(f"{DISPATCHES_URL}/by-key/dispatch-two", headers=api.headers).status_code == 404


def test_by_key_tells_whether_the_posting_happened(api, setup):
    url = f"{DISPATCHES_URL}/by-key/dispatch-lookup"
    assert api.client.get(url, headers=api.headers).status_code == 404
    lines = [line(setup["bolt"], 3)]
    post(api, lines, key="dispatch-lookup")
    found = api.client.get(url, headers=api.headers)
    assert found.status_code == 200 and found.json()["dispatch_number"] == "DS-000001"
    assert [m["line_id"] for m in found.json()["movements"]] == [lines[0]["line_id"]]


def test_by_key_does_not_confuse_other_kinds_of_operation(api, setup):
    api.change("in", key="plain-stock-key", product_id=setup["bolt"]["id"], quantity="1")
    assert api.client.get(f"{DISPATCHES_URL}/by-key/plain-stock-key", headers=api.headers).status_code == 404
    assert api.client.get(f"/api/v1/inventory/goods-receipts/by-key/plain-stock-key", headers=api.headers).status_code == 404


def test_a_receipt_key_cannot_be_replayed_as_a_dispatch(api, setup):
    api.client.post("/api/v1/inventory/goods-receipts", json={"receipt_number": "GR-1", "lines": [line(setup["bolt"], 1)]},
                    headers={**api.headers, "Idempotency-Key": "shared-kind-key"})
    response = post(api, [line(setup["bolt"], 1)], key="shared-kind-key")
    assert response.status_code == 409
    assert api.client.get(f"{DISPATCHES_URL}/by-key/shared-kind-key", headers=api.headers).status_code == 404


def test_simultaneous_identical_postings_deduct_once(api, two_orgs, setup, session_factory):
    payload = DispatchPost(dispatch_number="DS-000001", lines=[line(setup["bolt"], 10)])
    tenant = TenantContext(organization_id=uuid.UUID(two_orgs["alpha_id"]), user_id=str(uuid.uuid4()), email="p@example.org", full_name="P")
    outcomes = run_in_parallel(session_factory, [lambda db: stock.execute_dispatch(db, tenant, payload, "dispatch-parallel") for _ in range(6)])
    assert [o for o in outcomes if o[0] in ("error", "http")] == []
    assert sum(1 for o in outcomes if o[1].replayed is False) == 1
    assert api.quantity(setup["bolt"]) == "90.0000" and len(ledger(api, type="out")) == 1


# --- validation --------------------------------------------------------------------------------------------
def test_the_unit_must_match_the_product_and_is_never_converted(api, setup):
    response = post(api, [line(setup["bolt"], 5, unit="box")])
    assert response.status_code == 409 and "never converted" in response.json()["detail"]
    assert ledger(api, type="out") == []


def test_whole_units_cannot_be_dispatched_in_fractions(api, setup):
    assert post(api, [line(setup["bolt"], "2.5")]).status_code == 422
    assert post(api, [line(setup["flour"], "2.5")]).status_code == 201


def test_archived_products_are_refused(api, setup):
    api.client.post(f"/api/v1/inventory/products/{setup['flour']['id']}/archive", headers=api.headers)
    archived_product = post(api, [line(setup["flour"], 1)])
    assert archived_product.status_code == 409 and "archived" in archived_product.json()["detail"]
    assert ledger(api, type="out") == []


def test_unknown_product_is_a_404(api, setup):
    ghost = {"id": str(uuid.uuid4()), "unit": "pcs"}
    assert post(api, [line(ghost, 1)]).json()["detail"] == "Product not found."


@pytest.mark.parametrize("quantity", ["0", "-1", "abc", "1.00001", "100000000000000000"])
def test_bad_quantities_are_refused(api, setup, quantity):
    assert post(api, [line(setup["flour"], quantity)]).status_code == 422
    assert ledger(api, type="out") == []


def test_the_request_is_validated(api, setup):
    one = line(setup["bolt"], 1)
    assert post(api, []).status_code == 422
    assert post(api, [one, one]).status_code == 422
    assert post(api, [one], organization_id=str(uuid.uuid4())).status_code == 422
    assert post(api, [{**one, "price": "9.99"}]).status_code == 422  # a dispatch never carries a price
    assert post(api, [{**one, "warehouse_id": str(uuid.uuid4())}]).status_code == 422  # there is no warehouse to name any more
    no_key = api.client.post(DISPATCHES_URL, json={"dispatch_number": "DS-1", "lines": [one]}, headers=api.headers)
    assert no_key.status_code == 400
    assert post(api, [one], key="short").status_code == 400


# --- tenants -----------------------------------------------------------------------------------------------
def test_another_organizations_products_look_like_they_do_not_exist(api, two_orgs, setup):
    beta = two_orgs["beta"]
    beta_product = beta.product(sku="THEIRS", name="Theirs")
    beta.add(beta_product, 50)
    stolen_product = post(api, [line(beta_product, 5)])
    ghost = post(api, [line({"id": str(uuid.uuid4()), "unit": "pcs"}, 5)])
    assert (stolen_product.status_code, stolen_product.json()) == (ghost.status_code, ghost.json()) == (404, {"detail": "Product not found."})
    assert beta.quantity(beta_product) == "50.0000"


def test_a_posting_is_visible_only_to_its_own_organization(api, two_orgs, setup):
    post(api, [line(setup["bolt"], 5)], key="dispatch-private")
    other = two_orgs["beta"]
    assert other.client.get(f"{DISPATCHES_URL}/by-key/dispatch-private", headers=other.headers).status_code == 404
    theirs = other.product(sku="BOLT", name="Bolt")
    other.add(theirs, 10)
    assert post(other, [line(theirs, 7)], key="dispatch-private").status_code == 201
    assert api.quantity(setup["bolt"]) == "95.0000" and other.quantity(theirs) == "3.0000"


def test_authentication_and_role_are_required(client, directory):
    body = {"dispatch_number": "DS-1", "lines": []}
    assert client.post(DISPATCHES_URL, json=body, headers={"Idempotency-Key": "dispatch-x-key"}).status_code == 401
    directory.add_user("super", "super-admin")
    assert client.post(DISPATCHES_URL, json=body, headers={**bearer("super"), "Idempotency-Key": "dispatch-x-key"}).status_code == 403
    assert client.get(f"{DISPATCHES_URL}/by-key/dispatch-x-key").status_code == 401


# --- the database holds the line too -------------------------------------------------------------------------
def test_dispatch_movements_are_outgoing_and_append_only(api, setup, engine):
    post(api, [line(setup["bolt"], 5)])
    with engine.connect() as conn:
        row = conn.execute(text("SELECT movement_type, source_type, quantity FROM stock_movements WHERE source_type = 'client_dispatch'")).one()
    assert (row.movement_type, row.source_type) == ("out", "client_dispatch")
    with pytest.raises(DBAPIError):
        with engine.begin() as conn:
            conn.execute(text("UPDATE stock_movements SET quantity = 1 WHERE source_type = 'client_dispatch'"))
    with pytest.raises(DBAPIError):
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM stock_movements WHERE source_type = 'client_dispatch'"))


def test_the_database_refuses_a_second_movement_for_one_dispatch_line(api, setup, engine):
    post(api, [line(setup["bolt"], 5)])
    with pytest.raises(IntegrityError):
        with engine.begin() as conn:
            conn.execute(text(
                "INSERT INTO stock_movements (id, organization_id, operation_id, product_id, movement_type, quantity, balance_after, reason, "
                "created_by, created_by_email, source_type, source_reference, source_line_id) "
                "SELECT gen_random_uuid(), organization_id, operation_id, product_id, movement_type, quantity, balance_after, reason, "
                "created_by, created_by_email, source_type, source_reference, source_line_id FROM stock_movements WHERE source_type = 'client_dispatch'"
            ))


@pytest.mark.parametrize("movement_type, source_type", [("in", "client_dispatch"), ("out", "goods_receipt"), ("opening", "client_dispatch"), ("out", "invoice")])
def test_a_movement_source_must_agree_with_its_direction(api, setup, engine, movement_type, source_type):
    api.add(setup["bolt"], 1)
    with pytest.raises(IntegrityError, match="ck_stock_movements_source_consistent"):
        with engine.begin() as conn:
            conn.execute(text(
                "INSERT INTO stock_movements (id, organization_id, operation_id, product_id, movement_type, quantity, balance_after, reason, "
                f"created_by, created_by_email, source_type, source_reference, source_line_id) SELECT gen_random_uuid(), organization_id, operation_id, "
                f"product_id, '{movement_type}', quantity, balance_after, reason, created_by, created_by_email, '{source_type}', 'X-1', gen_random_uuid() "
                "FROM stock_movements LIMIT 1"
            ))


def test_the_balance_can_never_be_negative_in_the_database(api, setup, engine):
    with pytest.raises(IntegrityError):
        with engine.begin() as conn:
            conn.execute(text("UPDATE stock_balances SET quantity = -1"))
