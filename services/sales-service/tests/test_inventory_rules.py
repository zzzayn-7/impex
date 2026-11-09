"""The most important rule: delivery lists never touch inventory. Plus: how the Inventory Service is called."""
import pytest

from conftest import LISTS


def run_a_whole_life(api, shop):
    """Every operation a delivery list offers, including repeated and failing ones."""
    acme = api.new_client("Acme Ltd")
    created = api.new_list(acme["id"], external_reference="PO-1")
    lid = created["id"]
    bolt = api.add(lid, shop["bolt"], 100).json()["item"]  # more than available
    flour = api.add(lid, shop["flour"], "1.5").json()["item"]
    api.add(lid, shop["bolt"], 1)  # duplicate scan (refused)
    api.add(lid, shop["old"], 1)  # archived (refused)
    api.client.patch(f"{LISTS}/{lid}/items/{bolt['id']}", json={"quantity": "20"}, headers=api.headers)
    api.client.post(f"{LISTS}/{lid}/items/{bolt['id']}/increase", json={"quantity": "5"}, headers=api.headers)
    api.client.delete(f"{LISTS}/{lid}/items/{flour['id']}", headers=api.headers)
    api.add(lid, shop["flour"], 2)
    api.status(lid, "ready")
    api.status(lid, "reopen")
    api.status(lid, "ready")
    api.detail(lid)
    api.status(lid, "cancel")
    return lid


def test_no_operation_changes_a_single_stock_quantity(api, shop, inventory):
    before = inventory.snapshot()
    assert before  # there is stock to protect
    run_a_whole_life(api, shop)
    assert inventory.snapshot() == before


def test_the_sales_service_only_ever_asks_for_reservations_and_reads_otherwise(api, shop, inventory):
    run_a_whole_life(api, shop)
    assert inventory.requests, "the inventory service should have been asked about products"
    assert inventory.deduction_writes() == []  # no dispatch was confirmed: nothing was deducted, ever
    # the only writes: booking / releasing stock for sales orders (never a stock in / out / opening)
    assert {(m, p) for m, p, _ in inventory.writes()} <= {("POST", "/api/v1/inventory/reservations"), ("POST", "/api/v1/inventory/reservations/release")}
    assert all(p == "/api/v1/inventory/stock/summary" or p.startswith("/api/v1/inventory/reservations/by-key/") for m, p, _ in inventory.requests if m == "GET")
    assert not any("/stock/in" in p or "/stock/out" in p or "/stock/opening" in p for _, p, _ in inventory.requests)


def test_no_endpoint_of_the_service_can_move_stock(client):
    spec = client.get("/openapi.json").json()
    for path in spec["paths"]:
        assert "deduct" not in path and "reserve" not in path and "/stock" not in path, path
    # Step 17A: dispatches, and only these routes (stock itself is never exposed here)
    assert {p for p in spec["paths"] if "dispatch" in p} == {
        "/api/v1/sales/dispatches", "/api/v1/sales/dispatches/{dispatch_id}", "/api/v1/sales/dispatches/{dispatch_id}/lines",
        "/api/v1/sales/dispatches/{dispatch_id}/confirm", "/api/v1/sales/dispatches/{dispatch_id}/cancel",
    }


def test_the_callers_own_token_is_what_the_inventory_service_receives(api, shop, inventory):
    lid = api.new_list(api.new_client("Acme Ltd")["id"])["id"]
    api.add(lid, shop["bolt"], 5)
    api.detail(lid)
    assert {token for _, _, token in inventory.requests} == {"admin-alpha"}  # forwarded as-is, never a service secret


def test_product_ids_are_revalidated_every_time_they_matter(api, shop, inventory):
    lid = api.new_list(api.new_client("Acme Ltd")["id"])["id"]
    item = api.add(lid, shop["bolt"], 5).json()["item"]
    inventory.requests.clear()
    api.client.patch(f"{LISTS}/{lid}/items/{item['id']}", json={"quantity": "6"}, headers=api.headers)
    api.status(lid, "ready")
    summaries = [r for r in inventory.requests if r[1].endswith("/stock/summary")]
    assert len(summaries) >= 2  # once for the edit, once for Ready


def test_saving_does_not_create_movements_anywhere(api, shop, inventory, session_factory):
    """The Sales database has no stock tables at all, and the inventory fake saw no write."""
    from sqlalchemy import inspect

    run_a_whole_life(api, shop)
    with session_factory() as db:
        tables = set(inspect(db.get_bind()).get_table_names())
    # delivery lists, dispatches and (Step 17B) invoices and payments: still no stock balance, movement or product table.
    # Stock lives in the Inventory Service.
    assert tables == {"alembic_version", "clients", "delivery_list_counters", "delivery_lists", "delivery_list_items",
                      "dispatches", "dispatch_lines", "dispatch_counters", "dispatch_requests",
                      "invoices", "invoice_lines", "invoice_allocations", "invoice_payments", "invoice_counters", "invoice_requests",
                      "sales_orders", "sales_order_counters", "sales_order_requests"}
    assert inventory.deduction_writes() == []


def test_the_notice_is_part_of_every_detail(api, shop):
    lid = api.new_list(api.new_client("Acme Ltd")["id"])["id"]
    notice = api.detail(lid)["stock_notice"]
    for phrase in ("reserves nothing", "books its quantities", "deducted only when a dispatch is confirmed"):
        assert phrase in notice


@pytest.mark.parametrize("path", ["dispatch", "reserve", "deduct", "ship"])
def test_there_is_no_dispatch_yet(api, path):
    lid = api.new_list(api.new_client("Acme Ltd")["id"])["id"]
    assert api.client.post(f"{LISTS}/{lid}/{path}", headers=api.headers).status_code in (404, 405)
