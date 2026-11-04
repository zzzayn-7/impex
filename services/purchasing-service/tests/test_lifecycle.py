"""Draft -> Ordered -> (frozen) and Cancelled: the status rules, and the freeze the database enforces itself."""
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from app.models import PurchaseOrder, PurchaseOrderLine

from conftest import ORDERS, SUPPLIERS


@pytest.fixture
def ready(api, shop):
    """A draft order with two lines, ready to be placed."""
    created = api.order(api.supplier("Acme Supplies")["id"], currency="USD", supplier_reference="Q-1")
    api.add(created["id"], shop["bolt"], 50, "1.25")
    api.add(created["id"], shop["flour"], "2.5", "3.10")
    return created


def test_a_new_order_is_a_draft(api, ready):
    detail = api.detail(ready["id"])
    assert (detail["status"], detail["frozen"], detail["ordered_at"], detail["cancelled_at"]) == ("draft", False, None, None)


def test_an_order_needs_lines_to_be_placed(api):
    created = api.order(api.supplier("Acme")["id"])
    refused = api.action(created["id"], "order")
    assert refused.status_code == 409 and "at least one product" in refused.json()["detail"]
    assert api.detail(created["id"])["status"] == "draft"


def test_placing_the_order_freezes_it_and_records_who_and_when(api, ready):
    response = api.action(ready["id"], "order")
    assert response.status_code == 200
    body = response.json()
    assert (body["status"], body["frozen"], body["ordered_by_email"], body["total_amount"]) == ("ordered", True, "admin-alpha@example.org", "70.2500")
    assert body["ordered_at"] and body["cancelled_at"] is None
    assert api.action(ready["id"], "order").status_code == 200  # repeating is harmless


def test_an_ordered_order_cannot_be_edited_in_any_way(api, shop, ready):
    line = api.detail(ready["id"])["lines"][0]
    api.action(ready["id"], "order")
    other_supplier = api.supplier("Other")
    base = f"{ORDERS}/{ready['id']}"
    attempts = [
        api.client.patch(base, json={"notes": "sneaky"}, headers=api.headers),
        api.client.patch(base, json={"supplier_id": other_supplier["id"]}, headers=api.headers),
        api.client.patch(base, json={"currency_code": "EUR"}, headers=api.headers),
        api.client.patch(base, json={"expected_delivery_date": "2099-01-01"}, headers=api.headers),
        api.client.patch(base, json={"supplier_reference": "CHANGED"}, headers=api.headers),
        api.add(ready["id"], shop["old"], 1, "1"),
        api.client.patch(f"{base}/lines/{line['id']}", json={"quantity": "999"}, headers=api.headers),
        api.client.patch(f"{base}/lines/{line['id']}", json={"unit_price": "0.01"}, headers=api.headers),
        api.client.delete(f"{base}/lines/{line['id']}", headers=api.headers),
    ]
    assert [a.status_code for a in attempts] == [409] * len(attempts)
    assert all("frozen" in a.json()["detail"] for a in attempts)
    after = api.detail(ready["id"])
    assert (after["notes"], after["currency_code"], after["supplier_reference"], after["total_amount"], after["line_count"]) == (None, "USD", "Q-1", "70.2500", 2)
    assert after["lines"][0]["quantity"] == "50.0000" and after["lines"][0]["unit_price"] == "1.2500"


def test_there_is_no_way_back_from_ordered_to_draft(api, ready):
    api.action(ready["id"], "order")
    for action in ("reopen", "draft", "unorder", "restore"):
        assert api.action(ready["id"], action).status_code in (404, 405)
    assert api.client.patch(f"{ORDERS}/{ready['id']}", json={"status": "draft"}, headers=api.headers).status_code == 422
    assert api.detail(ready["id"])["status"] == "ordered"


def test_cancelling_a_draft_and_an_ordered_order_keeps_everything_for_history(api, shop, ready):
    other = api.order(api.supplier("Second")["id"])
    api.add(other["id"], shop["bolt"], 3, "2")
    api.action(ready["id"], "order")
    cancelled_ordered = api.action(ready["id"], "cancel").json()
    cancelled_draft = api.action(other["id"], "cancel").json()
    for body in (cancelled_ordered, cancelled_draft):
        assert body["status"] == "cancelled" and body["frozen"] is True and body["cancelled_at"] and body["cancelled_by_email"] == "admin-alpha@example.org"
        assert body["line_count"] > 0 and body["total_amount"] != "0"  # the lines are still there
    assert cancelled_ordered["ordered_at"] and cancelled_ordered["ordered_by_email"]  # and the earlier ordering is still recorded
    listed = api.client.get(ORDERS, params={"status": "cancelled"}, headers=api.headers).json()
    assert listed["total"] == 2


def test_a_cancelled_order_is_final_and_read_only(api, shop, ready):
    api.action(ready["id"], "cancel")
    assert api.action(ready["id"], "cancel").status_code == 200  # repeating is harmless
    refused = api.action(ready["id"], "order")
    assert refused.status_code == 409 and "cancelled" in refused.json()["detail"]
    line = api.detail(ready["id"])["lines"][0]
    assert api.client.patch(f"{ORDERS}/{ready['id']}", json={"notes": "x"}, headers=api.headers).status_code == 409
    assert api.client.delete(f"{ORDERS}/{ready['id']}/lines/{line['id']}", headers=api.headers).status_code == 409
    assert api.add(ready["id"], shop["old"], 1, "1").status_code == 409


def test_an_empty_draft_can_be_cancelled(api):
    created = api.order(api.supplier("Acme")["id"])
    assert api.action(created["id"], "cancel").json()["status"] == "cancelled"


@pytest.mark.parametrize("path", ["receive", "receipt", "goods-received", "complete", "close", "invoice", "pay"])
def test_there_is_no_receiving_or_billing_yet(api, ready, path):
    assert api.action(ready["id"], path).status_code in (404, 405)


def test_placing_the_order_refreshes_the_snapshots_from_the_inventory_service(api, shop, ready, inventory):
    inventory.products[shop["org"]][shop["bolt"]].update(name="Steel bolt M10 (renamed)", sku="BOLT-10")
    body = api.action(ready["id"], "order").json()
    bolt = next(l for l in body["lines"] if l["product_id"] == shop["bolt"])
    assert (bolt["product_name"], bolt["product_sku"]) == ("Steel bolt M10 (renamed)", "BOLT-10")  # frozen with the facts as they are now


def test_placing_the_order_is_refused_if_a_product_has_been_archived(api, shop, ready, inventory):
    inventory.products[shop["org"]][shop["flour"]]["is_active"] = False
    refused = api.action(ready["id"], "order")
    assert refused.status_code == 409 and "Flour" in refused.json()["detail"] and "no longer available" in refused.json()["detail"]
    assert api.detail(ready["id"])["status"] == "draft"
    inventory.products[shop["org"]][shop["flour"]]["is_active"] = True
    assert api.action(ready["id"], "order").status_code == 200


def test_placing_the_order_is_refused_if_a_unit_no_longer_allows_the_fraction(api, shop, ready, inventory):
    inventory.products[shop["org"]][shop["flour"]]["unit"] = "box"  # 2.5 boxes is not an order
    refused = api.action(ready["id"], "order")
    assert refused.status_code == 409 and "whole number" in refused.json()["detail"]
    assert api.detail(ready["id"])["status"] == "draft"


def test_placing_the_order_needs_the_inventory_service(api, ready, inventory):
    inventory.mode = "down"
    assert api.action(ready["id"], "order").status_code == 503
    inventory.mode = None
    assert api.detail(ready["id"])["status"] == "draft"
    inventory.mode = "down"
    assert api.action(ready["id"], "cancel").status_code == 200  # cancelling needs no product facts


def test_an_inactive_supplier_cannot_receive_an_order_but_the_order_can_be_cancelled(api, ready):
    api.client.post(f"{SUPPLIERS}/{ready['supplier']['id']}/deactivate", headers=api.headers)
    refused = api.action(ready["id"], "order")
    assert refused.status_code == 409 and "inactive" in refused.json()["detail"]
    assert api.detail(ready["id"])["supplier"]["is_active"] is False  # still viewable, flagged
    assert api.action(ready["id"], "cancel").status_code == 200


def test_an_ordered_order_survives_its_supplier_being_deactivated(api, ready):
    api.action(ready["id"], "order")
    api.client.post(f"{SUPPLIERS}/{ready['supplier']['id']}/deactivate", headers=api.headers)
    detail = api.detail(ready["id"])
    assert detail["status"] == "ordered" and detail["supplier"]["is_active"] is False and detail["total_amount"] == "70.2500"


def test_concurrent_placing_and_editing_cannot_both_win(api, shop, ready, client):
    """Editing a line and placing the order at the same moment: whatever the order of events, the saved order is consistent."""
    import threading

    line = api.detail(ready["id"])["lines"][0]
    results = {}

    def edit():
        results["edit"] = client.patch(f"{ORDERS}/{ready['id']}/lines/{line['id']}", json={"quantity": "77"}, headers=api.headers).status_code

    def place():
        results["place"] = client.post(f"{ORDERS}/{ready['id']}/order", headers=api.headers).status_code

    threads = [threading.Thread(target=edit), threading.Thread(target=place)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    final = api.detail(ready["id"])
    assert results["place"] == 200 and final["status"] == "ordered"
    first = next(l for l in final["lines"] if l["id"] == line["id"])
    assert (results["edit"], first["quantity"]) in {(200, "77.0000"), (409, "50.0000")}  # edited before it was frozen, or refused after
    assert first["line_total"] == f"{float(first['quantity']) * 1.25:.4f}"  # and the total always matches


# --- the database enforces the freeze even if the API is bypassed ---------------------------------------------------------------------
def only_error(db, sql, params=None):
    with pytest.raises(DBAPIError) as caught:
        db.execute(text(sql), params or {})
        db.commit()
    return str(caught.value)


def test_the_database_refuses_changes_to_an_ordered_orders_details(api, ready, session_factory):
    api.action(ready["id"], "order")
    for column, value in (("notes", "'x'"), ("supplier_reference", "'x'"), ("currency_code", "'EUR'"), ("order_date", "'2000-01-01'"), ("expected_delivery_date", "'2099-01-01'"),
                          ("number", "'PO-999999'"), ("created_by_email", "'x@x'"), ("ordered_at", "now()")):
        with session_factory() as db:
            message = only_error(db, f"UPDATE purchase_orders SET {column} = {value} WHERE id = :id", {"id": ready["id"]})
            assert ("frozen" in message) or (column == "number" and "can never change" in message), column  # the number is part of the identity


def test_the_database_refuses_supplier_changes_to_an_ordered_order(api, ready, session_factory):
    other = api.supplier("Other")
    api.action(ready["id"], "order")
    with session_factory() as db:
        assert "frozen" in only_error(db, "UPDATE purchase_orders SET supplier_id = :s WHERE id = :id", {"s": other["id"], "id": ready["id"]})


def test_the_database_refuses_to_touch_the_lines_of_an_ordered_or_cancelled_order(api, shop, ready, session_factory):
    other = api.order(api.supplier("Second")["id"])
    api.add(other["id"], shop["bolt"], 3, "2")
    api.action(ready["id"], "order")
    api.action(other["id"], "cancel")
    for order_id in (ready["id"], other["id"]):
        with session_factory() as db:
            assert "frozen" in only_error(db, "UPDATE purchase_order_lines SET unit_price = 0, line_total = 0 WHERE purchase_order_id = :id", {"id": order_id})
        with session_factory() as db:
            assert "frozen" in only_error(db, "DELETE FROM purchase_order_lines WHERE purchase_order_id = :id", {"id": order_id})
    with session_factory() as db:
        assert "frozen" in only_error(db, "INSERT INTO purchase_order_lines (organization_id, purchase_order_id, product_id, product_sku, product_name, unit, quantity, unit_price, line_total) "
                                         "SELECT organization_id, id, gen_random_uuid(), 'X', 'X', 'pcs', 1, 1, 1 FROM purchase_orders WHERE id = :id", {"id": ready["id"]})
    assert api.detail(ready["id"])["total_amount"] == "70.2500"


def test_the_database_refuses_illegal_status_changes(api, ready, session_factory):
    api.action(ready["id"], "order")
    with session_factory() as db:
        assert "cannot become draft" in only_error(db, "UPDATE purchase_orders SET status = 'draft' WHERE id = :id", {"id": ready["id"]})
    api.action(ready["id"], "cancel")
    for target in ("draft", "ordered"):
        with session_factory() as db:
            assert "cannot become" in only_error(db, f"UPDATE purchase_orders SET status = '{target}' WHERE id = :id", {"id": ready["id"]})


def test_the_database_refuses_to_order_an_empty_draft(api, session_factory):
    created = api.order(api.supplier("Acme")["id"])
    with session_factory() as db:
        assert "without lines" in only_error(db, "UPDATE purchase_orders SET status = 'ordered' WHERE id = :id", {"id": created["id"]})


def test_the_database_never_deletes_orders(api, ready, session_factory):
    for status_action in (None, "order", "cancel"):
        if status_action:
            api.action(ready["id"], status_action)
        with session_factory() as db:
            assert "never deleted" in only_error(db, "DELETE FROM purchase_orders WHERE id = :id", {"id": ready["id"]})


def test_a_draft_can_still_be_changed_normally_in_the_database(api, shop, ready, session_factory):
    with session_factory() as db:
        db.execute(text("UPDATE purchase_orders SET notes = 'fine' WHERE id = :id"), {"id": ready["id"]})
        db.commit()
    assert api.detail(ready["id"])["notes"] == "fine"
