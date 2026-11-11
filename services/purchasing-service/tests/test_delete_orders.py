"""Deleting a purchase order (DELETE /api/v1/purchasing/purchase-orders/{id}), by the organization's administrator.

Covers: a draft, a placed (ordered) and a cancelled order with no goods receipt are deleted for good (the order, its lines and its remembered create-request go; the number is not
reused; nothing in Inventory is written); an order that is partially received or received, or that has ANY goods receipt (draft, confirmed or cancelled), is refused with 409 and
stays exactly as it was; another organization's order is a 404 and untouched; repeating the delete is a 404; the database still refuses every other DELETE, and refuses a
deliberate one for an order with goods received or receipts even when the application's switch is on.
"""
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from conftest import ORDERS

PURGE = "SET LOCAL app.deleting_purchase_order = 'on'"


@pytest.fixture
def placed(api, shop):
    order = api.ordered(shop)
    return order


def counts(session_factory, order_id):
    with session_factory() as db:
        one = lambda sql: db.execute(text(sql), {"id": order_id}).scalar()  # noqa: E731
        return {
            "orders": one("SELECT count(*) FROM purchase_orders WHERE id = :id"),
            "lines": one("SELECT count(*) FROM purchase_order_lines WHERE purchase_order_id = :id"),
            "requests": one("SELECT count(*) FROM purchase_order_requests WHERE purchase_order_id = :id"),
        }


def delete(api, order_id):
    return api.client.delete(f"{ORDERS}/{order_id}", headers=api.headers)


def one_receipt(api, order, shop, quantity=4):
    line = next(l for l in order["lines"] if l["product_id"] == shop["bolt"])
    return api.draft(order["id"], [{"purchase_order_line_id": line["id"], "accepted_quantity": str(quantity), "rejected_quantity": "0"}])


def test_a_draft_order_is_deleted_with_its_lines_and_the_number_is_not_reused(api, shop, session_factory):
    order = api.order(api.supplier("Acme")["id"])
    api.add(order["id"], shop["bolt"], 3, "2.00")
    assert counts(session_factory, order["id"]) == {"orders": 1, "lines": 1, "requests": 1}
    response = delete(api, order["id"])
    assert response.status_code == 204 and response.content == b""
    assert counts(session_factory, order["id"]) == {"orders": 0, "lines": 0, "requests": 0}
    assert api.client.get(f"{ORDERS}/{order['id']}", headers=api.headers).status_code == 404
    assert all(o["id"] != order["id"] for o in api.client.get(ORDERS, headers=api.headers).json()["items"])
    assert api.order(api.supplier("Second")["id"])["number"] == "PO-000002"  # the number of a deleted order is never handed out again


def test_a_placed_order_with_no_goods_received_is_deleted(api, placed, session_factory):
    assert placed["status"] == "ordered"
    assert delete(api, placed["id"]).status_code == 204
    assert counts(session_factory, placed["id"]) == {"orders": 0, "lines": 0, "requests": 0}


def test_a_cancelled_order_is_deleted(api, placed, session_factory):
    assert api.action(placed["id"], "cancel").status_code == 200
    assert delete(api, placed["id"]).status_code == 204
    assert counts(session_factory, placed["id"]) == {"orders": 0, "lines": 0, "requests": 0}


def test_deleting_an_order_never_writes_to_inventory(api, placed, inventory):
    before = inventory.snapshot()
    inventory.requests.clear()
    assert delete(api, placed["id"]).status_code == 204
    assert inventory.writes() == [] and inventory.snapshot() == before


def test_an_order_with_confirmed_goods_is_refused_and_stays(api, placed, shop, session_factory):
    receipt = one_receipt(api, placed, shop)
    assert api.confirm(receipt["id"]).status_code == 200
    assert api.detail(placed["id"])["status"] == "partially_received"
    before = counts(session_factory, placed["id"])
    response = delete(api, placed["id"])
    assert response.status_code == 409 and "goods received" in response.json()["detail"]
    assert counts(session_factory, placed["id"]) == before and api.client.get(f"{ORDERS}/{placed['id']}", headers=api.headers).status_code == 200


def test_an_order_with_only_a_draft_receipt_is_refused_and_can_be_cancelled_instead(api, placed, shop):
    one_receipt(api, placed, shop)
    response = delete(api, placed["id"])
    assert response.status_code == 409 and "goods receipts" in response.json()["detail"] and "cancel the order instead" in response.json()["detail"]
    assert api.client.get(f"{ORDERS}/{placed['id']}", headers=api.headers).status_code == 200
    assert api.action(placed["id"], "cancel").status_code == 200  # the draft receipt is cancelled with it ...
    again = delete(api, placed["id"])
    assert again.status_code == 409 and "cancel the order instead" not in again.json()["detail"]  # ... but a cancelled receipt is still a receipt: the order stays


def test_a_fully_received_order_is_refused(api, placed, shop, session_factory):
    for line in placed["lines"]:
        draft = api.draft(placed["id"], [{"purchase_order_line_id": line["id"], "accepted_quantity": line["quantity"], "rejected_quantity": "0"}])
        assert api.confirm(draft["id"]).status_code == 200
    assert api.detail(placed["id"])["status"] == "received"
    assert delete(api, placed["id"]).status_code == 409
    assert counts(session_factory, placed["id"])["orders"] == 1


def test_another_organizations_order_is_a_404_and_untouched(two_orgs, shop, session_factory):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    order = alpha.order(alpha.supplier("Acme")["id"])
    assert delete(beta, order["id"]).status_code == 404
    assert counts(session_factory, order["id"])["orders"] == 1


def test_deleting_twice_or_an_unknown_order_is_a_404(api):
    order = api.order(api.supplier("Acme")["id"])
    assert delete(api, order["id"]).status_code == 204
    assert delete(api, order["id"]).status_code == 404
    assert delete(api, "7b1c2d3e-0000-4000-8000-000000000000").status_code == 404
    assert api.client.delete(f"{ORDERS}/not-a-uuid", headers=api.headers).status_code == 422


def test_only_the_organizations_own_administrator_can_delete(api):
    order = api.order(api.supplier("Acme")["id"])
    assert api.client.delete(f"{ORDERS}/{order['id']}").status_code == 401
    assert api.client.delete(f"{ORDERS}/{order['id']}", headers={"Authorization": "Bearer nobody"}).status_code == 401
    assert api.client.get(f"{ORDERS}/{order['id']}", headers=api.headers).status_code == 200


# ---------------------------------------------------------------------------------------------------------------- the database's own rules
def refused(session_factory, *statements, **params):
    with session_factory() as db:
        with pytest.raises(DBAPIError) as caught:
            for sql in statements:
                db.execute(text(sql), params)
            db.commit()
        return str(caught.value)


def test_a_plain_delete_is_still_refused_by_the_database(api, placed, session_factory):
    assert "never deleted" in refused(session_factory, "DELETE FROM purchase_orders WHERE id = :id", id=placed["id"])


def test_even_with_the_switch_on_the_database_refuses_an_order_with_goods_or_receipts(api, placed, shop, session_factory):
    draft = one_receipt(api, placed, shop)
    assert "receipts" in refused(session_factory, PURGE, "DELETE FROM purchase_orders WHERE id = :id", id=placed["id"])  # a receipt names the order: it stays
    refused(session_factory, PURGE, "DELETE FROM purchase_order_lines WHERE purchase_order_id = :id", id=placed["id"])  # and its lines are named by the receipt's lines
    assert api.confirm(draft["id"]).status_code == 200  # now goods are received
    assert "goods received" in refused(session_factory, PURGE, "DELETE FROM purchase_order_lines WHERE purchase_order_id = :id", id=placed["id"])
    assert "goods received" in refused(session_factory, PURGE, "DELETE FROM purchase_orders WHERE id = :id", id=placed["id"])


def test_the_switch_is_for_one_transaction_only(api, placed, session_factory):
    with session_factory() as db:
        db.execute(text(PURGE))
        db.commit()  # the SET LOCAL ended with that transaction
    assert "never deleted" in refused(session_factory, "DELETE FROM purchase_orders WHERE id = :id", id=placed["id"])
