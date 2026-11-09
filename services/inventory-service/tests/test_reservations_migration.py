"""Migration 0008 (stock reservations) on a database that already holds products, balances and movements.

It is additive: every balance and movement stays exactly as it is, nothing is reserved afterwards (available = on hand), and the new rules
(0 <= reserved <= on hand; one reservation per order line; original = consumed + released + remaining) are enforced by the database itself.
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

DB_NAME = "impex_inventory_reservations_migration_test"


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
        command.upgrade(alembic_config(), "0007")
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
    org, product, user, operation = (uuid.uuid4() for _ in range(4))
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO products (id, organization_id, sku, name, category, unit, cost_price, selling_price, currency_code) VALUES (:p, :o, 'W', 'Water', 'D', 'pcs', 1, 2, 'USD')"), {"p": product, "o": org})
        conn.execute(text("INSERT INTO stock_operations (id, organization_id, kind, idempotency_key, request_hash, created_by) VALUES (:id, :o, 'in', 'seed-key-0001', 'h', :u)"), {"id": operation, "o": org, "u": user})
        conn.execute(text("INSERT INTO stock_balances (organization_id, product_id, quantity) VALUES (:o, :p, 500)"), {"o": org, "p": product})
        conn.execute(text("INSERT INTO stock_movements (organization_id, operation_id, product_id, movement_type, quantity, balance_after, reason, created_by, created_by_email) VALUES (:o, :op, :p, 'in', 500, 500, 'Stock in', :u, 'a@b.c')"),
                     {"o": org, "op": operation, "p": product, "u": user})
    return org, product


def test_existing_stock_is_untouched_and_nothing_is_reserved(scratch):
    org, product = seed(scratch)
    with scratch.connect() as conn:
        before = conn.execute(text("SELECT (SELECT to_jsonb(b) - 'reserved_quantity' FROM stock_balances b)::text, (SELECT jsonb_agg(to_jsonb(m)) FROM stock_movements m)::text")).one()
    command.upgrade(alembic_config(), "0008")
    with scratch.connect() as conn:
        after = conn.execute(text("SELECT (SELECT to_jsonb(b) - 'reserved_quantity' FROM stock_balances b)::text, (SELECT jsonb_agg(to_jsonb(m)) FROM stock_movements m)::text")).one()
        assert after == before
        assert conn.execute(text("SELECT quantity, reserved_quantity FROM stock_balances")).one() == (Decimal("500"), Decimal("0"))  # available = on hand until something is booked
        assert conn.execute(text("SELECT count(*) FROM stock_reservations")).scalar() == 0


def test_the_database_enforces_the_reservation_rules(scratch):
    org, product = seed(scratch)
    command.upgrade(alembic_config(), "0008")
    for bad in ("UPDATE stock_balances SET reserved_quantity = 501", "UPDATE stock_balances SET reserved_quantity = -1"):
        with pytest.raises(DBAPIError):
            with scratch.begin() as conn:
                conn.execute(text(bad))
    line = uuid.uuid4()
    insert = ("INSERT INTO stock_reservations (organization_id, product_id, source_type, source_id, source_reference, source_line_id, original_quantity, consumed_quantity, released_quantity, remaining_quantity, status) "
              "VALUES (:o, :p, 'sales_order', gen_random_uuid(), 'SO-000001', :l, :orig, :c, :r, :rem, :s)")
    ok = {"o": org, "p": product, "l": line, "orig": 100, "c": 30, "r": 10, "rem": 60, "s": "active"}
    with scratch.begin() as conn:
        conn.execute(text(insert), ok)
    for override in ({"rem": 61}, {"s": "fulfilled"}, {"l": uuid.uuid4(), "orig": 0, "c": 0, "r": 0, "rem": 0, "s": "released"}):
        with pytest.raises(DBAPIError):
            with scratch.begin() as conn:
                conn.execute(text(insert), {**ok, "l": uuid.uuid4(), **override})
    with pytest.raises(DBAPIError):  # one reservation per order line
        with scratch.begin() as conn:
            conn.execute(text(insert), ok)
    with pytest.raises(DBAPIError):  # a reservation belongs to the same organization as its product
        with scratch.begin() as conn:
            conn.execute(text(insert), {**ok, "o": uuid.uuid4(), "l": uuid.uuid4()})


def test_the_downgrade_removes_only_what_the_migration_added(scratch):
    seed(scratch)
    command.upgrade(alembic_config(), "0008")
    command.downgrade(alembic_config(), "0007")
    with scratch.connect() as conn:
        assert conn.execute(text("SELECT to_regclass('stock_reservations')")).scalar() is None
        assert conn.execute(text("SELECT quantity FROM stock_balances")).scalar() == Decimal("500")
