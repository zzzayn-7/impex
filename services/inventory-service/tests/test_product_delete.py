"""Deleting a product FOR GOOD (as opposed to archiving it): everything the organization holds about it here disappears; other organizations and other products are untouched."""
import uuid

from sqlalchemy import text

from conftest import PRODUCTS_URL


def counts(session_factory):
    with session_factory() as db:
        return {table: db.execute(text(f"SELECT count(*) FROM {table}")).scalar() for table in ("products", "stock_balances", "stock_movements", "stock_operations", "product_identifiers")}


def test_a_deleted_product_is_gone_with_its_stock_and_history_and_the_others_stay(api, session_factory):
    keep, gone = api.product(sku="KEEP", name="Keep"), api.product(sku="GONE", name="Gone")
    api.add(keep, 5)
    api.add(gone, 7)
    api.add(gone, 2, action="out")
    before = counts(session_factory)
    assert api.client.delete(f"{PRODUCTS_URL}/{gone['id']}", headers=api.headers).status_code == 204
    after = counts(session_factory)
    assert after["products"] == before["products"] - 1
    assert after["stock_movements"] == 1 and after["stock_balances"] == 1  # only KEEP's opening/in movement is left
    assert api.client.get(f"{PRODUCTS_URL}/{gone['id']}", headers=api.headers).status_code == 404
    assert [p["sku"] for p in api.client.get(PRODUCTS_URL, params={"status": "all"}, headers=api.headers).json()["items"]] == ["KEEP"]
    assert api.quantity(keep) == "5.0000"
    assert api.product(sku="GONE", name="Again")["sku"] == "GONE"  # the SKU is free again


def test_an_archived_product_can_be_deleted_too_and_a_missing_one_is_404(api):
    product = api.product(sku="OLD", name="Old")
    assert api.client.post(f"{PRODUCTS_URL}/{product['id']}/archive", headers=api.headers).status_code == 200
    assert api.client.delete(f"{PRODUCTS_URL}/{product['id']}", headers=api.headers).status_code == 204
    assert api.client.delete(f"{PRODUCTS_URL}/{product['id']}", headers=api.headers).status_code == 404


def test_one_organization_cannot_delete_another_organizations_product(two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    product = alpha.product(sku="BOLT", name="Bolt")
    assert beta.client.delete(f"{PRODUCTS_URL}/{product['id']}", headers=beta.headers).status_code == 404
    assert alpha.client.get(f"{PRODUCTS_URL}/{product['id']}", headers=alpha.headers).status_code == 200


def test_a_product_that_sales_orders_still_hold_cannot_be_deleted_until_they_are_released(api, session_factory, monkeypatch):
    from test_reservations import SECRET, order_line, release, reserve

    monkeypatch.setenv("RESERVATION_API_KEY", SECRET["X-Internal-Key"])
    product = api.product(sku="HELD", name="Held")
    api.add(product, 10)
    order = str(uuid.uuid4())
    assert reserve(api, order, [order_line(product, 4)]).status_code in (200, 201)
    refused = api.client.delete(f"{PRODUCTS_URL}/{product['id']}", headers=api.headers)
    assert refused.status_code == 409 and "Sales orders still hold stock" in refused.json()["detail"]
    assert api.quantity(product) == "10.0000" and counts(session_factory)["stock_movements"] == 1  # nothing was touched
    assert release(api, order).status_code in (200, 201)
    assert api.client.delete(f"{PRODUCTS_URL}/{product['id']}", headers=api.headers).status_code == 204
