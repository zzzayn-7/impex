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


def test_the_sales_service_only_ever_reads_from_the_inventory_service(api, shop, inventory):
    run_a_whole_life(api, shop)
    assert inventory.requests, "the inventory service should have been asked about products"
    assert inventory.writes() == []  # not one POST / PATCH / PUT / DELETE
    assert {(m, p) for m, p, _ in inventory.requests} <= {
        ("GET", "/api/v1/inventory/stock/summary"),
        *{("GET", f"/api/v1/inventory/warehouses/{w}") for w in (shop["main"], shop["annex"])},
    }
    assert not any("/stock/in" in p or "/stock/out" in p or "/stock/transfer" in p or "/stock/opening" in p for _, p, _ in inventory.requests)


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
    # delivery lists and dispatches only: still no stock balance, movement or product table. Stock lives in the Inventory Service.
    assert tables == {"alembic_version", "clients", "delivery_list_counters", "delivery_lists", "delivery_list_items",
                      "dispatches", "dispatch_lines", "dispatch_counters", "dispatch_requests"}
    assert inventory.writes() == []


def test_the_notice_is_part_of_every_detail(api, shop):
    lid = api.new_list(api.new_client("Acme Ltd")["id"])["id"]
    notice = api.detail(lid)["stock_notice"]
    for phrase in ("not reserved", "never changes inventory", "may change before dispatch"):
        assert phrase in notice


@pytest.mark.parametrize("path", ["dispatch", "reserve", "deduct", "ship"])
def test_there_is_no_dispatch_yet(api, path):
    lid = api.new_list(api.new_client("Acme Ltd")["id"])["id"]
    assert api.client.post(f"{LISTS}/{lid}/{path}", headers=api.headers).status_code in (404, 405)
