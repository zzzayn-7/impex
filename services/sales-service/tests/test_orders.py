"""Sales orders: Create Order -> reserve stock -> automatic delivery list -> edit / cancel -> dispatch -> deliver -> 24-hour history.

The Inventory Service is the in-process fake from conftest.py (it books, releases and consumes reservations like the real one: totals,
all-or-nothing, idempotent by key). The Sales database is the real PostgreSQL schema from the migrations.
"""
import threading
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from conftest import DISPATCHES, LISTS, bearer, item_of, sent

ORDERS = "/api/v1/sales/orders"


def d(value) -> Decimal:
    return Decimal(str(value))


@pytest.fixture
def water(inventory, two_orgs):
    """Alpha's inventory: water bottles (pieces, 500 on hand), flour (kg, 20 on hand) and an archived product."""
    org = two_orgs["alpha_id"]
    bottle, flour = inventory.add_product(org, "WATER", "Water bottle", "pcs"), inventory.add_product(org, "FLOUR", "Flour", "kg")
    old = inventory.add_product(org, "OLD-1", "Old widget", "pcs", active=False)
    inventory.set_stock(bottle, 500)
    inventory.set_stock(flour, 20)
    return {"bottle": bottle, "flour": flour, "old": old, "org": org}


@pytest.fixture
def acme(api):
    return api.new_client("Acme Ltd")


PRICE = "1.00"  # the unit price most tests do not care about (a price is required on every new order line)


def price_line(entry):
    """(product, quantity) or (product, quantity, price): the price defaults to PRICE."""
    product, quantity, *price = entry
    return {"product_id": product, "quantity": str(quantity), "unit_price": str(price[0] if price else PRICE)}


def body(client, *lines, currency="USD", **extra):
    return {"client_id": client["id"], "currency_code": currency, "lines": [price_line(l) for l in lines], **extra}


def create(api, client, *lines, key=None, **extra):
    headers = {**api.headers, "Idempotency-Key": key or f"order-{uuid.uuid4()}"}
    return api.client.post(ORDERS, json=body(client, *lines, **extra), headers=headers)


def new_order(api, client, *lines, **extra) -> dict:
    response = create(api, client, *lines, **extra)
    assert response.status_code == 201, response.text
    return response.json()


def get(api, order_id):
    response = api.client.get(f"{ORDERS}/{order_id}", headers=api.headers)
    assert response.status_code == 200, response.text
    return response.json()


def edit(api, order, *lines, version=None, **extra):
    """Change the order to these lines. A line of a product already on the order keeps its saved price unless a price is given; a NEW product gets PRICE."""
    on_order = {l["product_id"] for l in order.get("lines", [])}
    entries = []
    for entry in lines:
        product, quantity, *price = entry
        item = {"product_id": product, "quantity": str(quantity)}
        if price:
            item["unit_price"] = str(price[0])
        elif product not in on_order:
            item["unit_price"] = PRICE
        entries.append(item)
    return api.client.patch(f"{ORDERS}/{order['id']}", json={"version": version or order["version"], "lines": entries, **extra}, headers=api.headers)


def cancel(api, order, path="cancel"):
    return api.client.post(f"{ORDERS}/{order['id']}/{path}", headers=api.headers)


def orders_view(api, view="active", **params):
    response = api.client.get(ORDERS, params={"view": view, **params}, headers=api.headers)
    assert response.status_code == 200, response.text
    return response.json()


def line_of(order, product):
    return next(l for l in order["lines"] if l["product_id"] == product)


def dispatch(api, order, product, quantity, confirm=True):
    delivery_list = api.detail(order["delivery_list"]["id"])
    draft = api.draft(delivery_list["id"], [sent(delivery_list, product, quantity)])
    return api.confirm(draft["id"]) if confirm else draft


# =====================================================================================================
# Saving an order
# =====================================================================================================
def test_an_order_for_an_existing_client_books_its_stock_and_generates_a_ready_delivery_list(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 400), notes="Pallet 3")
    assert order["number"] == "SO-000001" and order["status"] == "active" and order["reservation_status"] == "reserved"
    assert order["client"]["name"] == "Acme Ltd" and order["delivery_list"]["number"] == "DL-000001" and order["delivery_list"]["status"] == "ready"
    assert order["product_count"] == 1 and order["created_by_email"] == "admin-alpha@example.org" and order["notes"] == "Pallet 3" and order["version"] == 1
    (line,) = order["lines"]
    assert (line["product_sku"], line["product_name"], line["unit"], line["ordered_quantity"], line["dispatched_quantity"], line["remaining_quantity"]) == ("WATER", "Water bottle", "pcs", "400.0000", "0.0000", "400.0000")
    assert tuple(d(line["stock"][k]) for k in ("total_quantity", "reserved_quantity", "available_quantity", "reserved_for_order")) == (500, 400, 100, 400)
    # the linked list is Ready at once - no manual step - and shows the same line
    delivery_list = api.detail(order["delivery_list"]["id"])
    assert delivery_list["status"] == "ready" and delivery_list["booking_state"] == "booked" and delivery_list["order_number"] == "SO-000001"
    assert [(i["product_sku"], i["quantity"]) for i in delivery_list["items"]] == [("WATER", "400.0000")]
    linked = api.client.get(f"{ORDERS}/{order['id']}/delivery-list", headers=api.headers).json()
    assert linked["id"] == delivery_list["id"] and linked["number"] == "DL-000001"
    # physical stock is untouched; the Inventory Service holds the reservation
    assert inventory.quantity(water["bottle"]) == 500 and inventory.reserved(water["bottle"]) == 400 and inventory.ledger == []
    assert inventory.deduction_writes() == []


def test_an_order_for_a_newly_registered_client(api, water):
    registered = api.new_client("Fresh Customer GmbH", email="buyer@fresh.example")
    order = new_order(api, registered, (water["bottle"], 10))
    assert order["client"]["id"] == registered["id"] and order["client"]["name"] == "Fresh Customer GmbH"
    # the same customer cannot be registered twice, so a second record never appears
    again = api.client.post("/api/v1/sales/clients", json={"name": "fresh  customer gmbh"}, headers=api.headers)
    assert again.status_code == 409


def test_several_products_and_quantities_are_booked_together(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 100), (water["flour"], "2.5"))
    assert order["product_count"] == 2
    assert inventory.reserved(water["bottle"]) == 100 and inventory.reserved(water["flour"]) == d("2.5")
    assert [(l["product_name"], l["ordered_quantity"]) for l in sorted(order["lines"], key=lambda l: l["product_name"])] == [("Flour", "2.5000"), ("Water bottle", "100.0000")]


def test_a_product_can_appear_only_once_in_an_order(api, water, acme, inventory):
    response = create(api, acme, (water["bottle"], 5), (water["bottle"], 6))
    assert response.status_code == 422 and "only once" in response.text
    assert inventory.reservation_posts() == [] and orders_view(api)["total"] == 0


def test_numbers_run_per_organization(two_orgs, water, acme, inventory):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    first, second = new_order(alpha, acme, (water["bottle"], 1)), new_order(alpha, acme, (water["bottle"], 1))
    assert (first["number"], second["number"], second["delivery_list"]["number"]) == ("SO-000001", "SO-000002", "DL-000002")
    org_b = two_orgs["beta_id"]
    beta_bolt = inventory.add_product(org_b, "BOLT", "Bolt", "pcs")
    inventory.set_stock(beta_bolt, 5)
    assert new_order(beta, beta.new_client("Beta Buyer"), (beta_bolt, 1))["number"] == "SO-000001"


def test_orders_need_an_active_client_and_valid_products(api, water, acme):
    gone = api.new_client("Gone Ltd")
    assert api.client.post(f"/api/v1/sales/clients/{gone['id']}/deactivate", headers=api.headers).status_code == 200
    refused = create(api, gone, (water["bottle"], 1))
    assert refused.status_code == 409 and "inactive" in refused.json()["detail"]
    assert create(api, {"id": str(uuid.uuid4())}, (water["bottle"], 1)).status_code == 404  # no such client
    assert create(api, acme, (str(uuid.uuid4()), 1)).status_code == 404  # no such product
    assert create(api, acme, (water["old"], 1)).status_code == 409  # archived
    assert create(api, acme, (water["bottle"], "2.5")).status_code == 422  # pieces are whole numbers
    assert create(api, acme, (water["flour"], "2.5")).status_code == 201  # kilograms are not
    for bad in ("0", "-1", "abc", "1.00001"):
        assert create(api, acme, (water["bottle"], bad)).status_code == 422, bad
    assert api.client.post(ORDERS, json={"client_id": acme["id"], "lines": []}, headers={**api.headers, "Idempotency-Key": "order-empty-key"}).status_code == 422


def test_the_caller_cannot_decide_what_only_the_service_decides(api, water, acme):
    for extra in ({"organization_id": str(uuid.uuid4())}, {"status": "delivered"}, {"reservation_status": "reserved"}, {"number": "SO-999999"}, {"delivery_list_id": str(uuid.uuid4())}):
        assert create(api, acme, (water["bottle"], 1), **extra).status_code == 422, extra
    line = {"product_id": water["bottle"], "quantity": "1", "unit": "box", "product_name": "Hacked", "reserved": "9"}
    assert api.client.post(ORDERS, json={"client_id": acme["id"], "lines": [line]}, headers={**api.headers, "Idempotency-Key": "order-extra-key"}).status_code == 422
    assert api.client.post(ORDERS, json=body(acme, (water["bottle"], 1)), headers=api.headers).status_code == 400  # a key is required


# =====================================================================================================
# The reservation arithmetic: 500 on hand, 400 reserved, 100 available
# =====================================================================================================
def test_five_hundred_four_hundred_one_hundred(api, water, acme, inventory):
    first = new_order(api, acme, (water["bottle"], 400))
    assert (inventory.quantity(water["bottle"]), inventory.reserved(water["bottle"]), inventory.available(water["bottle"])) == (500, 400, 100)
    other = api.new_client("Beta Buyer")
    refused = create(api, other, (water["bottle"], 150))
    assert refused.status_code == 409
    detail = refused.json()["detail"]
    assert detail["code"] == "insufficient_available" and "Only 100 pcs of Water bottle are available" in detail["message"] and "400 pcs are already reserved for other orders" in detail["message"]
    assert (inventory.reserved(water["bottle"]), orders_view(api)["total"]) == (400, 1)  # the refusal created nothing
    second = new_order(api, other, (water["bottle"], 100))
    assert (inventory.quantity(water["bottle"]), inventory.reserved(water["bottle"]), inventory.available(water["bottle"])) == (500, 500, 0)
    assert d(line_of(get(api, first["id"]), water["bottle"])["stock"]["available_quantity"]) == 0 and second["number"] == "SO-000002"
    assert create(api, other, (water["bottle"], 1)).status_code == 409  # nothing left until stock arrives or a reservation is released


def test_released_and_new_stock_becomes_available_again(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 500))
    assert create(api, acme, (water["bottle"], 1)).status_code == 409
    inventory.set_stock(water["bottle"], 600)  # goods received
    assert create(api, acme, (water["bottle"], 100)).status_code == 201
    assert cancel(api, order).status_code == 200  # the cancelled order frees its 500
    assert inventory.reserved(water["bottle"]) == 100 and create(api, acme, (water["bottle"], 500)).status_code == 201


def test_a_multi_product_order_is_all_or_nothing(api, water, acme, inventory):
    refused = create(api, acme, (water["bottle"], 10), (water["flour"], 25))  # only 20 kg of flour
    assert refused.status_code == 409 and "Flour" in refused.json()["detail"]["message"]
    assert (inventory.reserved(water["bottle"]), inventory.reserved(water["flour"]), orders_view(api)["total"]) == (0, 0, 0)


def test_when_the_inventory_service_refuses_after_the_first_look_nothing_is_active(api, water, acme, inventory, monkeypatch):
    """Another order took the last units between our look and the booking: the order FAILS and is never active."""
    from app import orders

    first_look = orders.validate_new_lines
    monkeypatch.setattr(orders, "validate_new_lines", lambda gateway, lines: first_look(gateway, lines))
    other = api.new_client("Beta Buyer")
    new_order(api, other, (water["bottle"], 450))
    monkeypatch.setattr(orders, "validate_new_lines", lambda gateway, lines: {l.product_id: gateway.products([l.product_id])[l.product_id] for l in lines})  # skips the shortage check
    refused = create(api, acme, (water["bottle"], 100))
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "insufficient_available"
    assert orders_view(api)["total"] == 1 and inventory.reserved(water["bottle"]) == 450
    with_failed = api.client.get(LISTS, params={"status": "cancelled"}, headers=api.headers).json()
    assert [l["order_status"] for l in with_failed["items"]] == ["failed"]  # kept for audit, cancelled, never ready


def test_simultaneous_orders_cannot_double_book(api, water, acme, inventory):
    inventory.set_stock(water["bottle"], 100)
    results = []
    clients = [api.new_client(f"Buyer {i}") for i in range(6)]

    def work(client):
        results.append(create(api, client, (water["bottle"], 40)).status_code)

    threads = [threading.Thread(target=work, args=(c,)) for c in clients]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(results) == [201, 201, 409, 409, 409, 409]  # 100 / 40 = two orders
    assert inventory.reserved(water["bottle"]) == 80


# =====================================================================================================
# Saving twice, outages and crashes
# =====================================================================================================
def test_saving_the_same_request_twice_makes_one_order_and_one_booking(api, water, acme, inventory):
    first = create(api, acme, (water["bottle"], 50), key="order-same-key-0001")
    again = create(api, acme, (water["bottle"], 50), key="order-same-key-0001")
    assert first.status_code == 201 and again.status_code == 200 and again.json()["id"] == first.json()["id"]
    assert inventory.reserved(water["bottle"]) == 50 and len(inventory.reservation_posts()) == 1
    assert orders_view(api)["total"] == 1
    different = create(api, acme, (water["bottle"], 60), key="order-same-key-0001")
    assert different.status_code == 409 and "different request" in different.json()["detail"]


def test_an_unavailable_inventory_service_never_creates_an_active_order(api, water, acme, inventory):
    inventory.mode = "down"
    refused = create(api, acme, (water["bottle"], 5))
    assert refused.status_code == 503
    inventory.mode = None
    assert orders_view(api)["total"] == 0 and inventory.reservation_posts() == []
    assert api.client.get(LISTS, headers=api.headers).json()["total"] == 0  # not even a draft list was left behind


@pytest.mark.parametrize("mode", ["timeout_after", "500_after"])
def test_a_lost_answer_is_recovered_at_once_by_asking_what_happened(api, water, acme, inventory, mode):
    """The booking WAS made but the answer was lost: Sales asks by the same key, verifies, and activates - without booking twice."""
    inventory.res_modes = [mode]
    response = create(api, acme, (water["bottle"], 70), key="order-lostanswer-1")
    assert response.status_code == 201 and response.json()["status"] == "active"
    assert inventory.reserved(water["bottle"]) == 70 and len(inventory.reservations) == 1 and len(inventory.res_ops) == 1


@pytest.mark.parametrize("mode", ["timeout_before", "500_before"])
def test_a_request_that_never_arrived_leaves_a_pending_order_that_recovers_without_double_booking(api, water, acme, inventory, mode):
    inventory.res_modes = [mode]
    response = create(api, acme, (water["bottle"], 70), key="order-timeout-0001")
    assert response.status_code == 202, response.text
    pending = response.json()
    assert pending["status"] == "pending_reservation" and pending["reservation_status"] == "pending" and pending["delivery_list"]["status"] == "draft"
    assert pending["can_dispatch"] is False and "not confirmed" in pending["message"]
    # an order that is not verified is NOT active: it cannot be dispatched, edited or cancelled
    assert api.dispatch_request(pending["delivery_list"]["id"], []).status_code == 409
    assert edit(api, pending, (water["bottle"], 10)).status_code == 409
    # a retry of the very same save finishes it, and the stock is booked exactly once
    finished = create(api, acme, (water["bottle"], 70), key="order-timeout-0001")
    assert finished.status_code == 200 and finished.json()["status"] == "active" and finished.json()["id"] == pending["id"]
    assert inventory.reserved(water["bottle"]) == 70 and len(inventory.reservations) == 1


def test_reading_or_listing_a_stuck_order_finishes_it(api, water, acme, inventory):
    inventory.res_modes = ["timeout_before"]
    stuck = create(api, acme, (water["bottle"], 30)).json()
    assert stuck["status"] == "pending_reservation"
    listing = orders_view(api)  # the list asks the Inventory Service again, with the same key
    assert [o["status"] for o in listing["items"]] == ["active"] and inventory.reserved(water["bottle"]) == 30

    inventory.res_modes = ["timeout_before"]
    other = create(api, acme, (water["bottle"], 20)).json()
    assert get(api, other["id"])["status"] == "active" and inventory.reserved(water["bottle"]) == 50


def test_the_reconcile_route_retries_and_a_refusal_discovered_later_fails_the_order(api, water, acme, inventory):
    inventory.res_modes = ["timeout_before"]
    stuck = create(api, acme, (water["bottle"], 30)).json()
    inventory.mode = "down"
    still = api.client.post(f"{ORDERS}/{stuck['id']}/reconcile", headers=api.headers)
    assert still.status_code == 503 or still.json()["status"] == "pending_reservation"
    inventory.mode = None
    other = api.new_client("Other")
    new_order(api, other, (water["bottle"], 480))  # takes the stock before the stuck booking is retried
    refused = api.client.post(f"{ORDERS}/{stuck['id']}/reconcile", headers=api.headers)
    assert refused.status_code == 409
    assert get(api, stuck["id"])["status"] == "failed" and inventory.reserved(water["bottle"]) == 480


def test_a_crash_after_the_intent_was_saved_is_recoverable(api, water, acme, inventory, monkeypatch):
    from app import orders

    real = orders.drive
    monkeypatch.setattr(orders, "drive", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("process died")))
    with pytest.raises(RuntimeError):
        create(api, acme, (water["bottle"], 25), key="order-crash-key-01")
    monkeypatch.setattr(orders, "drive", real)
    assert inventory.reservation_posts() == []  # nothing had reached the Inventory Service
    listing = orders_view(api)  # the saved intent is picked up
    assert [o["status"] for o in listing["items"]] == ["active"] and inventory.reserved(water["bottle"]) == 25


def test_an_answer_that_does_not_match_is_not_trusted(api, water, acme, inventory, monkeypatch):
    original = inventory._apply_reservation

    def wrong(org, payload, release):
        lines = original(org, payload, release)
        return [{**l, "remaining_quantity": "1.0000"} for l in lines] if isinstance(lines, list) else lines

    monkeypatch.setattr(inventory, "_apply_reservation", wrong)
    response = create(api, acme, (water["bottle"], 10))
    assert response.status_code == 202 and response.json()["status"] == "pending_reservation"  # kept pending, never activated on a wrong answer


# =====================================================================================================
# Delivery Lists overview: active orders, the three actions' backends
# =====================================================================================================
def test_active_orders_are_listed_newest_first_with_what_the_page_shows(api, water, acme):
    first = new_order(api, acme, (water["bottle"], 10))
    second = new_order(api, api.new_client("Beta Buyer"), (water["bottle"], 20), (water["flour"], 1))
    listing = orders_view(api)
    assert [o["number"] for o in listing["items"]] == [second["number"], first["number"]] and listing["total"] == 2
    entry = listing["items"][0]
    assert (entry["client"]["name"], entry["product_count"], entry["status"], entry["reservation_status"], entry["delivery_list"]["number"]) == ("Beta Buyer", 2, "active", "reserved", "DL-000002")
    assert entry["created_at"] and entry["version"] == 1
    assert [o["number"] for o in orders_view(api, q="acme")["items"]] == [first["number"]]
    assert [o["number"] for o in orders_view(api, q="DL-000002")["items"]] == [second["number"]]
    assert orders_view(api, view="delivered")["total"] == 0


def test_an_order_survives_reloads_and_new_sessions(api, water, acme, directory):
    order = new_order(api, acme, (water["bottle"], 10))
    directory.add_user("second-session", "organization-admin", water["org"])
    second = type(api)(api.client, "second-session", water["org"])
    assert orders_view(second)["items"][0]["id"] == order["id"] and get(second, order["id"])["status"] == "active"


# =====================================================================================================
# Editing
# =====================================================================================================
def test_reducing_releases_and_increasing_books_only_the_difference(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 400))
    reduced = edit(api, order, (water["bottle"], 250))
    assert reduced.status_code == 200, reduced.text
    assert inventory.reserved(water["bottle"]) == 250 and reduced.json()["version"] == 2
    assert api.detail(order["delivery_list"]["id"])["items"][0]["quantity"] == "250.0000"  # the list follows
    increased = edit(api, reduced.json(), (water["bottle"], 450))
    assert increased.status_code == 200 and inventory.reserved(water["bottle"]) == 450 and increased.json()["version"] == 3
    assert increased.json()["lines"][0]["ordered_quantity"] == "450.0000" and increased.json()["delivery_list"]["status"] == "ready"


def test_an_increase_that_cannot_be_booked_is_refused_as_a_whole(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 400))
    refused = edit(api, order, (water["bottle"], 600))
    assert refused.status_code == 409
    assert refused.json()["detail"]["message"] == "Cannot increase Water bottle to 600. Only 100 additional pcs are currently available."
    assert inventory.reserved(water["bottle"]) == 400
    unchanged = get(api, order["id"])
    assert unchanged["lines"][0]["ordered_quantity"] == "400.0000" and unchanged["version"] == 1 and unchanged["reservation_status"] == "reserved"
    assert api.detail(order["delivery_list"]["id"])["items"][0]["quantity"] == "400.0000"


def test_products_can_be_added_and_removed(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 10), (water["flour"], 2))
    changed = edit(api, order, (water["bottle"], 10), (water["flour"], 2))  # same lines: nothing to do
    assert changed.status_code == 200 and changed.json()["version"] == 1
    removed = edit(api, order, (water["bottle"], 12))
    assert removed.status_code == 200 and [l["product_name"] for l in removed.json()["lines"]] == ["Water bottle"]
    assert inventory.reserved(water["flour"]) == 0 and inventory.reserved(water["bottle"]) == 12
    added = edit(api, removed.json(), (water["bottle"], 12), (water["flour"], 5))
    assert added.status_code == 200 and {l["product_name"]: l["ordered_quantity"] for l in added.json()["lines"]} == {"Water bottle": "12.0000", "Flour": "5.0000"}
    assert inventory.reserved(water["flour"]) == 5
    assert edit(api, added.json(), (water["bottle"], 12), (water["bottle"], 3)).status_code == 422  # duplicates
    assert edit(api, added.json(), (water["bottle"], "1.5")).status_code == 422 or edit(api, added.json(), (water["bottle"], "1.5")).status_code == 409
    assert api.client.patch(f"{ORDERS}/{order['id']}", json={"version": 3, "lines": []}, headers=api.headers).status_code == 422  # an order keeps at least one line


def test_an_edit_made_on_an_out_of_date_copy_is_refused(api, water, acme):
    order = new_order(api, acme, (water["bottle"], 10))
    assert edit(api, order, (water["bottle"], 20)).status_code == 200
    stale = edit(api, order, (water["bottle"], 30))  # still holds version 1
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "stale_order"
    assert get(api, order["id"])["lines"][0]["ordered_quantity"] == "20.0000"


def test_editing_a_partly_dispatched_order_never_touches_what_was_dispatched(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 400), (water["flour"], 5))
    assert dispatch(api, order, water["bottle"], 250).status_code == 200
    current = get(api, order["id"])
    assert current["delivery_list"]["status"] == "partially_dispatched" and current["can_edit"] is True
    below = edit(api, current, (water["bottle"], 200), (water["flour"], 5))
    assert below.status_code == 409 and below.json()["detail"]["code"] == "below_dispatched"
    ok = edit(api, current, (water["bottle"], 300), (water["flour"], 8))  # the undelivered part can change
    assert ok.status_code == 200, ok.text
    assert inventory.reserved(water["bottle"]) == 50 and inventory.reserved(water["flour"]) == 8 and inventory.quantity(water["bottle"]) == 250
    assert line_of(ok.json(), water["bottle"])["dispatched_quantity"] == "250.0000"
    # a line that was dispatched cannot be removed; one nothing was dispatched from can
    kept = edit(api, ok.json(), (water["flour"], 8))
    assert kept.status_code == 409 and kept.json()["detail"]["code"] == "has_dispatch_history"
    dropped = edit(api, ok.json(), (water["bottle"], 300))
    assert dropped.status_code == 200 and [l["product_name"] for l in dropped.json()["lines"]] == ["Water bottle"] and inventory.reserved(water["flour"]) == 0


def test_an_edit_is_refused_while_a_dispatch_is_being_posted(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 100))
    delivery_list = api.detail(order["delivery_list"]["id"])
    draft = api.draft(delivery_list["id"], [sent(delivery_list, water["bottle"], 40)])
    inventory.post_modes = ["timeout_before"]
    assert api.confirm(draft["id"]).status_code == 202  # stuck in posting
    refused = edit(api, order, (water["bottle"], 90))
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "dispatch_posting"
    assert cancel(api, order).status_code == 409
    assert api.confirm(draft["id"]).status_code == 200  # finish it
    assert edit(api, get(api, order["id"]), (water["bottle"], 90)).status_code == 200


def test_an_edit_that_leaves_nothing_undelivered_delivers_the_order(api, water, acme):
    order = new_order(api, acme, (water["bottle"], 100))
    dispatch(api, order, water["bottle"], 60)
    done = edit(api, get(api, order["id"]), (water["bottle"], 60))
    assert done.status_code == 200 and done.json()["status"] == "delivered" and done.json()["delivery_list"]["status"] == "dispatched"


# =====================================================================================================
# Cancelling
# =====================================================================================================
def test_cancelling_an_order_releases_everything_and_keeps_a_record(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 400), (water["flour"], 3))
    cancelled = cancel(api, order)
    assert cancelled.status_code == 200, cancelled.text
    body_ = cancelled.json()
    assert body_["status"] == "cancelled" and body_["reservation_status"] == "released" and body_["cancelled_at"] and body_["delivery_list"]["status"] == "cancelled"
    assert (inventory.reserved(water["bottle"]), inventory.reserved(water["flour"])) == (0, 0) and inventory.quantity(water["bottle"]) == 500
    assert orders_view(api)["total"] == 0 and orders_view(api, view="delivered")["total"] == 0  # off the operational lists...
    assert get(api, order["id"])["status"] == "cancelled" and api.detail(order["delivery_list"]["id"])["items"]  # ...but never deleted
    assert api.dispatch_request(order["delivery_list"]["id"], []).status_code == 409  # a cancelled order cannot be dispatched


def test_cancelling_twice_releases_once(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 400))
    assert cancel(api, order).status_code == 200
    other = new_order(api, acme, (water["bottle"], 300))  # takes some of the freed stock
    again = cancel(api, order)
    assert again.status_code == 200 and again.json()["status"] == "cancelled"
    assert inventory.reserved(water["bottle"]) == 300 and len(inventory.reservation_posts()) == 3  # create, create, release: no second release


def test_cancelling_discards_unfinished_dispatch_drafts(api, water, acme):
    order = new_order(api, acme, (water["bottle"], 100))
    delivery_list = api.detail(order["delivery_list"]["id"])
    draft = api.draft(delivery_list["id"], [sent(delivery_list, water["bottle"], 10)])
    assert cancel(api, order).status_code == 200
    assert api.get_dispatch(draft["id"])["status"] == "cancelled"


def test_an_order_with_goods_dispatched_cannot_be_cancelled_but_its_remainder_can(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 400), (water["flour"], 5))
    dispatch(api, order, water["bottle"], 150)
    refused = cancel(api, get(api, order["id"]))
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "has_dispatches"
    detail = get(api, order["id"])
    assert detail["can_cancel"] is False and detail["can_cancel_remaining"] is True and "remaining quantity" in detail["cancel_blocked_reason"]
    closed = cancel(api, order, "cancel-remaining")
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "closed" and closed.json()["delivery_list"]["status"] == "dispatched" and closed.json()["completed_at"]
    assert inventory.reserved(water["bottle"]) == 0 and inventory.reserved(water["flour"]) == 0 and inventory.quantity(water["bottle"]) == 350
    assert [(l["product_name"], l["ordered_quantity"], l["dispatched_quantity"]) for l in closed.json()["lines"]] == [("Water bottle", "150.0000", "150.0000")]
    assert orders_view(api)["total"] == 0 and [o["number"] for o in orders_view(api, view="delivered")["items"]] == [order["number"]]
    assert cancel(api, order, "cancel-remaining").status_code == 200  # repeating is harmless
    assert cancel(api, new_order(api, acme, (water["bottle"], 5)), "cancel-remaining").status_code == 409  # nothing was dispatched there


# =====================================================================================================
# Dispatching reserved products
# =====================================================================================================
def test_dispatching_consumes_the_reservation_and_deducts_physical_stock(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 400))
    state = lambda: (inventory.quantity(water["bottle"]), inventory.reserved(water["bottle"]), inventory.available(water["bottle"]))
    assert state() == (500, 400, 100)
    delivery_list = api.detail(order["delivery_list"]["id"])
    draft = api.draft(delivery_list["id"], [sent(delivery_list, water["bottle"], 250)])
    assert state() == (500, 400, 100)  # a prepared dispatch changes nothing and books nothing a second time
    assert api.confirm(draft["id"]).status_code == 200
    assert state() == (250, 150, 100)  # physical 250, reserved 150, available 100
    mid = get(api, order["id"])
    assert mid["status"] == "active" and mid["delivery_list"]["status"] == "partially_dispatched" and mid["completed_at"] is None
    assert line_of(mid, water["bottle"])["dispatched_quantity"] == "250.0000" and line_of(mid, water["bottle"])["remaining_quantity"] == "150.0000"
    assert [o["number"] for o in orders_view(api)["items"]] == [order["number"]] and orders_view(api, view="delivered")["total"] == 0  # partly delivered stays active
    assert dispatch(api, mid, water["bottle"], 150).status_code == 200
    assert state() == (100, 0, 100)
    done = get(api, order["id"])
    assert done["status"] == "delivered" and done["reservation_status"] == "consumed" and done["completed_at"] and done["delivery_list"]["status"] == "dispatched"


def test_retrying_a_confirmation_never_deducts_or_consumes_twice(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 100))
    delivery_list = api.detail(order["delivery_list"]["id"])
    draft = api.draft(delivery_list["id"], [sent(delivery_list, water["bottle"], 40)])
    inventory.post_modes = ["timeout_after"]
    assert api.confirm(draft["id"]).status_code in (200, 202)  # applied, answer lost: recovered by asking what happened
    assert api.confirm(draft["id"]).status_code == 200 and api.confirm(draft["id"]).status_code == 200
    assert (inventory.quantity(water["bottle"]), inventory.reserved(water["bottle"]), len(inventory.ledger)) == (460, 60, 1)


def test_dispatches_cannot_exceed_the_order(api, water, acme):
    order = new_order(api, acme, (water["bottle"], 100))
    delivery_list = api.detail(order["delivery_list"]["id"])
    assert api.dispatch_request(delivery_list["id"], [sent(delivery_list, water["bottle"], 101)]).status_code == 409
    dispatch(api, order, water["bottle"], 60)
    after = api.detail(delivery_list["id"])
    assert api.dispatch_request(after["id"], [sent(after, water["bottle"], 41)]).status_code == 409  # 40 remain
    assert dispatch(api, get(api, order["id"]), water["bottle"], 40).status_code == 200


def test_two_dispatches_of_the_same_order_at_once_cannot_take_more_than_is_reserved(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 100))
    delivery_list = api.detail(order["delivery_list"]["id"])
    drafts = [api.draft(delivery_list["id"], [sent(delivery_list, water["bottle"], 60)]) for _ in range(2)]
    results = []
    threads = [threading.Thread(target=lambda dr=dr: results.append(api.confirm(dr["id"]).status_code)) for dr in drafts]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(results) == [200, 409]
    assert (inventory.quantity(water["bottle"]), inventory.reserved(water["bottle"])) == (440, 40)


def test_an_unconfirmed_booking_cannot_be_dispatched_and_a_change_in_flight_blocks_it(api, water, acme, inventory):
    inventory.res_modes = ["timeout_before"]
    pending = create(api, acme, (water["bottle"], 10)).json()
    assert api.dispatch_request(pending["delivery_list"]["id"], []).status_code == 409
    order = new_order(api, acme, (water["bottle"], 100))
    inventory.res_modes = ["timeout_before"]
    stuck = edit(api, order, (water["bottle"], 90))
    assert stuck.status_code == 202 and stuck.json()["reservation_status"] == "updating"
    assert api.dispatch_request(order["delivery_list"]["id"], []).status_code == 409  # "a change is being applied"
    assert api.client.post(f"{ORDERS}/{order['id']}/reconcile", headers=api.headers).json()["lines"][0]["ordered_quantity"] == "90.0000"
    assert api.dispatch_request(order["delivery_list"]["id"], []).status_code == 201


def test_invoices_are_untouched_by_orders(api, water, acme, inventory):
    order = new_order(api, acme, (water["bottle"], 10))
    assert api.client.get("/api/v1/sales/invoices", headers=api.headers).json()["total"] == 0  # a booking is a commitment, not a sale
    confirmed = dispatch(api, order, water["bottle"], 10).json()
    invoice = api.client.post("/api/v1/sales/invoices", json={"client_id": acme["id"], "currency_code": "USD", "lines": [{"dispatch_line_id": confirmed["lines"][0]["id"], "quantity": "10", "unit_price": "2"}]}, headers={**api.headers, "Idempotency-Key": "invoice-key-0001"})
    assert invoice.status_code in (200, 201), invoice.text


# =====================================================================================================
# Delivered History: 24 hours, server clock, nothing deleted
# =====================================================================================================
def test_delivered_orders_stay_in_history_for_exactly_24_hours(api, water, acme, inventory, monkeypatch):
    from app import clock

    start = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)
    now = {"t": start}
    monkeypatch.setattr(clock, "now", lambda: now["t"])
    order = new_order(api, acme, (water["bottle"], 100))
    dispatch(api, order, water["bottle"], 100)
    done = get(api, order["id"])
    assert done["status"] == "delivered" and done["completed_at"].startswith("2026-11-09T12:00:00")
    assert done["history_expires_at"].startswith("2026-11-10T12:00:00")
    assert orders_view(api)["total"] == 0  # off the active list at once
    for moment in (start + timedelta(minutes=1), start + timedelta(hours=23, minutes=59, seconds=59)):
        now["t"] = moment
        history = orders_view(api, view="delivered")
        assert [o["number"] for o in history["items"]] == [order["number"]], moment
    now["t"] = start + timedelta(hours=24, seconds=1)  # the same query, every administrator, every reload
    assert orders_view(api, view="delivered")["total"] == 0 and orders_view(api)["total"] == 0
    # ...but nothing was deleted: the order, its list, the dispatch, the ledger and an invoice remain reachable
    assert get(api, order["id"])["status"] == "delivered" and api.detail(order["delivery_list"]["id"])["status"] == "dispatched"
    assert api.client.get(DISPATCHES, headers=api.headers).json()["total"] == 1 and len(inventory.ledger) == 1


def test_history_is_per_completion_not_per_creation(api, water, acme, monkeypatch):
    from app import clock

    t0 = datetime(2026, 11, 9, 8, 0, tzinfo=timezone.utc)
    now = {"t": t0}
    monkeypatch.setattr(clock, "now", lambda: now["t"])
    old = new_order(api, acme, (water["bottle"], 10))  # created long ago, delivered just now
    now["t"] = t0 + timedelta(days=3)
    dispatch(api, old, water["bottle"], 10)
    assert [o["number"] for o in orders_view(api, view="delivered")["items"]] == [old["number"]]


def test_history_is_scoped_to_the_organization(two_orgs, water, acme, inventory):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    order = new_order(alpha, acme, (water["bottle"], 5))
    dispatch(alpha, order, water["bottle"], 5)
    assert orders_view(alpha, view="delivered")["total"] == 1 and orders_view(beta, view="delivered")["total"] == 0


# =====================================================================================================
# Older lists, scanning and the one booking policy
# =====================================================================================================
def legacy_ready_list(api, session_factory, product, quantity, client_name="Legacy Co"):
    """A Ready list made BEFORE reservations existed: no order, nothing reserved (set up directly in the database)."""
    created = api.new_list(api.new_client(client_name)["id"])
    assert api.add(created["id"], product, quantity).status_code == 201
    with session_factory() as db:
        db.execute(text("UPDATE delivery_lists SET status = 'ready' WHERE id = :id"), {"id": created["id"]})
        db.commit()
    return api.detail(created["id"])


def test_an_older_ready_list_is_marked_as_unbooked_and_never_eats_into_booked_stock(api, water, acme, inventory, session_factory):
    legacy = legacy_ready_list(api, session_factory, water["bottle"], 100)
    assert legacy["booking_state"] == "unbooked" and legacy["order_id"] is None and inventory.reserved(water["bottle"]) == 0
    new_order(api, acme, (water["bottle"], 450))  # 50 available now
    draft = api.draft(legacy["id"], [sent(legacy, water["bottle"], 60)])
    refused = api.confirm(draft["id"])
    assert refused.status_code == 409 and "available" in refused.json()["detail"]["message"] and "reserved for sales orders" in refused.json()["detail"]["message"]
    assert inventory.quantity(water["bottle"]) == 500 and inventory.deduction_writes() == []
    api.put_lines(draft["id"], [sent(legacy, water["bottle"], 50)])
    assert api.confirm(draft["id"]).status_code == 200 and (inventory.quantity(water["bottle"]), inventory.reserved(water["bottle"])) == (450, 450)


def test_an_older_ready_list_can_be_booked_when_the_stock_is_there(api, water, acme, inventory, session_factory):
    legacy = legacy_ready_list(api, session_factory, water["bottle"], 100)
    booked = api.client.post(f"{LISTS}/{legacy['id']}/book", headers=api.headers)
    assert booked.status_code == 200, booked.text
    assert booked.json()["status"] == "active" and booked.json()["origin"] == "list" and inventory.reserved(water["bottle"]) == 100
    assert api.detail(legacy["id"])["booking_state"] == "booked"
    assert api.client.post(f"{LISTS}/{legacy['id']}/book", headers=api.headers).status_code == 200  # repeating books nothing twice
    assert inventory.reserved(water["bottle"]) == 100 and len(inventory.reservation_posts()) == 1
    assert dispatch(api, booked.json(), water["bottle"], 100).status_code == 200


def test_an_older_list_that_cannot_be_booked_says_so_and_changes_nothing(api, water, acme, inventory, session_factory):
    new_order(api, acme, (water["bottle"], 450))
    legacy = legacy_ready_list(api, session_factory, water["bottle"], 100)
    refused = api.client.post(f"{LISTS}/{legacy['id']}/book", headers=api.headers)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "insufficient_available"
    assert api.detail(legacy["id"])["booking_state"] == "unbooked" and inventory.reserved(water["bottle"]) == 450


def test_an_older_partly_dispatched_list_needs_reconciliation_and_is_not_silently_booked(api, water, acme, inventory, session_factory):
    legacy = legacy_ready_list(api, session_factory, water["bottle"], 100)
    assert api.confirm(api.draft(legacy["id"], [sent(legacy, water["bottle"], 30)])["id"]).status_code == 200  # dispatched without a reservation
    assert api.detail(legacy["id"])["booking_state"] == "unbooked_partial"
    refused = api.client.post(f"{LISTS}/{legacy['id']}/book", headers=api.headers)
    assert refused.status_code == 409 and inventory.reserved(water["bottle"]) == 0
    listing = api.client.get(LISTS, params={"has_order": "false"}, headers=api.headers).json()
    assert [(l["number"], l["booking_state"]) for l in listing["items"]] == [(legacy["number"], "unbooked_partial")]


def test_marking_a_scanned_draft_ready_books_it_atomically_or_not_at_all(api, water, acme, inventory):
    draft = api.new_list(acme["id"])
    api.add(draft["id"], water["bottle"], 100)
    api.add(draft["id"], water["flour"], 25)  # only 20 kg
    refused = api.status(draft["id"], "ready")
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "insufficient_available"
    assert api.detail(draft["id"])["status"] == "draft" and inventory.reserved(water["bottle"]) == 0  # no partial booking
    api.client.patch(f"{LISTS}/{draft['id']}/items/{item_of(api.detail(draft['id']), water['flour'])['id']}", json={"quantity": "5"}, headers=api.headers)
    booked = api.status(draft["id"], "ready")
    assert booked.status_code == 200 and booked.json()["booking_state"] == "booked" and booked.json()["order_number"].startswith("SO-")
    assert inventory.reserved(water["bottle"]) == 100 and inventory.reserved(water["flour"]) == 5
    assert api.add(draft["id"], water["bottle"], 1).status_code == 409  # a booked list is changed through its order


def test_a_draft_list_reserves_nothing(api, water, acme, inventory):
    draft = api.new_list(acme["id"])
    api.add(draft["id"], water["bottle"], 100)
    assert inventory.reserved(water["bottle"]) == 0 and inventory.reservation_posts() == []
    detail = api.detail(draft["id"])
    assert detail["booking_state"] == "draft" and detail["can_dispatch"] is False


# =====================================================================================================
# Isolation, permissions, modules
# =====================================================================================================
def test_another_organization_cannot_see_edit_or_cancel_an_order(two_orgs, water, acme, inventory):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    order = new_order(alpha, acme, (water["bottle"], 10))
    assert orders_view(beta)["total"] == 0
    for call in (lambda: beta.client.get(f"{ORDERS}/{order['id']}", headers=beta.headers),
                 lambda: edit(beta, order, (water["bottle"], 5)),
                 lambda: cancel(beta, order), lambda: cancel(beta, order, "cancel-remaining"),
                 lambda: beta.client.post(f"{ORDERS}/{order['id']}/reconcile", headers=beta.headers),
                 lambda: beta.client.get(f"{ORDERS}/{order['id']}/delivery-list", headers=beta.headers)):
        assert call().status_code == 404
    assert create(beta, acme, (water["bottle"], 1)).status_code == 404  # alpha's client
    assert inventory.reserved(water["bottle"]) == 10


def test_the_inventory_service_sees_the_administrators_own_token_and_the_shared_secret(api, water, acme, inventory):
    new_order(api, acme, (water["bottle"], 10))
    assert {token for _, _, token in inventory.requests} == {"admin-alpha"}


def test_only_organization_administrators_with_the_module_can_use_orders(client, directory, two_orgs, water, acme):
    directory.add_user("a-super", "super-admin")
    directory.add_user("a-user", "user", two_orgs["alpha_id"])
    for token in ("a-super", "a-user"):
        assert client.get(ORDERS, headers=bearer(token)).status_code == 403
    assert client.get(ORDERS).status_code in (401, 403)
    no_sales = directory.add_organization("No Sales Co", modules=["inventory"])
    directory.add_user("no-sales", "organization-admin", no_sales)
    refused = client.get(ORDERS, headers=bearer("no-sales"))
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "module_disabled"
    assert client.post(ORDERS, json=body(acme, (water["bottle"], 1)), headers={**bearer("no-sales"), "Idempotency-Key": "order-nomodule-1"}).status_code == 403


# =====================================================================================================
# The database's own rules
# =====================================================================================================
def raw(session_factory, statement, **params):
    with session_factory() as db:
        db.execute(text(statement), params)
        db.commit()


def test_the_database_refuses_illegal_order_changes(api, water, acme, session_factory):
    order = new_order(api, acme, (water["bottle"], 10))
    with pytest.raises(DBAPIError):  # an active order cannot be called pending again
        raw(session_factory, "UPDATE sales_orders SET status = 'pending_reservation', reservation_status = 'pending' WHERE id = :id", id=order["id"])
    with pytest.raises(DBAPIError):  # delivered while its list is not fully dispatched
        raw(session_factory, "UPDATE sales_orders SET status = 'delivered', reservation_status = 'consumed', completed_at = now() WHERE id = :id", id=order["id"])
    with pytest.raises(DBAPIError):  # an order is never deleted
        raw(session_factory, "DELETE FROM sales_orders WHERE id = :id", id=order["id"])
    with pytest.raises(DBAPIError):  # its identity never changes
        raw(session_factory, "UPDATE sales_orders SET number = 'SO-999999' WHERE id = :id", id=order["id"])
    with pytest.raises(DBAPIError):  # a booked reservation must match the status
        raw(session_factory, "UPDATE sales_orders SET reservation_status = 'consumed' WHERE id = :id", id=order["id"])
    assert get(api, order["id"])["status"] == "active"


def test_a_finished_order_can_never_change(api, water, acme, session_factory):
    order = new_order(api, acme, (water["bottle"], 10))
    cancel(api, order)
    with pytest.raises(DBAPIError):
        raw(session_factory, "UPDATE sales_orders SET notes = 'rewritten' WHERE id = :id", id=order["id"])


def test_the_items_of_a_list_without_an_active_order_stay_frozen(api, water, acme, session_factory):
    legacy = legacy_ready_list(api, session_factory, water["bottle"], 10)
    with pytest.raises(DBAPIError):
        raw(session_factory, "UPDATE delivery_list_items SET quantity = 99 WHERE delivery_list_id = :id", id=legacy["id"])
    order = new_order(api, acme, (water["bottle"], 10))
    raw(session_factory, "UPDATE delivery_list_items SET quantity = 12 WHERE delivery_list_id = :id", id=order["delivery_list"]["id"])  # an order's lines may change...
    with pytest.raises(DBAPIError):  # ...but only their quantity
        raw(session_factory, "UPDATE delivery_list_items SET unit = 'box' WHERE delivery_list_id = :id", id=order["delivery_list"]["id"])


def test_the_database_refuses_to_reduce_a_line_below_what_was_dispatched(api, water, acme, session_factory):
    order = new_order(api, acme, (water["bottle"], 100))
    dispatch(api, order, water["bottle"], 60)
    with pytest.raises(DBAPIError):
        raw(session_factory, "UPDATE delivery_list_items SET quantity = 50 WHERE delivery_list_id = :id", id=order["delivery_list"]["id"])
    raw(session_factory, "UPDATE delivery_list_items SET quantity = 70 WHERE delivery_list_id = :id", id=order["delivery_list"]["id"])


def test_one_list_has_at_most_one_order_and_both_belong_to_one_organization(api, water, acme, two_orgs, session_factory):
    order = new_order(api, acme, (water["bottle"], 10))
    with pytest.raises(DBAPIError):
        raw(session_factory,
            "INSERT INTO sales_orders (id, organization_id, number, client_id, delivery_list_id, created_by, created_by_email) "
            "SELECT gen_random_uuid(), organization_id, 'SO-777777', client_id, delivery_list_id, created_by, created_by_email FROM sales_orders WHERE id = :id", id=order["id"])
    with pytest.raises(DBAPIError):  # an order cannot point at another organization's client
        raw(session_factory, "UPDATE sales_orders SET client_id = gen_random_uuid() WHERE id = :id", id=order["id"])


def test_the_module_usage_counts_orders(client, two_orgs, water, acme, api, monkeypatch):
    monkeypatch.setenv("MODULE_INTERNAL_API_KEY", "usage-key")
    new_order(api, acme, (water["bottle"], 10))
    answer = client.get(f"/internal/v1/organizations/{two_orgs['alpha_id']}/module-usage", headers={"X-Internal-Key": "usage-key"}).json()
    counts = {item["code"]: item["count"] for item in answer["blocking"] + answer["warnings"]}
    assert counts["sales_orders_active"] == 1 and counts["orders_booking"] == 0


# =====================================================================================================================================
# What an order is worth: the prices AGREED with the client and saved on the order, never the catalog's
# =====================================================================================================================================
@pytest.fixture
def priced(inventory, two_orgs):
    """Products whose CATALOG data carries a price (some older products still do): it must make no difference to any order."""
    org = two_orgs["alpha_id"]
    bottle = inventory.add_product(org, "P-WATER", "Priced water", "pcs", price="1.2500", currency="USD")
    flour = inventory.add_product(org, "P-FLOUR", "Priced flour", "kg", price="3.3333", currency="USD")
    bare = inventory.add_product(org, "P-NONE", "Without a price", "pcs")
    for product in (bottle, flour, bare):
        inventory.set_stock(product, 1000)
    return {"bottle": bottle, "flour": flour, "bare": bare}


def test_an_order_keeps_the_prices_agreed_for_it_and_totals_them_exactly(api, priced, acme):
    order = new_order(api, acme, (priced["bottle"], 40, "120000"), (priced["flour"], "2.5", "3.3333"), currency="PKR")
    assert order["currency_code"] == "PKR" and order["prices_recorded"] is True
    assert d(order["total_amount"]) == d("4800008.3333")  # 40 x 120000 + 2.5 x 3.3333 = 4800008.33325, kept to four decimals (half up)
    prices = {l["product_sku"]: (d(l["unit_price"]), d(l["line_total"])) for l in order["lines"]}
    assert prices == {"P-WATER": (d("120000"), d("4800000")), "P-FLOUR": (d("3.3333"), d("8.3333"))}
    (card,) = orders_view(api)["items"]
    assert (card["currency_code"], d(card["total_amount"])) == ("PKR", d("4800008.3333"))
    assert get(api, order["id"])["lines"][0]["unit_price"] is not None  # and a later read says the same


def test_the_catalog_price_is_ignored_even_when_the_product_has_one(api, priced, acme):
    order = new_order(api, acme, (priced["bottle"], 10, "9.99"))  # the catalog says 1.25
    assert d(order["total_amount"]) == d("99.9") and d(order["lines"][0]["unit_price"]) == d("9.99")


def test_a_product_without_any_catalog_price_can_be_ordered_at_the_agreed_price(api, priced, acme):
    order = new_order(api, acme, (priced["bare"], 3, "7.5"))
    assert d(order["total_amount"]) == d("22.5")


def test_two_clients_pay_different_prices_for_the_same_product_and_neither_affects_the_other(api, priced, acme, inventory):
    beta_client = api.new_client("Beta Co")
    first = new_order(api, acme, (priced["bottle"], 20, "120000"), currency="PKR")
    second = new_order(api, beta_client, (priced["bottle"], 20, "110000"), currency="PKR")
    assert (d(first["total_amount"]), d(second["total_amount"])) == (d("2400000"), d("2200000"))
    seen = {o["number"]: (o["client"]["name"], d(o["total_amount"])) for o in orders_view(api)["items"]}
    assert seen == {first["number"]: ("Acme Ltd", d("2400000")), second["number"]: ("Beta Co", d("2200000"))}
    assert d(get(api, first["id"])["lines"][0]["unit_price"]) == d("120000") and d(get(api, second["id"])["lines"][0]["unit_price"]) == d("110000")
    # stock is reserved independently, by quantity only: each order holds its own 20
    assert d(first["lines"][0]["stock"]["reserved_for_order"]) == 20 and d(second["lines"][0]["stock"]["reserved_for_order"]) == 20


def test_changing_the_catalog_never_recalculates_an_order(api, priced, acme, inventory, two_orgs):
    order = new_order(api, acme, (priced["bottle"], 10, "5"))
    inventory.products[two_orgs["alpha_id"]][priced["bottle"]]["price"] = "999.0000"  # the catalog changes afterwards
    again = get(api, order["id"])
    assert d(again["total_amount"]) == d("50") and d(again["lines"][0]["unit_price"]) == d("5")
    assert d(orders_view(api)["items"][0]["total_amount"]) == d("50")


def test_an_unreachable_inventory_service_does_not_touch_the_totals(api, priced, acme, inventory):
    order = new_order(api, acme, (priced["bottle"], 5, "2"))
    inventory.mode = "down"
    page = orders_view(api)
    assert [o["id"] for o in page["items"]] == [order["id"]] and d(page["items"][0]["total_amount"]) == d("10") and page["items"][0]["currency_code"] == "USD"


def test_listing_orders_asks_the_inventory_service_for_nothing_about_prices(api, priced, acme, inventory):
    new_order(api, acme, (priced["bottle"], 5, "2"))
    before, asked = inventory.snapshot(), len(inventory.requests)
    orders_view(api)
    assert inventory.snapshot() == before and all(method == "GET" for method, path, _ in inventory.requests[asked:])


def test_an_order_made_before_prices_were_recorded_has_no_total_and_is_not_given_one(api, priced, acme, session_factory):
    order = new_order(api, acme, (priced["bottle"], 5))
    with session_factory() as db:  # what an older order looks like: no currency, no prices
        db.execute(text("UPDATE delivery_list_items SET unit_price = NULL"))
        db.execute(text("UPDATE sales_orders SET currency_code = NULL"))
        db.commit()
    shown = get(api, order["id"])
    assert shown["total_amount"] is None and shown["currency_code"] is None and shown["prices_recorded"] is False
    assert shown["lines"][0]["unit_price"] is None and shown["lines"][0]["line_total"] is None
    assert orders_view(api)["items"][0]["total_amount"] is None


def test_the_price_must_be_given_for_every_line_and_be_a_valid_nonnegative_amount(api, priced, acme):
    base = body(acme, (priced["bottle"], 5, "2"), (priced["flour"], 1, "3"))
    headers = lambda: {**api.headers, "Idempotency-Key": f"order-{uuid.uuid4()}"}
    # missing on one line: refused, never read as zero
    missing = {**base, "lines": [base["lines"][0], {k: v for k, v in base["lines"][1].items() if k != "unit_price"}]}
    assert api.client.post(ORDERS, json=missing, headers=headers()).status_code == 422
    for bad in ["", " ", "-1", "-0.01", "abc", "1,5", "NaN", "Infinity", "1.00001", "1" + "0" * 15, "9" * 19, None, [1], {"a": 1}]:
        payload = {**base, "lines": [{**base["lines"][0], "unit_price": bad}, base["lines"][1]]}
        assert api.client.post(ORDERS, json=payload, headers=headers()).status_code == 422, repr(bad)
    assert orders_view(api)["items"] == []  # nothing was saved, nothing reserved
    zero = {**base, "lines": [{**base["lines"][0], "unit_price": "0"}, base["lines"][1]]}
    assert api.client.post(ORDERS, json=zero, headers=headers()).status_code == 201  # an explicit zero is a price (as on invoices)


def test_the_currency_is_required_must_be_real_and_is_stored_on_the_order(api, priced, acme):
    payload = body(acme, (priced["bottle"], 1, "2"))
    del payload["currency_code"]
    assert api.client.post(ORDERS, json=payload, headers={**api.headers, "Idempotency-Key": "cur-0000001"}).status_code == 422
    for bad in ["US", "USDX", "XXX", "", "12$", "us d", None, 1]:
        assert api.client.post(ORDERS, json=body(acme, (priced["bottle"], 1, "2"), currency=bad), headers={**api.headers, "Idempotency-Key": f"cur-{uuid.uuid4()}"}).status_code == 422, repr(bad)
    made = new_order(api, acme, (priced["bottle"], 1, "2"), currency="eur")
    assert made["currency_code"] == "EUR"


def test_a_price_has_no_influence_on_stock(api, priced, acme, inventory):
    before = d(inventory.stock[priced["bottle"]])
    cheap = new_order(api, acme, (priced["bottle"], 10, "0.01"))
    dear = new_order(api, acme, (priced["bottle"], 10, "9999999.99"))
    assert d(inventory.stock[priced["bottle"]]) == before  # physical stock untouched
    for order in (cheap, dear):
        assert d(order["lines"][0]["stock"]["reserved_for_order"]) == 10


def test_the_request_fingerprint_covers_the_currency_and_every_price(api, priced, acme):
    key = "same-key-0001"
    first = api.client.post(ORDERS, json=body(acme, (priced["bottle"], 5, "2")), headers={**api.headers, "Idempotency-Key": key})
    assert first.status_code == 201
    again = api.client.post(ORDERS, json=body(acme, (priced["bottle"], 5, "2")), headers={**api.headers, "Idempotency-Key": key})
    assert again.status_code == 200 and again.json()["id"] == first.json()["id"]  # a retry replays: no second order, no second reservation
    for other in (body(acme, (priced["bottle"], 5, "3")), body(acme, (priced["bottle"], 5, "2"), currency="EUR"), body(acme, (priced["bottle"], 6, "2"))):
        clash = api.client.post(ORDERS, json=other, headers={**api.headers, "Idempotency-Key": key})
        assert clash.status_code == 409 and "different request" in str(clash.json()["detail"])
    assert len(orders_view(api)["items"]) == 1


def test_an_edit_keeps_saved_prices_and_totals_follow_quantity_times_that_price(api, priced, acme):
    order = new_order(api, acme, (priced["bottle"], 10, "5"), (priced["flour"], 2, "4"))
    edited = edit(api, order, (priced["bottle"], 30), (priced["flour"], 2))  # no price sent: both keep theirs
    assert edited.status_code == 200, edited.text
    body_ = edited.json()
    assert {l["product_sku"]: d(l["unit_price"]) for l in body_["lines"]} == {"P-WATER": d("5"), "P-FLOUR": d("4")}
    assert d(body_["total_amount"]) == d("158")  # 30 x 5 + 2 x 4


def test_a_product_added_in_an_edit_needs_its_own_agreed_price(api, priced, acme):
    order = new_order(api, acme, (priced["bottle"], 10, "5"))
    without = api.client.patch(f"{ORDERS}/{order['id']}", json={"version": order["version"], "lines": [
        {"product_id": priced["bottle"], "quantity": "10"}, {"product_id": priced["flour"], "quantity": "2"}]}, headers=api.headers)
    assert without.status_code == 422 and "agreed price" in str(without.json()["detail"])
    assert get(api, order["id"])["product_count"] == 1  # nothing changed
    ok = edit(api, order, (priced["bottle"], 10), (priced["flour"], 2, "4.5"))
    assert ok.status_code == 200 and d(ok.json()["total_amount"]) == d("59")


def test_a_price_can_be_corrected_before_anything_is_dispatched_but_not_after(api, priced, acme):
    order = new_order(api, acme, (priced["bottle"], 10, "5"))
    fixed = edit(api, order, (priced["bottle"], 10, "6"))
    assert fixed.status_code == 200 and d(fixed.json()["total_amount"]) == d("60")
    order = get(api, order["id"])
    assert dispatch(api, order, priced["bottle"], 4).status_code == 200
    order = get(api, order["id"])
    locked = edit(api, order, (priced["bottle"], 10, "7"))
    assert locked.status_code == 409 and locked.json()["detail"]["code"] == "price_locked"
    same = edit(api, order, (priced["bottle"], 8, "6"))  # the quantity may still change (not below dispatched), at the same price
    assert same.status_code == 200 and d(same.json()["total_amount"]) == d("48")


def test_prices_cannot_be_added_to_an_order_made_before_prices_were_recorded(api, priced, acme, session_factory):
    order = new_order(api, acme, (priced["bottle"], 5))
    with session_factory() as db:
        db.execute(text("UPDATE delivery_list_items SET unit_price = NULL"))
        db.execute(text("UPDATE sales_orders SET currency_code = NULL"))
        db.commit()
    order = get(api, order["id"])
    refused = api.client.patch(f"{ORDERS}/{order['id']}", json={"version": order["version"], "lines": [{"product_id": priced["bottle"], "quantity": "5", "unit_price": "2"}]}, headers=api.headers)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "prices_not_supported"
    quantity_only = api.client.patch(f"{ORDERS}/{order['id']}", json={"version": order["version"], "lines": [{"product_id": priced["bottle"], "quantity": "6"}]}, headers=api.headers)
    assert quantity_only.status_code == 200 and quantity_only.json()["total_amount"] is None


def test_the_database_refuses_a_negative_price_or_a_malformed_currency(engine):
    from sqlalchemy.exc import IntegrityError

    with pytest.raises(IntegrityError):
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO delivery_list_items (organization_id, delivery_list_id, product_id, product_sku, product_name, quantity, unit, unit_price) "
                              "VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'S', 'N', 1, 'pcs', -1)"))
    with pytest.raises(IntegrityError):
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO sales_orders (organization_id, number, client_id, delivery_list_id, currency_code, created_by, created_by_email) "
                              "VALUES (gen_random_uuid(), 'X', gen_random_uuid(), gen_random_uuid(), 'usd', gen_random_uuid(), 'a@b.c')"))


def test_another_organization_never_sees_these_orders_or_their_totals(api, priced, acme, two_orgs):
    new_order(api, acme, (priced["bottle"], 5, "2"))
    assert orders_view(two_orgs["beta"])["items"] == []
