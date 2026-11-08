"""Migration 0004 (warehouses removed) on a database that holds delivery lists and dispatch lines with warehouses.

The migration is destructive and cannot be reversed, so it is proven on a scratch database that is first brought to 0003 and filled with data:
every quantity must survive, the guard trigger must keep working, and a dispatch that lists one item on two lines (the one thing that cannot be
merged afterwards) must make it stop without changing anything.
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

DB_NAME = "impex_sales_migration_test"


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
        command.upgrade(alembic_config(), "0003")
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


def seed(engine, second_line_same_item=False):
    org, client, delivery_list, user = (uuid.uuid4() for _ in range(4))
    items = [uuid.uuid4(), uuid.uuid4()]
    dispatch, warehouse_a, warehouse_b = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO clients (id, organization_id, name, name_key) VALUES (:c, :o, 'Acme', 'acme')"), {"c": client, "o": org})
        conn.execute(text("INSERT INTO delivery_lists (id, organization_id, client_id, number, created_by, created_by_email) VALUES (:id, :o, :c, 'DL-000001', :u, 'a@b.c')"),
                     {"id": delivery_list, "o": org, "c": client, "u": user})
        for item, quantity in zip(items, ("15", "4")):
            conn.execute(text(
                "INSERT INTO delivery_list_items (id, organization_id, delivery_list_id, product_id, product_sku, product_name, quantity, unit, "
                "planned_warehouse_id, planned_warehouse_code) VALUES (:id, :o, :dl, gen_random_uuid(), 'SKU', 'Thing', :q, 'pcs', :w, 'MAIN')"),
                {"id": item, "o": org, "dl": delivery_list, "q": Decimal(quantity), "w": warehouse_a})
        conn.execute(text("UPDATE delivery_lists SET status = 'ready' WHERE id = :id"), {"id": delivery_list})
        conn.execute(text(
            "INSERT INTO dispatches (id, organization_id, delivery_list_id, client_id, number, dispatch_date, posting_key, created_by, created_by_email) "
            "VALUES (:id, :o, :dl, :c, 'DS-000001', current_date, 'dispatch-' || CAST(:id AS text), :u, 'a@b.c')"), {"id": dispatch, "o": org, "dl": delivery_list, "c": client, "u": user})
        lines = [(items[0], warehouse_a, "6"), (items[1], warehouse_a, "4")]
        if second_line_same_item:
            lines.append((items[0], warehouse_b, "2"))  # the same item from a second warehouse
        for item, warehouse, quantity in lines:
            conn.execute(text(
                "INSERT INTO dispatch_lines (organization_id, dispatch_id, delivery_list_item_id, product_id, product_sku, product_name, unit, warehouse_id, warehouse_code, quantity) "
                "SELECT :o, :d, i.id, i.product_id, i.product_sku, i.product_name, i.unit, :w, 'MAIN', :q FROM delivery_list_items i WHERE i.id = :i"),
                {"o": org, "d": dispatch, "i": item, "w": warehouse, "q": Decimal(quantity)})
    return {"org": org, "dispatch": dispatch, "items": items}


def test_quantities_survive_and_the_columns_are_gone(scratch):
    world = seed(scratch)
    command.upgrade(alembic_config(), "0004")
    with scratch.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0004"
        assert sorted(conn.execute(text("SELECT quantity FROM dispatch_lines")).scalars()) == [Decimal("4"), Decimal("6")]
        assert sorted(conn.execute(text("SELECT quantity FROM delivery_list_items")).scalars()) == [Decimal("4"), Decimal("15")]
        columns = {r[0] for r in conn.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name IN ('dispatch_lines', 'delivery_list_items')"))}
        assert not [c for c in columns if "warehouse" in c]


def test_the_dispatch_line_guard_still_works_after_the_migration(scratch):
    world = seed(scratch)
    command.upgrade(alembic_config(), "0004")
    with scratch.begin() as conn:  # a draft's line can still be changed
        conn.execute(text("UPDATE dispatch_lines SET quantity = 5 WHERE delivery_list_item_id = :i"), {"i": world["items"][0]})
    with pytest.raises(DBAPIError, match="re-pointed"):
        with scratch.begin() as conn:
            conn.execute(text("UPDATE dispatch_lines SET product_id = gen_random_uuid() WHERE delivery_list_item_id = :i"), {"i": world["items"][0]})
    with pytest.raises(DBAPIError):  # one line per item and dispatch
        with scratch.begin() as conn:
            conn.execute(text(
                "INSERT INTO dispatch_lines (organization_id, dispatch_id, delivery_list_item_id, product_id, product_sku, product_name, unit, quantity) "
                "SELECT organization_id, dispatch_id, delivery_list_item_id, product_id, product_sku, product_name, unit, 1 FROM dispatch_lines LIMIT 1"))


def test_an_item_on_two_lines_stops_the_migration_and_changes_nothing(scratch):
    seed(scratch, second_line_same_item=True)
    with pytest.raises(Exception, match="Warehouse removal aborted"):
        command.upgrade(alembic_config(), "0004")
    with scratch.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0003"
        assert conn.execute(text("SELECT count(*) FROM dispatch_lines")).scalar() == 3
        assert conn.execute(text("SELECT count(warehouse_id) FROM dispatch_lines")).scalar() == 3  # the column is still there, still filled


def test_the_migration_cannot_be_reversed(scratch):
    seed(scratch)
    command.upgrade(alembic_config(), "0004")
    with pytest.raises(Exception, match="cannot be reversed"):
        command.downgrade(alembic_config(), "0003")
