"""Migration 0003 (warehouses removed) on a database that holds purchase-order lines and receipt lines with warehouses.

The migration is destructive and cannot be reversed, so it is proven on a scratch database that is first brought to 0002 and filled with data:
every quantity must survive and the receipt-line guard trigger must keep working.
"""
import os
import uuid
from decimal import Decimal

import pytest
from alembic import command
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError

from app.database import get_database_url

from conftest import alembic_config

DB_NAME = "impex_purchasing_migration_test"


@pytest.fixture
def scratch():
    admin = create_engine(get_database_url().set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {DB_NAME} WITH (FORCE)"))
        conn.execute(text(f"CREATE DATABASE {DB_NAME}"))
    previous = os.environ.get("DB_NAME")
    os.environ["DB_NAME"] = DB_NAME
    engine = create_engine(get_database_url().set(database=DB_NAME))
    try:
        command.upgrade(alembic_config(), "0002")
        yield engine
    finally:
        engine.dispose()
        if previous is None:
            os.environ.pop("DB_NAME", None)
        else:
            os.environ["DB_NAME"] = previous
        with admin.connect() as conn:
            conn.execute(text(f"DROP DATABASE IF EXISTS {DB_NAME} WITH (FORCE)"))
        admin.dispose()


def seed(engine):
    org, supplier, order, receipt, user = (uuid.uuid4() for _ in range(5))
    lines = [uuid.uuid4(), uuid.uuid4()]
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO suppliers (id, organization_id, name, name_key) VALUES (:s, :o, 'Sup', 'sup')"), {"s": supplier, "o": org})
        conn.execute(text(
            "INSERT INTO purchase_orders (id, organization_id, supplier_id, number, order_date, currency_code, created_by, created_by_email) "
            "VALUES (:id, :o, :s, 'PO-000001', current_date, 'USD', :u, 'a@b.c')"), {"id": order, "o": org, "s": supplier, "u": user})
        for line, quantity in zip(lines, ("10", "5")):
            conn.execute(text(
                "INSERT INTO purchase_order_lines (id, organization_id, purchase_order_id, product_id, product_sku, product_name, unit, quantity, unit_price, line_total, "
                "planned_warehouse_id, planned_warehouse_code) VALUES (:id, :o, :po, gen_random_uuid(), 'SKU', 'Thing', 'pcs', :q, 1, :q, gen_random_uuid(), 'MAIN')"),
                {"id": line, "o": org, "po": order, "q": Decimal(quantity)})
        conn.execute(text("UPDATE purchase_orders SET status = 'ordered', ordered_at = now(), ordered_by_email = 'a@b.c' WHERE id = :id"), {"id": order})
        conn.execute(text(
            "INSERT INTO goods_receipts (id, organization_id, purchase_order_id, number, received_date, posting_key, created_by, created_by_email) "
            "VALUES (:id, :o, :po, 'GR-000001', current_date, 'goods-receipt-' || CAST(:id AS text), :u, 'a@b.c')"), {"id": receipt, "o": org, "po": order, "u": user})
        for line, accepted, rejected in ((lines[0], "6", "1"), (lines[1], "0", "2")):
            conn.execute(text(
                "INSERT INTO goods_receipt_lines (organization_id, goods_receipt_id, purchase_order_line_id, product_id, product_sku, product_name, unit, "
                "warehouse_id, warehouse_code, accepted_quantity, rejected_quantity) "
                "SELECT :o, :r, l.id, l.product_id, l.product_sku, l.product_name, l.unit, CASE WHEN :a > 0 THEN gen_random_uuid() END, "
                "CASE WHEN :a > 0 THEN 'MAIN' END, :a, :j FROM purchase_order_lines l WHERE l.id = :l"),
                {"o": org, "r": receipt, "l": line, "a": Decimal(accepted), "j": Decimal(rejected)})
    return {"org": org, "receipt": receipt, "lines": lines}


def test_quantities_survive_and_the_columns_are_gone(scratch):
    seed(scratch)
    command.upgrade(alembic_config(), "0003")
    with scratch.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0003"
        rows = conn.execute(text("SELECT accepted_quantity, rejected_quantity FROM goods_receipt_lines ORDER BY accepted_quantity DESC")).all()
        assert [(r[0], r[1]) for r in rows] == [(Decimal("6"), Decimal("1")), (Decimal("0"), Decimal("2"))]
        assert sorted(conn.execute(text("SELECT quantity FROM purchase_order_lines")).scalars()) == [Decimal("5"), Decimal("10")]
        columns = {r[0] for r in conn.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name IN ('goods_receipt_lines', 'purchase_order_lines')"))}
        assert not [c for c in columns if "warehouse" in c]


def test_the_receipt_line_guard_still_works_after_the_migration(scratch):
    world = seed(scratch)
    command.upgrade(alembic_config(), "0003")
    with scratch.begin() as conn:  # a draft's line can still be changed
        conn.execute(text("UPDATE goods_receipt_lines SET accepted_quantity = 7 WHERE purchase_order_line_id = :l"), {"l": world["lines"][0]})
    with pytest.raises(DBAPIError, match="re-pointed"):
        with scratch.begin() as conn:
            conn.execute(text("UPDATE goods_receipt_lines SET product_id = gen_random_uuid() WHERE purchase_order_line_id = :l"), {"l": world["lines"][0]})
    with scratch.begin() as conn:  # accepted goods no longer need a warehouse
        conn.execute(text("UPDATE goods_receipt_lines SET accepted_quantity = 1 WHERE purchase_order_line_id = :l"), {"l": world["lines"][1]})


def test_the_migration_cannot_be_reversed(scratch):
    seed(scratch)
    command.upgrade(alembic_config(), "0003")
    with pytest.raises(Exception, match="cannot be reversed"):
        command.downgrade(alembic_config(), "0002")
