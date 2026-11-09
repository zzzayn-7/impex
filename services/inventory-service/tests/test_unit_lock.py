"""The unit of measurement cannot change once a product has stock movements (Step 15, regression tests).

"12" only means something together with its unit. Switching pcs -> kg under existing history would silently reinterpret
every recorded quantity, so the API refuses it and a database trigger backs the API up.
"""
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, IntegrityError, OperationalError

from app import stock
from app.models import StockBalance, StockMovement

from conftest import PRODUCTS_URL, bearer


def patch(api, product, **changes):
    return api.client.patch(f"{PRODUCTS_URL}/{product['id']}", json=changes, headers=api.headers)


def get(api, product):
    return api.client.get(f"{PRODUCTS_URL}/{product['id']}", headers=api.headers).json()


def history(session_factory):
    with session_factory() as db:
        balances = sorted((b.product_id, b.quantity) for b in db.scalars(select(StockBalance)))
        movements = sorted((m.id, m.quantity, m.balance_after, m.movement_type) for m in db.scalars(select(StockMovement)))
    return balances, movements


@pytest.fixture
def setup(api):
    return {"product": api.product(sku="OIL", name="Palm oil", unit="litre")}


def test_the_unit_can_still_be_corrected_while_there_is_no_history(api, setup):
    product = setup["product"]
    assert product["unit_locked"] is False
    response = patch(api, product, unit="kg")
    assert response.status_code == 200 and response.json()["unit"] == "kg" and response.json()["unit_locked"] is False


def test_the_unit_is_locked_after_the_first_movement(api, setup, session_factory):
    product = setup["product"]
    api.add(product, 10)
    refused = patch(api, product, unit="kg")
    assert refused.status_code == 409
    assert "unit of measurement cannot be changed" in refused.json()["detail"] and "stock movements" in refused.json()["detail"]
    assert get(api, product)["unit"] == "litre"
    assert get(api, product)["unit_locked"] is True


def test_nothing_is_touched_when_the_change_is_refused(api, setup, session_factory):
    product = setup["product"]
    api.add(product, 10)
    api.add(product, 2, action="out")
    before = history(session_factory)
    assert patch(api, product, unit="m", name="Renamed in the same request").status_code == 409
    assert history(session_factory) == before  # balances and the whole ledger are as they were
    assert get(api, product)["name"] == "Palm oil"  # the other change in the same request was not applied either


def test_resending_the_current_unit_is_not_a_change(api, setup):
    product = setup["product"]
    api.add(product, 1)
    response = patch(api, product, unit="litre", name="Palm oil 5L", selling_price="9.99")
    assert response.status_code == 200 and response.json()["name"] == "Palm oil 5L" and response.json()["unit"] == "litre"


@pytest.mark.parametrize("field,value", [("name", "New name"), ("sku", "OIL-2"), ("cost_price", "3.5"),
                                          ("selling_price", "5"), ("description", "d"), ("hs_code", "1511.90"), ("currency_code", "EUR")])
def test_every_other_field_stays_editable_after_movements(api, setup, field, value):
    api.add(setup["product"], 1)
    assert patch(api, setup["product"], **{field: value}).status_code == 200


def test_the_lock_is_permanent_even_when_the_stock_is_back_to_zero(api, setup):
    product = setup["product"]
    api.add(product, 5)
    api.add(product, 5, action="out")
    assert api.quantity(product) == "0"
    assert patch(api, product, unit="kg").status_code == 409


def test_an_opening_balance_also_locks_the_unit(api, setup):
    api.add(setup["product"], 5, action="opening")
    assert patch(api, setup["product"], unit="kg").status_code == 409


def test_the_lock_applies_to_archived_products_too(api, setup):
    api.add(setup["product"], 5)
    api.client.post(f"{PRODUCTS_URL}/{setup['product']['id']}/archive", headers=api.headers)
    assert patch(api, setup["product"], unit="kg").status_code == 409


def test_a_refused_stock_change_leaves_no_history_so_the_unit_stays_editable(api, setup):
    product = setup["product"]
    assert api.change("out", product_id=product["id"], quantity="1").status_code == 409
    assert api.change("in", product_id=product["id"], quantity="0").status_code == 422
    assert get(api, product)["unit_locked"] is False
    assert patch(api, product, unit="kg").status_code == 200


def test_the_list_reports_which_products_are_locked(api, setup):
    other = api.product(sku="FREE", name="No history yet", unit="pcs")
    api.add(setup["product"], 1)
    items = {p["sku"]: p["unit_locked"] for p in api.client.get(PRODUCTS_URL, headers=api.headers).json()["items"]}
    assert items == {"OIL": True, "FREE": False}
    assert get(api, other)["unit_locked"] is False


def test_the_lock_is_per_product_and_per_organization(two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    a_product = alpha.product(sku="SAME", unit="kg")
    b_product = beta.product(sku="SAME", unit="kg")
    alpha.add(a_product, 3)
    assert patch(alpha, a_product, unit="g").status_code == 409
    assert patch(beta, b_product, unit="g").status_code == 200  # Beta's product has its own, empty history
    assert patch(beta, a_product, unit="g").status_code == 404  # and cannot touch Alpha's product at all


def test_the_database_refuses_the_change_even_if_the_api_is_bypassed(api, setup, session_factory):
    product = setup["product"]
    with session_factory() as db:  # no history yet: allowed
        db.execute(text("UPDATE products SET unit = 'kg' WHERE id = :id"), {"id": product["id"]})
        db.commit()
    api.add(product, 1)
    with session_factory() as db:
        with pytest.raises(DBAPIError) as caught:
            db.execute(text("UPDATE products SET unit = 'g' WHERE id = :id"), {"id": product["id"]})
            db.commit()
        assert "cannot be changed once the product has stock movements" in str(caught.value)
    with session_factory() as db:  # updating other columns directly is still fine
        db.execute(text("UPDATE products SET name = 'x' WHERE id = :id"), {"id": product["id"]})
        db.commit()
    assert get(api, product)["unit"] == "kg"


def test_a_stock_operation_and_a_unit_change_cannot_overlap(api, two_orgs, setup, session_factory, engine):
    """While a stock operation is in progress it holds a shared lock on the product, so an UPDATE of the product
    (the unit change) has to wait instead of slipping in between the unit check and the movement being written."""
    import uuid

    from app.auth import TenantContext

    tenant = TenantContext(organization_id=uuid.UUID(two_orgs["alpha_id"]), user_id=str(uuid.uuid4()), email="x@example.org", full_name="X")
    holder = session_factory()
    try:
        stock._load_product_locked(holder, tenant, uuid.UUID(setup["product"]["id"]))  # operation "in progress"
        with engine.connect() as other:
            other.execute(text("SET lock_timeout = '300ms'"))
            with pytest.raises(OperationalError):
                other.execute(text("UPDATE products SET unit = 'kg' WHERE id = :id"), {"id": setup["product"]["id"]})
    finally:
        holder.rollback()
        holder.close()
    assert patch(api, setup["product"], unit="kg").status_code == 200  # the lock is gone with the transaction


def test_the_api_check_stands_on_its_own_even_if_the_database_trigger_were_missing(api, setup, engine):
    """Two independent layers: prove the API layer by switching the trigger off for the duration of this test."""
    api.add(setup["product"], 5)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE products DISABLE TRIGGER trg_products_unit_locked"))
    try:
        refused = patch(api, setup["product"], unit="kg")
        assert refused.status_code == 409 and "cannot be changed" in refused.json()["detail"]
        with engine.connect() as conn:
            assert conn.execute(text("SELECT unit FROM products WHERE id = :id"), {"id": setup["product"]["id"]}).scalar() == "litre"
    finally:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE products ENABLE TRIGGER trg_products_unit_locked"))
