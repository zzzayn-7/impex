"""The Stock Movements page: movements of a deleted (archived) product are not listed, and a movement can be taken off the page - while the ledger itself stays exactly as it is."""
import uuid

from sqlalchemy import text

from conftest import PRODUCTS_URL, STOCK_URL


def test_a_deleted_product_s_movements_are_not_listed_and_come_back_when_it_is_restored(api):
    keep, gone = api.product(sku="KEEP", name="Keep"), api.product(sku="GONE", name="Gone")
    api.add(keep, 5)
    api.add(gone, 7)
    assert api.movements()["total"] == 2
    assert api.client.post(f"{PRODUCTS_URL}/{gone['id']}/archive", headers=api.headers).status_code == 200
    page = api.movements()
    assert page["total"] == 1 and [m["product_sku"] for m in page["items"]] == ["KEEP"]
    assert api.client.post(f"{PRODUCTS_URL}/{gone['id']}/restore", headers=api.headers).status_code == 200
    assert api.movements()["total"] == 2  # nothing was erased


def test_a_movement_can_be_taken_off_the_page_without_touching_the_ledger(api, session_factory):
    product = api.product(sku="BOLT", name="Bolt")
    api.add(product, 10)
    api.add(product, 5, action="out")
    first = api.movements()["items"][-1]
    assert api.client.post(f"{STOCK_URL}/movements/{first['id']}/hide", headers=api.headers).status_code == 204
    assert api.client.post(f"{STOCK_URL}/movements/{first['id']}/hide", headers=api.headers).status_code == 204  # asking twice is fine
    page = api.movements()
    assert page["total"] == 1 and first["id"] not in [m["id"] for m in page["items"]]
    assert api.quantity(product) == "5.0000"  # the balance is untouched
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM stock_movements")).scalar() == 2  # the ledger still has both
        assert db.execute(text("SELECT count(*) FROM hidden_movements")).scalar() == 1


def test_only_your_own_movements_can_be_taken_off_the_page(two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    product = alpha.product(sku="BOLT", name="Bolt")
    alpha.add(product, 3)
    mine = alpha.movements()["items"][0]
    assert beta.client.post(f"{STOCK_URL}/movements/{mine['id']}/hide", headers=beta.headers).status_code == 404
    assert alpha.client.post(f"{STOCK_URL}/movements/{uuid.uuid4()}/hide", headers=alpha.headers).status_code == 404
    assert alpha.movements()["total"] == 1
