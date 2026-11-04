"""Stock balances and the movement ledger: the arithmetic, the refusals, retries, concurrency and transfer atomicity."""
import threading
import uuid
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app import stock
from app.auth import TenantContext
from app.models import StockBalance, StockMovement, StockOperation
from app.schemas import StockChange, StockTransfer

from conftest import STOCK_URL, bearer


@pytest.fixture
def setup(api):
    """One product (pieces) and two warehouses."""
    return {"product": api.product(sku="BOLT", name="Bolt", unit="pcs"), "main": api.warehouse("MAIN"), "annex": api.warehouse("ANNEX")}


def db_state(session_factory):
    with session_factory() as db:
        balances = {(b.product_id, b.warehouse_id): b.quantity for b in db.scalars(select(StockBalance))}
        movements = db.scalars(select(StockMovement).order_by(StockMovement.created_at, StockMovement.id)).all()
    return balances, movements


def snapshot(session_factory):
    """Plain values (not ORM objects) so two states can be compared for equality."""
    balances, movements = db_state(session_factory)
    return balances, [(m.id, m.product_id, m.warehouse_id, m.movement_type, m.quantity, m.balance_after) for m in movements]


# --- the arithmetic --------------------------------------------------------------------------------------
def test_opening_in_and_out_adjust_the_balance_exactly(api, setup):
    product, main = setup["product"], setup["main"]
    api.add(product, main, 100, action="opening")
    api.add(product, main, 25, action="in")
    api.add(product, main, 40, action="out")
    assert api.quantity(product, main) == "85.0000"

    kinds = [(m["movement_type"], m["quantity"], m["balance_after"]) for m in reversed(api.movements()["items"])]
    assert kinds == [("opening", "100.0000", "100.0000"), ("in", "25.0000", "125.0000"), ("out", "40.0000", "85.0000")]


def test_a_movement_records_who_what_where_why_and_when(api, setup):
    result = api.add(setup["product"], setup["main"], 7, action="in", reason="Supplier delivery #42")
    assert result["kind"] == "in" and result["replayed"] is False
    (movement,) = result["movements"]
    assert movement["reason"] == "Supplier delivery #42"
    assert movement["created_by_email"] == "admin-alpha@example.org"
    assert (movement["product_sku"], movement["warehouse_code"], movement["product_unit"]) == ("BOLT", "MAIN", "pcs")
    assert movement["created_at"] and "organization_id" not in movement
    assert api.add(setup["product"], setup["main"], 1)["movements"][0]["reason"] == "Stock in"  # a sensible default


def test_decimal_quantities_are_exact_for_measurable_units(api):
    oil, tank = api.product(sku="OIL", name="Palm oil", unit="litre"), api.warehouse("TANK")
    for _ in range(10):
        api.add(oil, tank, "0.1")  # floats would give 0.9999999999999999
    assert api.quantity(oil, tank) == "1.0000"
    api.add(oil, tank, "0.3333", action="out")
    assert api.quantity(oil, tank) == "0.6667"


def test_the_same_product_can_be_held_in_many_warehouses(api, setup):
    api.add(setup["product"], setup["main"], 10)
    api.add(setup["product"], setup["annex"], 4)
    (item,) = api.client.get(STOCK_URL, headers=api.headers).json()["items"]
    assert item["total_quantity"] == "14.0000"
    assert {(line["warehouse_code"], line["quantity"]) for line in item["lines"]} == {("MAIN", "10.0000"), ("ANNEX", "4.0000")}


def test_creating_a_product_creates_no_stock(api):
    product = api.product(sku="NEW")
    (item,) = api.client.get(STOCK_URL, headers=api.headers).json()["items"]
    assert item["product_id"] == product["id"] and item["total_quantity"] == "0" and item["lines"] == []
    assert api.movements()["total"] == 0


# --- refusals --------------------------------------------------------------------------------------------
def test_stock_never_goes_negative(api, setup, session_factory):
    product, main = setup["product"], setup["main"]
    api.add(product, main, 5)
    refused = api.change("out", product_id=product["id"], warehouse_id=main["id"], quantity="6")
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Insufficient stock: 5 pcs of Bolt available in MAIN, 6 requested."
    assert api.change("out", product_id=product["id"], warehouse_id=main["id"], quantity="5").status_code == 201  # exactly all of it is fine
    assert api.change("out", product_id=product["id"], warehouse_id=main["id"], quantity="0.0001").status_code == 422  # and pieces are whole
    assert api.quantity(product, main) == "0"
    balances, movements = db_state(session_factory)
    assert all(q >= 0 for q in balances.values()) and len(movements) == 2  # the refused attempts left no trace


def test_removing_stock_that_was_never_there_is_refused(api, setup):
    refused = api.change("out", product_id=setup["product"]["id"], warehouse_id=setup["main"]["id"], quantity="1")
    assert refused.status_code == 409 and "0 pcs" in refused.json()["detail"]
    assert api.movements()["total"] == 0


@pytest.mark.parametrize("quantity", ["0", "-1", "-0.5", "abc", "", None, "1.00001", "NaN", "Infinity", "1" + "0" * 15])
def test_invalid_quantities_are_rejected(api, setup, quantity, session_factory):
    response = api.change("in", product_id=setup["product"]["id"], warehouse_id=setup["main"]["id"], quantity=quantity)
    assert response.status_code == 422
    assert db_state(session_factory) == ({}, [])


@pytest.mark.parametrize("unit", ["pcs", "box", "carton", "pallet", "dozen", "set", "pair", "bag", "something-custom"])
def test_indivisible_units_reject_fractions(api, unit):
    product, warehouse = api.product(sku="X", unit=unit), api.warehouse("W")
    response = api.change("in", product_id=product["id"], warehouse_id=warehouse["id"], quantity="1.5")
    assert response.status_code == 422 and "whole number" in response.json()["detail"]
    assert api.add(product, warehouse, "2.0000")["movements"][0]["quantity"] == "2.0000"  # whole numbers are fine, however written
    assert product["unit_allows_fractions"] is False


@pytest.mark.parametrize("unit", ["kg", "g", "litre", "l", "ml", "m", "cm", "tonne"])
def test_measurable_units_allow_fractions(api, unit):
    product, warehouse = api.product(sku="X", unit=unit), api.warehouse("W")
    assert product["unit_allows_fractions"] is True
    assert api.add(product, warehouse, "1.5")["movements"][0]["quantity"] == "1.5000"


def test_fractions_are_refused_for_transfers_too(api, setup):
    api.add(setup["product"], setup["main"], 5)
    response = api.transfer(setup["product"], setup["main"], setup["annex"], "0.5")
    assert response.status_code == 422
    assert api.quantity(setup["product"], setup["main"]) == "5.0000"


def test_an_opening_balance_is_only_allowed_before_other_movements(api, setup):
    product, main, annex = setup["product"], setup["main"], setup["annex"]
    api.add(product, main, 10, action="in")
    refused = api.change("opening", product_id=product["id"], warehouse_id=main["id"], quantity="5")
    assert refused.status_code == 409 and "opening balance" in refused.json()["detail"].lower()
    api.add(product, annex, 3, action="opening")
    assert api.change("opening", product_id=product["id"], warehouse_id=annex["id"], quantity="3").status_code == 409  # not twice either
    assert api.quantity(product, main) == "10.0000" and api.quantity(product, annex) == "3.0000"


def test_archived_products_and_warehouses_cannot_be_changed(api, setup):
    product, main, annex = setup["product"], setup["main"], setup["annex"]
    api.add(product, main, 10)
    api.client.post(f"/api/v1/inventory/warehouses/{annex['id']}/archive", headers=api.headers)
    for response in (
        api.change("in", product_id=product["id"], warehouse_id=annex["id"], quantity="1"),
        api.change("out", product_id=product["id"], warehouse_id=annex["id"], quantity="1"),
        api.transfer(product, main, annex, 1),
        api.transfer(product, annex, main, 1),
    ):
        assert response.status_code == 409 and "ANNEX" in response.json()["detail"] and "archived" in response.json()["detail"]

    api.client.post(f"/api/v1/inventory/products/{product['id']}/archive", headers=api.headers)
    assert api.change("in", product_id=product["id"], warehouse_id=main["id"], quantity="1").status_code == 409
    assert api.change("out", product_id=product["id"], warehouse_id=main["id"], quantity="1").status_code == 409
    assert api.quantity(product, main) == "10.0000"  # unchanged, still visible, history intact

    api.client.post(f"/api/v1/inventory/products/{product['id']}/restore", headers=api.headers)
    assert api.change("in", product_id=product["id"], warehouse_id=main["id"], quantity="1").status_code == 201


def test_unknown_products_and_warehouses_are_404(api, setup):
    ghost = str(uuid.uuid4())
    assert api.change("in", product_id=ghost, warehouse_id=setup["main"]["id"], quantity="1").status_code == 404
    assert api.change("in", product_id=setup["product"]["id"], warehouse_id=ghost, quantity="1").status_code == 404
    assert api.transfer(setup["product"], setup["main"], {"id": ghost}, 1).status_code == 404


def test_stock_requests_accept_no_organization_or_balance_fields(api, setup):
    base = dict(product_id=setup["product"]["id"], warehouse_id=setup["main"]["id"], quantity="1")
    for extra in ({"organization_id": str(uuid.uuid4())}, {"balance_after": "999"}, {"movement_type": "in"}, {"created_by": "x"}):
        assert api.change("in", **base, **extra).status_code == 422


# --- idempotency -----------------------------------------------------------------------------------------
def test_the_idempotency_key_is_required_and_validated(api, setup):
    body = dict(product_id=setup["product"]["id"], warehouse_id=setup["main"]["id"], quantity="1")
    url = f"{STOCK_URL}/in"
    assert api.client.post(url, json=body, headers=api.headers).status_code == 400
    for bad in ("short", "has space in it", "x" * 101, "bad/chars!"):
        assert api.client.post(url, json=body, headers={**api.headers, "Idempotency-Key": bad}).status_code == 400
    assert api.movements()["total"] == 0


def test_a_retry_with_the_same_key_is_applied_once_and_replays_the_first_answer(api, setup):
    body = dict(product_id=setup["product"]["id"], warehouse_id=setup["main"]["id"], quantity="10")
    first = api.change("in", key="retry-me-0001", **body)
    second = api.change("in", key="retry-me-0001", **body)
    third = api.change("in", key="retry-me-0001", **body)
    assert (first.status_code, second.status_code, third.status_code) == (201, 200, 200)
    assert first.json()["replayed"] is False and second.json()["replayed"] is True
    assert second.json()["operation_id"] == first.json()["operation_id"]
    assert [m["id"] for m in second.json()["movements"]] == [m["id"] for m in first.json()["movements"]]
    assert api.quantity(setup["product"], setup["main"]) == "10.0000"
    assert api.movements()["total"] == 1


def test_a_replay_still_works_when_the_stock_has_since_changed(api, setup):
    body = dict(product_id=setup["product"]["id"], warehouse_id=setup["main"]["id"], quantity="10")
    api.change("in", key="retry-me-0002", **body)
    api.add(setup["product"], setup["main"], 10, action="out")  # now empty
    replay = api.change("out", key="other-key-0001", **body)
    assert replay.status_code == 409  # genuinely insufficient...
    again = api.change("in", key="retry-me-0002", **body)
    assert again.status_code == 200 and again.json()["replayed"] is True  # ...but the first request's answer never changes


def test_reusing_a_key_for_a_different_request_is_refused(api, setup):
    product, main = setup["product"], setup["main"]
    api.change("in", key="shared-key-01", product_id=product["id"], warehouse_id=main["id"], quantity="10")
    for action, quantity in (("in", "11"), ("out", "10")):
        clash = api.change(action, key="shared-key-01", product_id=product["id"], warehouse_id=main["id"], quantity=quantity)
        assert clash.status_code == 409 and "different request" in clash.json()["detail"]
    assert api.quantity(product, main) == "10.0000"


def test_a_failed_request_does_not_burn_its_key(api, setup):
    product, main = setup["product"], setup["main"]
    body = dict(product_id=product["id"], warehouse_id=main["id"], quantity="5")
    assert api.change("out", key="burn-test-01", **body).status_code == 409  # nothing to remove yet
    api.add(product, main, 5)
    assert api.change("out", key="burn-test-01", **body).status_code == 201  # same key, now it can succeed
    assert api.quantity(product, main) == "0"


def test_the_same_key_in_two_organizations_is_independent(two_orgs):
    results = []
    for who in ("alpha", "beta"):
        org = two_orgs[who]
        product, warehouse = org.product(sku="P"), org.warehouse("W")
        results.append(org.change("in", key="same-key-0001", product_id=product["id"], warehouse_id=warehouse["id"], quantity="3"))
    assert [r.status_code for r in results] == [201, 201]


# --- transfers -------------------------------------------------------------------------------------------
def test_a_transfer_moves_stock_with_two_linked_movements(api, setup):
    product, main, annex = setup["product"], setup["main"], setup["annex"]
    api.add(product, main, 20)
    response = api.transfer(product, main, annex, 8, reason="Rebalance")
    assert response.status_code == 201
    out, into = response.json()["movements"]  # outgoing first, then incoming
    assert (into["movement_type"], into["warehouse_code"], into["balance_after"]) == ("transfer_in", "ANNEX", "8.0000")
    assert (out["movement_type"], out["warehouse_code"], out["balance_after"]) == ("transfer_out", "MAIN", "12.0000")
    assert out["transfer_id"] == into["transfer_id"] is not None
    assert out["operation_id"] == into["operation_id"] == response.json()["operation_id"]
    assert (api.quantity(product, main), api.quantity(product, annex)) == ("12.0000", "8.0000")
    assert api.movements(type="transfer_in")["total"] == 1 and api.movements(type="transfer_out")["total"] == 1


def test_transfers_conserve_the_total(api, setup):
    product, main, annex = setup["product"], setup["main"], setup["annex"]
    api.add(product, main, 50)
    for source, destination, quantity in ((main, annex, 20), (annex, main, 5), (main, annex, 1)):
        assert api.transfer(product, source, destination, quantity).status_code == 201
    (item,) = api.client.get(STOCK_URL, headers=api.headers).json()["items"]
    assert item["total_quantity"] == "50.0000"


def test_a_transfer_with_insufficient_stock_changes_nothing(api, setup, session_factory):
    product, main, annex = setup["product"], setup["main"], setup["annex"]
    api.add(product, main, 3)
    before = snapshot(session_factory)
    response = api.transfer(product, main, annex, 4)
    assert response.status_code == 409 and "3 pcs of Bolt available in MAIN" in response.json()["detail"]
    assert snapshot(session_factory) == before


def test_a_transfer_to_the_same_warehouse_is_refused(api, setup):
    api.add(setup["product"], setup["main"], 3)
    response = api.transfer(setup["product"], setup["main"], setup["main"], 1)
    assert response.status_code == 422 and api.movements()["total"] == 1


def test_a_transfer_is_atomic_when_the_second_half_fails(api, setup, session_factory, monkeypatch):
    """If anything fails after the source was debited, nothing at all may remain: no balance change, no movement."""
    product, main, annex = setup["product"], setup["main"], setup["annex"]
    api.add(product, main, 10)
    before = snapshot(session_factory)

    real = stock._add_movement
    calls = []

    def explode_on_the_incoming_movement(*args, **kwargs):
        calls.append(args[5])
        if args[5] == "transfer_in":
            raise RuntimeError("disk on fire")
        return real(*args, **kwargs)

    monkeypatch.setattr(stock, "_add_movement", explode_on_the_incoming_movement)
    with pytest.raises(RuntimeError):
        api.client.raise_server_exceptions = True
        api.transfer(product, main, annex, 4)
    assert calls == ["transfer_out", "transfer_in"]  # the debit really had happened before the failure
    monkeypatch.undo()

    assert snapshot(session_factory) == before
    with session_factory() as db:
        assert db.scalar(select(StockOperation).where(StockOperation.kind == "transfer")) is None  # the key was not consumed
    assert api.transfer(product, main, annex, 4).status_code == 201  # and the retry works


def test_the_database_alone_refuses_a_transfer_that_does_not_balance(api, setup, session_factory):
    """Belt and braces: a transfer movement must carry a transfer id; an in/out movement must not."""
    api.add(setup["product"], setup["main"], 5)
    with session_factory() as db:
        movement = db.scalar(select(StockMovement))
        with pytest.raises(IntegrityError):
            db.execute(text("INSERT INTO stock_movements (id, organization_id, operation_id, product_id, warehouse_id, movement_type, "
                            "quantity, balance_after, reason, created_by, created_by_email) VALUES (gen_random_uuid(), :o, :op, :p, :w, "
                            "'transfer_out', 1, 4, 'x', :u, 'x@x')"),
                       {"o": movement.organization_id, "op": movement.operation_id, "p": movement.product_id, "w": movement.warehouse_id, "u": movement.created_by})
            db.commit()


# --- the ledger is append-only ---------------------------------------------------------------------------
def test_there_is_no_api_to_edit_or_delete_a_movement(api, setup):
    movement = api.add(setup["product"], setup["main"], 5)["movements"][0]
    for method in ("put", "patch", "delete"):
        for url in (f"{STOCK_URL}/movements/{movement['id']}", f"{STOCK_URL}/movements"):
            assert getattr(api.client, method)(url, headers=api.headers).status_code in (404, 405)
    assert api.movements()["total"] == 1


def test_the_database_refuses_to_update_or_delete_ledger_rows(api, setup, session_factory):
    api.add(setup["product"], setup["main"], 5)
    for statement in ("UPDATE stock_movements SET quantity = 999", "UPDATE stock_movements SET reason = 'edited'",
                      "DELETE FROM stock_movements", "UPDATE stock_movements SET created_at = now() - interval '1 year'"):
        with session_factory() as db:
            with pytest.raises(DBAPIError) as caught:
                db.execute(text(statement))
                db.commit()
            assert "append-only" in str(caught.value)
    balances, movements = db_state(session_factory)
    assert len(movements) == 1 and movements[0].quantity == Decimal("5")


def test_the_database_refuses_negative_balances_and_non_positive_movements(api, setup, session_factory):
    api.add(setup["product"], setup["main"], 5)
    with session_factory() as db:
        with pytest.raises(IntegrityError):
            db.execute(text("UPDATE stock_balances SET quantity = -1"))
            db.commit()
    with session_factory() as db:
        movement = db.scalar(select(StockMovement))
        for quantity, after in ((0, 1), (-1, 1), (1, -1)):
            with pytest.raises(IntegrityError):
                db.execute(text("INSERT INTO stock_movements (id, organization_id, operation_id, product_id, warehouse_id, movement_type, "
                                "quantity, balance_after, reason, created_by, created_by_email) VALUES (gen_random_uuid(), :o, :op, :p, :w, "
                                "'in', :q, :a, 'x', :u, 'x@x')"),
                           {"o": movement.organization_id, "op": movement.operation_id, "p": movement.product_id,
                            "w": movement.warehouse_id, "q": quantity, "a": after, "u": movement.created_by})
                db.commit()
            db.rollback()


def test_the_ledger_always_explains_the_balance(api, setup, session_factory):
    product, main, annex = setup["product"], setup["main"], setup["annex"]
    api.add(product, main, 100, action="opening")
    api.add(product, main, 30, action="out")
    api.transfer(product, main, annex, 25)
    api.add(product, annex, 5, action="in")
    api.add(product, annex, 2, action="out")
    balances, movements = db_state(session_factory)
    credit = {"opening", "in", "transfer_in"}
    for (product_id, warehouse_id), quantity in balances.items():
        ledger = sum((m.quantity if m.movement_type in credit else -m.quantity)
                     for m in movements if (m.product_id, m.warehouse_id) == (product_id, warehouse_id))
        assert ledger == quantity


# --- history filters -------------------------------------------------------------------------------------
def test_history_can_be_filtered_by_product_warehouse_and_type(api, setup):
    bolt, main, annex = setup["product"], setup["main"], setup["annex"]
    nut = api.product(sku="NUT", name="Nut")
    api.add(bolt, main, 10)
    api.add(nut, main, 5)
    api.add(nut, annex, 5, action="opening")
    api.add(bolt, main, 2, action="out")
    api.transfer(bolt, main, annex, 3)

    assert api.movements()["total"] == 6
    assert api.movements(product_id=nut["id"])["total"] == 2
    assert api.movements(warehouse_id=annex["id"])["total"] == 2
    assert api.movements(product_id=bolt["id"], warehouse_id=main["id"])["total"] == 3
    assert api.movements(type="out")["total"] == 1 and api.movements(type="opening")["total"] == 1
    assert api.movements(product_id=bolt["id"], type="transfer_in")["items"][0]["warehouse_code"] == "ANNEX"
    newest_first = api.movements()["items"]
    assert [m["created_at"] for m in newest_first] == sorted((m["created_at"] for m in newest_first), reverse=True)
    assert len(api.movements(limit=2)["items"]) == 2 and api.movements(limit=2, offset=5)["items"].__len__() == 1
    assert api.client.get(f"{STOCK_URL}/movements", params={"type": "bogus"}, headers=api.headers).status_code == 422


def test_the_overview_filters_and_sums(api, setup):
    bolt, main, annex = setup["product"], setup["main"], setup["annex"]
    nut = api.product(sku="NUT", name="Nut", category="Fasteners")
    api.product(sku="EMPTY", name="Nothing here")
    api.add(bolt, main, 10)
    api.add(bolt, annex, 4)
    api.add(nut, annex, 7)

    def skus(**params):
        body = api.client.get(STOCK_URL, params=params, headers=api.headers).json()
        return sorted(i["sku"] for i in body["items"]), body["total"]

    assert skus() == (["BOLT", "EMPTY", "NUT"], 3)
    assert skus(in_stock_only="true") == (["BOLT", "NUT"], 2)
    assert skus(warehouse_id=main["id"]) == (["BOLT"], 1)
    assert skus(warehouse_id=annex["id"]) == (["BOLT", "NUT"], 2)
    assert skus(category="fasteners") == (["NUT"], 1)
    assert skus(q="nu") == (["NUT"], 1)

    api.client.post(f"/api/v1/inventory/warehouses/{annex['id']}/archive", headers=api.headers)
    item = next(i for i in api.client.get(STOCK_URL, headers=api.headers).json()["items"] if i["sku"] == "BOLT")
    assert (item["total_quantity"], item["available_quantity"]) == ("14.0000", "10.0000")  # archived warehouse stock is not "available"


# --- concurrency -----------------------------------------------------------------------------------------
def run_in_parallel(session_factory, jobs):
    """Run each job (a function taking a fresh Session) on its own thread and its own connection, all at once."""
    barrier = threading.Barrier(len(jobs))
    outcomes = [None] * len(jobs)

    def work(index, job):
        db = session_factory()
        try:
            barrier.wait()
            outcomes[index] = ("ok", job(db))
        except HTTPException as exc:
            outcomes[index] = ("http", exc.status_code)
        except Exception as exc:  # pragma: no cover - reported by the assertions
            outcomes[index] = ("error", repr(exc))
        finally:
            db.close()

    threads = [threading.Thread(target=work, args=(i, job)) for i, job in enumerate(jobs)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    return outcomes


def tenant_for(two_orgs, directory_user="admin-alpha", org="alpha_id", directory=None):
    return TenantContext(organization_id=uuid.UUID(two_orgs[org]), user_id=str(uuid.uuid4()), email="parallel@example.org", full_name="P")


def test_concurrent_deductions_can_never_overdraw_the_stock(api, two_orgs, setup, session_factory):
    product, main = setup["product"], setup["main"]
    api.add(product, main, 10)
    tenant = tenant_for(two_orgs)
    payload = StockChange(product_id=product["id"], warehouse_id=main["id"], quantity="3")
    jobs = [lambda db, i=i: stock.execute_change(db, tenant, "out", payload, f"parallel-out-{i:02d}") for i in range(8)]

    outcomes = run_in_parallel(session_factory, jobs)

    assert [o for o in outcomes if o[0] == "error"] == []
    succeeded = [o for o in outcomes if o[0] == "ok"]
    refused = [o for o in outcomes if o == ("http", 409)]
    assert len(succeeded) == 3 and len(refused) == 5  # 10 pieces: exactly three removals of 3 fit
    assert api.quantity(product, main) == "1.0000"
    balances, movements = db_state(session_factory)
    assert len(movements) == 1 + 3 and all(q >= 0 for q in balances.values())


def test_concurrent_duplicates_of_one_request_apply_once(api, two_orgs, setup, session_factory):
    product, main = setup["product"], setup["main"]
    tenant = tenant_for(two_orgs)
    payload = StockChange(product_id=product["id"], warehouse_id=main["id"], quantity="5")
    jobs = [lambda db: stock.execute_change(db, tenant, "in", payload, "double-click-0001") for _ in range(6)]

    outcomes = run_in_parallel(session_factory, jobs)

    assert [o for o in outcomes if o[0] != "ok"] == []
    results = [o[1] for o in outcomes]
    assert sorted(r.replayed for r in results) == [False] + [True] * 5
    assert len({r.operation_id for r in results}) == 1
    assert api.quantity(product, main) == "5.0000" and api.movements()["total"] == 1


def test_opposite_transfers_at_the_same_time_do_not_deadlock_or_lose_stock(api, two_orgs, setup, session_factory):
    product, main, annex = setup["product"], setup["main"], setup["annex"]
    api.add(product, main, 50)
    api.add(product, annex, 50)
    tenant = tenant_for(two_orgs)
    forward = StockTransfer(product_id=product["id"], from_warehouse_id=main["id"], to_warehouse_id=annex["id"], quantity="1")
    backward = StockTransfer(product_id=product["id"], from_warehouse_id=annex["id"], to_warehouse_id=main["id"], quantity="1")
    jobs = [lambda db, i=i: stock.execute_transfer(db, tenant, forward if i % 2 else backward, f"swap-{i:03d}-key") for i in range(12)]

    outcomes = run_in_parallel(session_factory, jobs)

    assert [o for o in outcomes if o[0] != "ok"] == []
    balances, movements = db_state(session_factory)
    assert sum(balances.values()) == 100 and all(q >= 0 for q in balances.values())
    assert len(movements) == 2 + 24


def test_concurrent_deductions_by_two_organizations_do_not_interfere(two_orgs, session_factory):
    setups = {}
    for who in ("alpha", "beta"):
        org = two_orgs[who]
        setups[who] = (org.product(sku="P"), org.warehouse("W"), org)
        org.add(setups[who][0], setups[who][1], 4)
    jobs = []
    for who, org_key in (("alpha", "alpha_id"), ("beta", "beta_id")):
        product, warehouse, _ = setups[who]
        tenant = tenant_for(two_orgs, org=org_key)
        payload = StockChange(product_id=product["id"], warehouse_id=warehouse["id"], quantity="1")
        jobs += [lambda db, t=tenant, p=payload, i=i, w=who: stock.execute_change(db, t, "out", p, f"{w}-parallel-{i:02d}") for i in range(4)]
    outcomes = run_in_parallel(session_factory, jobs)
    assert [o for o in outcomes if o[0] != "ok"] == []
    assert all(setups[w][2].quantity(setups[w][0], setups[w][1]) == "0" for w in setups)
