"""Products on a delivery list: adding, explicit quantities, duplicates, editing, removing."""
import uuid

import pytest
from sqlalchemy import select

from app.models import DeliveryListItem

from conftest import LISTS


@pytest.fixture
def draft(api, shop):
    return api.new_list(api.new_client("Acme Ltd")["id"])


def item_url(draft, item_id, tail=""):
    return f"{LISTS}/{draft['id']}/items/{item_id}{tail}"


def test_adding_a_product_takes_its_details_from_the_inventory_service(api, shop, draft, session_factory):
    response = api.add(draft["id"], shop["bolt"], 12)
    assert response.status_code == 201
    body = response.json()
    item = body["item"]
    assert (item["product_id"], item["product_sku"], item["product_name"], item["unit"], item["quantity"]) == (shop["bolt"], "BOLT-1", "Steel bolt", "pcs", "12.0000")
    assert body["item_count"] == 1 and "not reserved" in body["stock_notice"]
    assert (item["stock"]["total_quantity"], item["stock"]["exceeds_available"]) == ("50", False) and "available_quantity" not in item["stock"]
    with session_factory() as db:
        (row,) = db.scalars(select(DeliveryListItem)).all()
    assert str(row.organization_id) == api.org_id and (row.product_sku, row.product_name, row.unit) == ("BOLT-1", "Steel bolt", "pcs")


def test_several_products_on_one_client_list(api, shop, draft):
    api.add(draft["id"], shop["bolt"], 12)
    api.add(draft["id"], shop["flour"], "1.5")
    detail = api.detail(draft["id"])
    assert detail["item_count"] == 2
    assert {(i["product_sku"], i["quantity"]) for i in detail["items"]} == {("BOLT-1", "12.0000"), ("FLOUR", "1.5000")}
    assert [i["product_sku"] for i in detail["items"]] == ["BOLT-1", "FLOUR"]  # in the order they were added


def test_the_browser_cannot_dictate_product_details_stock_or_ownership(api, shop, draft):
    base = {"product_id": shop["bolt"], "quantity": "1"}
    for extra in ({"product_name": "Hacked"}, {"product_sku": "X"}, {"unit": "kg"}, {"total_quantity": "999999"}, {"stock": {"available": 5}},
                  {"organization_id": str(uuid.uuid4())}, {"delivery_list_id": str(uuid.uuid4())}, {"planned_warehouse_id": str(uuid.uuid4())}):
        assert api.client.post(f"{LISTS}/{draft['id']}/items", json={**base, **extra}, headers=api.headers).status_code == 422
    assert api.detail(draft["id"])["item_count"] == 0


@pytest.mark.parametrize("quantity", ["0", "-1", "-0.5", "abc", "", None, "1.00001", "NaN", "Infinity", "1" + "0" * 15])
def test_invalid_quantities_are_rejected(api, shop, draft, quantity):
    response = api.client.post(f"{LISTS}/{draft['id']}/items", json={"product_id": shop["bolt"], "quantity": quantity}, headers=api.headers)
    assert response.status_code == 422
    assert api.detail(draft["id"])["item_count"] == 0


def test_a_missing_quantity_is_not_assumed_to_be_one(api, shop, draft):
    response = api.client.post(f"{LISTS}/{draft['id']}/items", json={"product_id": shop["bolt"]}, headers=api.headers)
    assert response.status_code == 422  # the quantity is always explicit


def test_whole_numbers_only_for_indivisible_units(api, shop, draft):
    refused = api.add(draft["id"], shop["bolt"], "1.5")
    assert refused.status_code == 422 and "whole number" in refused.json()["detail"] and "'pcs'" in refused.json()["detail"]
    assert api.add(draft["id"], shop["bolt"], "2.0000").status_code == 201  # a whole number written with zeros is fine
    assert api.add(draft["id"], shop["flour"], "0.25").status_code == 201  # kilograms take decimals


def test_exact_decimals_are_kept(api, shop, draft):
    added = api.add(draft["id"], shop["flour"], "0.1").json()["item"]["id"]
    for _ in range(9):
        api.client.post(item_url(draft, added, "/increase"), json={"quantity": "0.1"}, headers=api.headers)
    assert api.detail(draft["id"])["items"][0]["quantity"] == "1.0000"  # not 0.9999999999999999


# --- duplicates are refused, never merged -----------------------------------------------------------------------------
def test_adding_the_same_product_again_does_not_create_a_second_line_or_change_the_quantity(api, shop, draft):
    first = api.add(draft["id"], shop["bolt"], 5).json()["item"]
    again = api.add(draft["id"], shop["bolt"], 3)
    assert again.status_code == 409
    detail = again.json()["detail"]
    assert detail["code"] == "duplicate_item" and "already on this list" in detail["message"] and "increase" in detail["message"]
    assert detail["item"]["id"] == first["id"] and detail["item"]["quantity"] == "5.0000"  # the caller learns which line to edit
    lines = api.detail(draft["id"])["items"]
    assert len(lines) == 1 and lines[0]["quantity"] == "5.0000"  # still 5, not 8


def test_repeated_scans_never_increment_anything(api, shop, draft):
    api.add(draft["id"], shop["bolt"], 5)
    for _ in range(5):
        api.add(draft["id"], shop["bolt"], 1)
    assert api.detail(draft["id"])["items"][0]["quantity"] == "5.0000"


def test_the_same_product_may_be_on_different_lists(api, shop):
    acme = api.new_client("Acme Ltd")
    one, two = api.new_list(acme["id"]), api.new_list(acme["id"])
    assert api.add(one["id"], shop["bolt"], 5).status_code == 201
    assert api.add(two["id"], shop["bolt"], 7).status_code == 201


def test_simultaneous_adds_of_the_same_product_make_one_line(api, shop, draft, client):
    import threading

    codes = []

    def add():
        codes.append(client.post(f"{LISTS}/{draft['id']}/items", json={"product_id": shop["bolt"], "quantity": "1"}, headers=api.headers).status_code)

    threads = [threading.Thread(target=add) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(codes) == [201] + [409] * 5
    assert api.detail(draft["id"])["item_count"] == 1


# --- editing ----------------------------------------------------------------------------------------------------------------
def test_setting_the_quantity_explicitly(api, shop, draft):
    item = api.add(draft["id"], shop["bolt"], 5).json()["item"]
    edited = api.client.patch(item_url(draft, item["id"]), json={"quantity": "8"}, headers=api.headers)
    assert edited.status_code == 200 and edited.json()["item"]["quantity"] == "8.0000"
    assert api.client.patch(item_url(draft, item["id"]), json={"quantity": "1"}, headers=api.headers).json()["item"]["quantity"] == "1.0000"  # lowering is fine too


def test_increasing_the_quantity_explicitly(api, shop, draft):
    item = api.add(draft["id"], shop["bolt"], 5).json()["item"]
    increased = api.client.post(item_url(draft, item["id"], "/increase"), json={"quantity": "3"}, headers=api.headers)
    assert increased.status_code == 200 and increased.json()["item"]["quantity"] == "8.0000"


@pytest.mark.parametrize("body", [{}, {"quantity": None}, {"quantity": "0"}, {"quantity": "-2"}, {"quantity": "1.5"}, {"quantity": "x"},
                                   {"product_id": str(uuid.uuid4())}, {"product_name": "x"}, {"unit": "kg"}, {"quantity": "2", "product_sku": "Z"}])
def test_invalid_edits_are_rejected_and_change_nothing(api, shop, draft, body):
    item = api.add(draft["id"], shop["bolt"], 5).json()["item"]
    assert api.client.patch(item_url(draft, item["id"]), json=body, headers=api.headers).status_code in (422,)
    assert api.detail(draft["id"])["items"][0]["quantity"] == "5.0000"


def test_fractions_are_refused_when_increasing_a_piece_count(api, shop, draft):
    item = api.add(draft["id"], shop["bolt"], 5).json()["item"]
    response = api.client.post(item_url(draft, item["id"], "/increase"), json={"quantity": "0.5"}, headers=api.headers)
    assert response.status_code == 422 and api.detail(draft["id"])["items"][0]["quantity"] == "5.0000"
    assert api.client.post(item_url(draft, item["id"], "/increase"), json={"quantity": "0"}, headers=api.headers).status_code == 422


def test_removing_a_line(api, shop, draft):
    first, second = api.add(draft["id"], shop["bolt"], 5).json()["item"], api.add(draft["id"], shop["flour"], 1).json()["item"]
    assert api.client.delete(item_url(draft, first["id"]), headers=api.headers).status_code == 204
    detail = api.detail(draft["id"])
    assert [i["id"] for i in detail["items"]] == [second["id"]] and detail["item_count"] == 1
    assert api.client.delete(item_url(draft, first["id"]), headers=api.headers).status_code == 404
    assert api.add(draft["id"], shop["bolt"], 2).status_code == 201  # the product can be added again afterwards


def test_an_item_of_another_list_is_not_reachable_through_this_one(api, shop):
    acme = api.new_client("Acme Ltd")
    one, two = api.new_list(acme["id"]), api.new_list(acme["id"])
    item = api.add(one["id"], shop["bolt"], 5).json()["item"]
    for method, tail, body in (("patch", "", {"quantity": "9"}), ("post", "/increase", {"quantity": "1"}), ("delete", "", None)):
        response = getattr(api.client, method)(f"{LISTS}/{two['id']}/items/{item['id']}{tail}", headers=api.headers, **({"json": body} if body else {}))
        assert response.status_code == 404
    assert api.detail(one["id"])["items"][0]["quantity"] == "5.0000"


# --- unknown, archived ---------------------------------------------------------------------------------------------
def test_an_unknown_product_is_404(api, shop, draft):
    response = api.add(draft["id"], str(uuid.uuid4()), 1)
    assert response.status_code == 404 and response.json()["detail"] == "Product not found."
    assert api.detail(draft["id"])["item_count"] == 0


def test_an_archived_product_cannot_be_added(api, shop, draft):
    response = api.add(draft["id"], shop["old"], 1)
    assert response.status_code == 409 and "archived" in response.json()["detail"] and "Old widget" in response.json()["detail"]
    assert api.detail(draft["id"])["item_count"] == 0


def test_a_product_archived_later_cannot_have_its_quantity_raised_but_can_be_removed(api, shop, draft, inventory):
    item = api.add(draft["id"], shop["bolt"], 5).json()["item"]
    inventory.products[shop["org"]][shop["bolt"]]["is_active"] = False
    assert api.client.patch(item_url(draft, item["id"]), json={"quantity": "6"}, headers=api.headers).status_code == 409
    assert api.client.post(item_url(draft, item["id"], "/increase"), json={"quantity": "1"}, headers=api.headers).status_code == 409
    shown = api.detail(draft["id"])["items"][0]
    assert shown["stock"]["product_active"] is False  # the page can warn about it
    assert api.client.delete(item_url(draft, item["id"]), headers=api.headers).status_code == 204


def test_an_inactive_client_blocks_adding_but_not_removing(api, shop, draft):
    item = api.add(draft["id"], shop["bolt"], 5).json()["item"]
    api.client.post(f"/api/v1/sales/clients/{draft['client']['id']}/deactivate", headers=api.headers)
    refused = api.add(draft["id"], shop["flour"], 1)
    assert refused.status_code == 409 and "inactive" in refused.json()["detail"]
    assert api.client.delete(item_url(draft, item["id"]), headers=api.headers).status_code == 204


def test_an_item_has_no_planned_warehouse(api, shop, draft):
    ok = api.add(draft["id"], shop["bolt"], 5).json()["item"]
    assert "planned_warehouse_id" not in ok and "planned_warehouse_code" not in ok
    assert api.add(draft["id"], shop["flour"], 1, planned_warehouse_id=str(uuid.uuid4())).status_code == 422
    assert api.client.patch(item_url(draft, ok["id"]), json={"planned_warehouse_id": None}, headers=api.headers).status_code == 422


# --- stock is information, never a limit -------------------------------------------------------------------------------------------
def test_more_than_available_is_allowed_but_flagged(api, shop, draft):
    response = api.add(draft["id"], shop["bolt"], 100)  # only 50 are in stock
    assert response.status_code == 201
    stock = response.json()["item"]["stock"]
    assert (stock["exceeds_available"], stock["shortfall"], stock["total_quantity"]) == (True, "50.0000", "50")
    detail = api.detail(draft["id"])
    assert detail["items_exceeding_stock"] == 1 and "not reserved" in detail["stock_notice"] and "may change before dispatch" in detail["stock_notice"]
    assert api.status(draft["id"], "ready").status_code == 200  # a shortage warns, it does not block


def test_a_product_with_no_stock_can_still_be_listed(api, inventory, shop, draft):
    empty = inventory.add_product(shop["org"], "EMPTY", "Out of stock", "pcs")
    response = api.add(draft["id"], empty, 3)
    assert response.status_code == 201 and response.json()["item"]["stock"]["total_quantity"] == "0"
    assert response.json()["item"]["stock"]["exceeds_available"] is True


def test_the_stock_shown_is_live_not_remembered(api, shop, draft, inventory):
    api.add(draft["id"], shop["bolt"], 30)
    assert api.detail(draft["id"])["items"][0]["stock"]["exceeds_available"] is False
    inventory.set_stock(shop["bolt"], 10)  # someone shipped goods meanwhile
    shown = api.detail(draft["id"])["items"][0]["stock"]
    assert (shown["total_quantity"], shown["exceeds_available"], shown["shortfall"]) == ("10", True, "20.0000")


def test_the_list_still_opens_when_the_inventory_service_is_down(api, shop, draft, inventory):
    api.add(draft["id"], shop["bolt"], 5)
    inventory.mode = "down"
    detail = api.detail(draft["id"])
    assert detail["stock_status"] == "unavailable" and detail["items"][0]["stock"] is None and detail["items"][0]["product_name"] == "Steel bolt"
    inventory.mode = "500"
    assert api.detail(draft["id"])["stock_status"] == "unavailable"


@pytest.mark.parametrize("mode", ["down", "500"])
def test_adding_needs_the_inventory_service(api, shop, draft, inventory, mode):
    inventory.mode = mode
    response = api.add(draft["id"], shop["bolt"], 1)
    assert response.status_code == 503 and "inventory service" in response.json()["detail"].lower()
    inventory.mode = None
    assert api.detail(draft["id"])["item_count"] == 0


def test_a_rejected_token_at_the_inventory_service_is_reported_not_swallowed(api, shop, draft, inventory):
    inventory.mode = "401"
    assert api.add(draft["id"], shop["bolt"], 1).status_code == 401
    inventory.mode = "403"
    assert api.add(draft["id"], shop["bolt"], 1).status_code == 403
