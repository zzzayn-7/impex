"""The most important rule: a purchase order never touches inventory - no stock, no movements, no prices."""
import pytest

from conftest import ORDERS


def run_a_whole_life(api, shop):
    """Every operation a purchase order offers, including repeated and failing ones."""
    acme = api.supplier("Acme Supplies")
    created = api.order(acme["id"], currency="EUR", supplier_reference="Q-1")
    oid = created["id"]
    bolt = api.add(oid, shop["bolt"], 50, "1.25").json()["line"]  # ORDER 50 UNITS
    flour = api.add(oid, shop["flour"], "2.5", "3.10").json()["line"]
    api.add(oid, shop["bolt"], 1, "9")  # duplicate (refused)
    api.add(oid, shop["old"], 1, "1")  # archived (refused)
    api.add(oid, shop["flour"], "1.5", "x")  # invalid (refused)
    api.client.patch(f"{ORDERS}/{oid}/lines/{bolt['id']}", json={"quantity": "60", "unit_price": "1.10"}, headers=api.headers)
    api.client.delete(f"{ORDERS}/{oid}/lines/{flour['id']}", headers=api.headers)
    api.add(oid, shop["flour"], 2, "4")
    api.client.patch(f"{ORDERS}/{oid}", json={"notes": "updated", "supplier_reference": "Q-2"}, headers=api.headers)
    api.action(oid, "order")
    api.action(oid, "order")
    api.detail(oid)
    api.action(oid, "cancel")
    second = api.order(acme["id"])
    api.add(second["id"], shop["bolt"], 7, "2")
    api.action(second["id"], "cancel")
    return oid


def test_ordering_50_units_does_not_add_a_single_unit_of_stock(api, shop, inventory):
    before = inventory.snapshot()
    assert before
    created = api.order(api.supplier("Acme")["id"])
    api.add(created["id"], shop["bolt"], 50, "1.25")
    api.action(created["id"], "order")
    assert inventory.snapshot() == before  # still 40 bolts
    assert inventory.stock[(shop["bolt"], shop["main"])] == 40


def test_no_operation_changes_a_single_stock_quantity(api, shop, inventory):
    before = inventory.snapshot()
    run_a_whole_life(api, shop)
    assert inventory.snapshot() == before


def test_the_purchasing_service_only_ever_reads_from_the_inventory_service(api, shop, inventory):
    run_a_whole_life(api, shop)
    assert inventory.requests, "the inventory service should have been asked about products"
    assert inventory.writes() == []  # not one POST / PATCH / PUT / DELETE: no stock, no movements, no product edits
    assert {(m, p) for m, p, _ in inventory.requests} <= {
        ("GET", "/api/v1/inventory/stock/summary"),
        *{("GET", f"/api/v1/inventory/warehouses/{w}") for w in (shop["main"], shop["annex"])},
    }
    assert not any("/stock/in" in p or "/stock/opening" in p or "/stock/transfer" in p or "/movements" in p for _, p, _ in inventory.requests)


def test_product_prices_are_never_overwritten_by_purchase_prices(api, shop, inventory):
    before = {pid: dict(p) for pid, p in inventory.products[shop["org"]].items()}
    run_a_whole_life(api, shop)  # purchase prices of 1.25, 1.10, 3.10 ... were entered
    assert inventory.products[shop["org"]] == before
    assert inventory.products[shop["org"]][shop["bolt"]]["selling_price"] == "9.9900" and inventory.products[shop["org"]][shop["bolt"]]["cost_price"] == "5.0000"
    assert inventory.writes() == []


def test_the_service_has_no_stock_or_price_endpoints_at_all(client):
    spec = client.get("/openapi.json").json()
    for path in spec["paths"]:
        assert not any(word in path for word in ("receive", "/stock", "movement", "invoice", "payment", "price-list")), path
        if "receipt" in path:  # Step 16B: goods receipts, and only these routes (stock itself is never exposed here)
            assert path.startswith("/api/v1/purchasing/goods-receipts"), path
    receipt_paths = {p for p in spec["paths"] if "receipt" in p}
    assert receipt_paths == {
        "/api/v1/purchasing/goods-receipts", "/api/v1/purchasing/goods-receipts/{receipt_id}", "/api/v1/purchasing/goods-receipts/{receipt_id}/lines",
        "/api/v1/purchasing/goods-receipts/{receipt_id}/confirm", "/api/v1/purchasing/goods-receipts/{receipt_id}/cancel",
    }


def test_the_callers_own_token_is_what_the_inventory_service_receives(api, shop, inventory):
    created = api.order(api.supplier("Acme")["id"])
    api.add(created["id"], shop["bolt"], 5, "1")
    api.action(created["id"], "order")
    assert {token for _, _, token in inventory.requests} == {"admin-alpha"}  # forwarded as-is, never a service secret


def test_product_ids_are_revalidated_when_it_matters(api, shop, inventory):
    created = api.order(api.supplier("Acme")["id"])
    line = api.add(created["id"], shop["bolt"], 5, "2").json()["line"]
    inventory.requests.clear()
    api.client.patch(f"{ORDERS}/{created['id']}/lines/{line['id']}", json={"quantity": "6"}, headers=api.headers)
    api.action(created["id"], "order")
    assert len([r for r in inventory.requests if r[1].endswith("/stock/summary")]) >= 2  # once for the edit, once when placing the order


def test_the_purchasing_database_has_no_stock_tables(api, shop, session_factory):
    from sqlalchemy import inspect

    run_a_whole_life(api, shop)
    with session_factory() as db:
        tables = set(inspect(db.get_bind()).get_table_names())
    # purchase orders and goods receipts only: still no stock balance, movement or product table. Stock lives in the Inventory Service.
    assert tables == {"alembic_version", "suppliers", "purchase_orders", "purchase_order_lines", "purchase_order_counters", "purchase_order_requests",
                      "goods_receipts", "goods_receipt_lines", "goods_receipt_counters", "goods_receipt_requests"}


def test_the_notice_is_part_of_every_detail(api, shop):
    detail = api.detail(api.order(api.supplier("Acme")["id"])["id"])
    for phrase in ("does not change your stock", "does not add the goods to inventory", "received"):
        assert phrase in detail["stock_notice"]
