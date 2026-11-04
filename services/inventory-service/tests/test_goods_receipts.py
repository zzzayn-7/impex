"""Goods-receipt posting (Step 16B): several accepted quantities added to stock atomically, once, and traceably."""
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app import stock
from app.auth import TenantContext
from app.schemas import ReceiptPost

from conftest import STOCK_URL, bearer
from test_stock import run_in_parallel

RECEIPTS_URL = "/api/v1/inventory/goods-receipts"


@pytest.fixture
def setup(api):
    return {
        "bolt": api.product(sku="BOLT", name="Bolt", unit="pcs"),
        "flour": api.product(sku="FLOUR", name="Flour", unit="kg"),
        "main": api.warehouse("MAIN"),
        "annex": api.warehouse("ANNEX"),
    }


def line(product, warehouse, quantity, line_id=None, unit=None):
    return {"line_id": line_id or str(uuid.uuid4()), "product_id": product["id"], "warehouse_id": warehouse["id"],
            "quantity": str(quantity), "unit": unit or product["unit"]}


def post(api, lines, key=None, number="GR-000001", order="PO-000001", **extra):
    headers = {**api.headers, "Idempotency-Key": key or f"goods-receipt-{uuid.uuid4()}"}
    body = {"receipt_number": number, "purchase_order_number": order, "lines": lines, **extra}
    return api.client.post(RECEIPTS_URL, json=body, headers=headers)


def movements(api):
    return api.movements(limit=200)["items"]


# --- the happy path ----------------------------------------------------------------------------------------
def test_a_receipt_adds_every_line_to_the_right_warehouse_and_records_where_it_came_from(api, setup):
    a, b, c = line(setup["bolt"], setup["main"], 30), line(setup["bolt"], setup["annex"], 20), line(setup["flour"], setup["main"], "12.5")
    response = post(api, [a, b, c], key="goods-receipt-first")
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["replayed"] is False and body["receipt_number"] == "GR-000001"
    assert {m["line_id"]: (m["quantity"], m["balance_after"]) for m in body["movements"]} == {
        a["line_id"]: ("30.0000", "30.0000"), b["line_id"]: ("20.0000", "20.0000"), c["line_id"]: ("12.5000", "12.5000"),
    }
    assert api.quantity(setup["bolt"], setup["main"]) == "30.0000"
    assert api.quantity(setup["bolt"], setup["annex"]) == "20.0000"
    assert api.quantity(setup["flour"], setup["main"]) == "12.5000"

    ledger = movements(api)
    assert len(ledger) == 3 and {m["movement_type"] for m in ledger} == {"in"}
    assert {(m["source_type"], m["source_reference"]) for m in ledger} == {("goods_receipt", "GR-000001")}
    assert all("Goods receipt GR-000001 (PO-000001)" == m["reason"] for m in ledger)
    assert all(m["created_by_email"] == "admin-alpha@example.org" for m in ledger)


def test_two_lines_for_the_same_product_and_warehouse_accumulate_in_order(api, setup):
    a, b = line(setup["bolt"], setup["main"], 4), line(setup["bolt"], setup["main"], 6)
    assert post(api, [a, b]).status_code == 201
    assert api.quantity(setup["bolt"], setup["main"]) == "10.0000"
    assert sorted(m["balance_after"] for m in movements(api)) == ["10.0000", "4.0000"]


def test_a_receipt_adds_to_stock_that_was_already_there(api, setup):
    api.add(setup["bolt"], setup["main"], 100)
    post(api, [line(setup["bolt"], setup["main"], 30)])
    assert api.quantity(setup["bolt"], setup["main"]) == "130.0000"


def test_ordinary_movements_have_no_source(api, setup):
    api.add(setup["bolt"], setup["main"], 5)
    (m,) = movements(api)
    assert m["source_type"] is None and m["source_reference"] is None


# --- retries and idempotency -----------------------------------------------------------------------------
def test_repeating_the_same_posting_replays_it_and_adds_nothing(api, setup):
    lines = [line(setup["bolt"], setup["main"], 30), line(setup["bolt"], setup["annex"], 20)]
    first = post(api, lines, key="goods-receipt-same")
    again = post(api, lines, key="goods-receipt-same")
    assert first.status_code == 201 and again.status_code == 200
    assert again.json()["replayed"] is True and again.json()["operation_id"] == first.json()["operation_id"]
    assert sorted((m["line_id"], m["quantity"]) for m in again.json()["movements"]) == sorted((m["line_id"], m["quantity"]) for m in first.json()["movements"])
    assert again.json()["receipt_number"] == "GR-000001"
    assert api.quantity(setup["bolt"], setup["main"]) == "30.0000" and len(movements(api)) == 2


def test_the_same_key_with_a_different_receipt_is_refused(api, setup):
    lines = [line(setup["bolt"], setup["main"], 30)]
    post(api, lines, key="goods-receipt-same")
    changed = [{**lines[0], "quantity": "31"}]
    assert post(api, changed, key="goods-receipt-same").status_code == 409
    assert api.quantity(setup["bolt"], setup["main"]) == "30.0000"


def test_a_receipt_line_can_never_be_added_twice_even_under_a_new_key(api, setup):
    lines = [line(setup["bolt"], setup["main"], 30)]
    assert post(api, lines, key="goods-receipt-one").status_code == 201
    second = post(api, lines, key="goods-receipt-two")
    assert second.status_code == 409 and "already added" in second.json()["detail"]
    assert api.quantity(setup["bolt"], setup["main"]) == "30.0000" and len(movements(api)) == 1
    # and the refused attempt did not leave its key behind as if it had posted something
    assert api.client.get(f"{RECEIPTS_URL}/by-key/goods-receipt-two", headers=api.headers).status_code == 404


def test_a_failed_posting_does_not_burn_its_key(api, setup):
    bad = line(setup["bolt"], setup["main"], 5, unit="box")
    assert post(api, [bad], key="goods-receipt-retry").status_code == 409
    good = [{**bad, "unit": "pcs"}]
    assert post(api, good, key="goods-receipt-retry").status_code == 201


def test_by_key_tells_whether_the_posting_happened(api, setup):
    url = f"{RECEIPTS_URL}/by-key/goods-receipt-lookup"
    assert api.client.get(url, headers=api.headers).status_code == 404
    lines = [line(setup["bolt"], setup["main"], 9)]
    post(api, lines, key="goods-receipt-lookup")
    found = api.client.get(url, headers=api.headers)
    assert found.status_code == 200 and found.json()["receipt_number"] == "GR-000001"
    assert [m["line_id"] for m in found.json()["movements"]] == [lines[0]["line_id"]]


def test_by_key_does_not_confuse_other_kinds_of_operation(api, setup):
    api.change("in", key="plain-stock-key", product_id=setup["bolt"]["id"], warehouse_id=setup["main"]["id"], quantity="1")
    assert api.client.get(f"{RECEIPTS_URL}/by-key/plain-stock-key", headers=api.headers).status_code == 404


def test_simultaneous_identical_postings_add_the_goods_once(api, two_orgs, setup, session_factory):
    payload = ReceiptPost(receipt_number="GR-000001", purchase_order_number="PO-000001", lines=[line(setup["bolt"], setup["main"], 30)])
    tenant = TenantContext(organization_id=uuid.UUID(two_orgs["alpha_id"]), user_id=str(uuid.uuid4()), email="p@example.org", full_name="P")
    jobs = [lambda db: stock.execute_receipt(db, tenant, payload, "goods-receipt-parallel") for _ in range(6)]
    outcomes = run_in_parallel(session_factory, jobs)
    assert [o for o in outcomes if o[0] in ("error", "http")] == []
    assert sum(1 for o in outcomes if o[1].replayed is False) == 1
    assert api.quantity(setup["bolt"], setup["main"]) == "30.0000" and len(movements(api)) == 1


def test_simultaneous_receipts_for_the_same_goods_never_lose_an_update(api, two_orgs, setup, session_factory):
    tenant = TenantContext(organization_id=uuid.UUID(two_orgs["alpha_id"]), user_id=str(uuid.uuid4()), email="p@example.org", full_name="P")
    payloads = [
        ReceiptPost(receipt_number=f"GR-{i:06d}", lines=[line(setup["bolt"], setup["main"], 5), line(setup["bolt"], setup["annex"], 1)] if i % 2 else
                    [line(setup["bolt"], setup["annex"], 1), line(setup["bolt"], setup["main"], 5)])
        for i in range(8)
    ]
    jobs = [lambda db, i=i: stock.execute_receipt(db, tenant, payloads[i], f"goods-receipt-par-{i:02d}") for i in range(8)]
    outcomes = run_in_parallel(session_factory, jobs)
    assert [o for o in outcomes if o[0] != "ok"] == []  # no deadlock, no failure
    assert api.quantity(setup["bolt"], setup["main"]) == "40.0000" and api.quantity(setup["bolt"], setup["annex"]) == "8.0000"


# --- all lines or none ---------------------------------------------------------------------------------
def test_one_bad_line_means_nothing_is_added(api, setup):
    good, bad = line(setup["bolt"], setup["main"], 30), line(setup["flour"], setup["main"], 5, unit="bag")
    response = post(api, [good, bad])
    assert response.status_code == 409
    assert api.quantity(setup["bolt"], setup["main"]) == "0" and movements(api) == []


def test_the_unit_must_match_the_product_and_is_never_converted(api, setup):
    response = post(api, [line(setup["bolt"], setup["main"], 5, unit="box")])
    assert response.status_code == 409 and "never converted" in response.json()["detail"]
    assert movements(api) == []


def test_whole_units_cannot_receive_a_fraction(api, setup):
    response = post(api, [line(setup["bolt"], setup["main"], "2.5")])
    assert response.status_code == 422 and "whole number" in response.json()["detail"]
    assert post(api, [line(setup["flour"], setup["main"], "2.5")]).status_code == 201  # measurable units may


def test_archived_products_and_warehouses_are_refused(api, setup):
    api.client.post(f"/api/v1/inventory/products/{setup['bolt']['id']}/archive", headers=api.headers)
    archived_product = post(api, [line(setup["bolt"], setup["main"], 1)])
    assert archived_product.status_code == 409 and "archived" in archived_product.json()["detail"]

    api.client.post(f"/api/v1/inventory/warehouses/{setup['annex']['id']}/archive", headers=api.headers)
    archived_warehouse = post(api, [line(setup["flour"], setup["annex"], 1)])
    assert archived_warehouse.status_code == 409 and "archived" in archived_warehouse.json()["detail"]
    assert movements(api) == []


def test_unknown_product_or_warehouse_is_a_404(api, setup):
    ghost = {"id": str(uuid.uuid4()), "unit": "pcs"}
    assert post(api, [line(ghost, setup["main"], 1)]).json()["detail"] == "Product not found."
    assert post(api, [line(setup["bolt"], ghost, 1)]).json()["detail"] == "Warehouse not found."


@pytest.mark.parametrize("quantity", ["0", "-1", "abc", "1.00001", "100000000000000000"])
def test_bad_quantities_are_refused(api, setup, quantity):
    assert post(api, [line(setup["flour"], setup["main"], quantity)]).status_code == 422
    assert movements(api) == []


def test_the_request_is_validated(api, setup):
    one = line(setup["bolt"], setup["main"], 1)
    assert post(api, []).status_code == 422
    assert post(api, [one, one]).status_code == 422  # the same line twice
    assert post(api, [one], organization_id=str(uuid.uuid4())).status_code == 422  # never accepted from the caller
    assert post(api, [{**one, "price": "9.99"}]).status_code == 422  # no price: receiving never touches prices
    no_key = api.client.post(RECEIPTS_URL, json={"receipt_number": "GR-1", "lines": [one]}, headers=api.headers)
    assert no_key.status_code == 400
    assert post(api, [one], key="short").status_code == 400


# --- tenants -----------------------------------------------------------------------------------------------
def test_another_organizations_products_and_warehouses_look_like_they_do_not_exist(api, two_orgs, setup):
    beta = two_orgs["beta"]
    beta_product, beta_warehouse = beta.product(sku="THEIRS", name="Theirs"), beta.warehouse("THEIR")
    stolen_product = post(api, [line(beta_product, setup["main"], 5)])
    stolen_warehouse = post(api, [line(setup["bolt"], beta_warehouse, 5)])
    ghost = post(api, [line({"id": str(uuid.uuid4()), "unit": "pcs"}, setup["main"], 5)])
    assert (stolen_product.status_code, stolen_product.json()) == (ghost.status_code, ghost.json()) == (404, {"detail": "Product not found."})
    assert stolen_warehouse.status_code == 404 and stolen_warehouse.json() == {"detail": "Warehouse not found."}
    assert beta.quantity(beta_product, beta_warehouse) == "0" and movements(beta) == []


def test_a_posting_is_visible_only_to_its_own_organization(api, two_orgs, setup):
    post(api, [line(setup["bolt"], setup["main"], 5)], key="goods-receipt-private")
    other = two_orgs["beta"]
    assert other.client.get(f"{RECEIPTS_URL}/by-key/goods-receipt-private", headers=other.headers).status_code == 404
    # the same key in another organization is a different, independent posting
    theirs, their_warehouse = other.product(sku="BOLT", name="Bolt"), other.warehouse("MAIN")
    assert post(other, [line(theirs, their_warehouse, 7)], key="goods-receipt-private").status_code == 201
    assert api.quantity(setup["bolt"], setup["main"]) == "5.0000" and other.quantity(theirs, their_warehouse) == "7.0000"


def test_authentication_and_role_are_required(client, directory, setup):
    body = {"receipt_number": "GR-1", "lines": []}
    assert client.post(RECEIPTS_URL, json=body, headers={"Idempotency-Key": "goods-receipt-x"}).status_code == 401
    directory.add_user("super", "super-admin")
    assert client.post(RECEIPTS_URL, json=body, headers={**bearer("super"), "Idempotency-Key": "goods-receipt-x"}).status_code == 403
    assert client.get(f"{RECEIPTS_URL}/by-key/goods-receipt-x").status_code == 401


# --- the database holds the line too -------------------------------------------------------------------------
def test_the_ledger_stays_append_only_for_receipt_movements(api, setup, engine):
    post(api, [line(setup["bolt"], setup["main"], 5)])
    with pytest.raises(DBAPIError):
        with engine.begin() as conn:
            conn.execute(text("UPDATE stock_movements SET quantity = 99"))
    with pytest.raises(DBAPIError):
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM stock_movements"))


def test_the_database_refuses_a_second_movement_for_one_source_line(api, setup, engine):
    lines = [line(setup["bolt"], setup["main"], 5)]
    post(api, lines)
    with pytest.raises(IntegrityError):
        with engine.begin() as conn:
            conn.execute(text(
                "INSERT INTO stock_movements (id, organization_id, operation_id, product_id, warehouse_id, movement_type, quantity, balance_after, reason, "
                "created_by, created_by_email, source_type, source_reference, source_line_id) "
                "SELECT gen_random_uuid(), organization_id, operation_id, product_id, warehouse_id, movement_type, quantity, balance_after, reason, "
                "created_by, created_by_email, source_type, source_reference, source_line_id FROM stock_movements"
            ))


@pytest.mark.parametrize("source", [
    "'goods_receipt', NULL, NULL",
    "NULL, 'GR-1', NULL",
    "NULL, NULL, gen_random_uuid()",
    "'invoice', 'X', gen_random_uuid()",
])
def test_a_movement_source_is_all_or_nothing(api, setup, engine, source):
    api.add(setup["bolt"], setup["main"], 5)
    with pytest.raises(IntegrityError, match="ck_stock_movements_source_consistent"):
        with engine.begin() as conn:
            conn.execute(text(
                "INSERT INTO stock_movements (id, organization_id, operation_id, product_id, warehouse_id, movement_type, quantity, balance_after, reason, "
                f"created_by, created_by_email, source_type, source_reference, source_line_id) SELECT gen_random_uuid(), organization_id, operation_id, "
                f"product_id, warehouse_id, movement_type, quantity, balance_after, reason, created_by, created_by_email, {source} FROM stock_movements"
            ))
