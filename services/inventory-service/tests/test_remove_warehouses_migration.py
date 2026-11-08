"""Migration 0007 (warehouses removed) on data that really has several warehouses and a transfer.

The migration is destructive and cannot be reversed, so it is proven here on a scratch database that is first brought to 0006, filled with
history, and only then upgraded: the stock of every product must survive exactly, the ledger must still explain it, and a ledger that does
not add up must make the migration refuse to change anything.
"""
import os
import uuid
from decimal import Decimal

import pytest
from alembic import command
from sqlalchemy import create_engine, text

from app.database import get_database_url

from conftest import alembic_config

DB_NAME = "impex_inventory_migration_test"


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
        command.upgrade(alembic_config(), "0006")
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
    org, user = uuid.uuid4(), uuid.uuid4()
    ids = {name: uuid.uuid4() for name in ("bolt", "nut", "a", "b")}
    with engine.begin() as conn:
        for key, sku in (("bolt", "BOLT"), ("nut", "NUT")):
            conn.execute(text("INSERT INTO products (id, organization_id, sku, name, category, unit, cost_price, selling_price, currency_code) "
                              "VALUES (:id, :o, :sku, :sku, 'c', 'pcs', 1, 1, 'USD')"), {"id": ids[key], "o": org, "sku": sku})
        for key, code in (("a", "A"), ("b", "B")):
            conn.execute(text("INSERT INTO warehouses (id, organization_id, code, name) VALUES (:id, :o, :c, :c)"), {"id": ids[key], "o": org, "c": code})

        def operation(op_kind):
            op = uuid.uuid4()
            conn.execute(text("INSERT INTO stock_operations (id, organization_id, kind, idempotency_key, request_hash, created_by) "
                              "VALUES (:id, :o, :k, :key, 'h', :u)"), {"id": op, "o": org, "k": op_kind, "key": f"key-{op}", "u": user})
            return op

        def add(op, kind, product, warehouse, quantity, after, minute, transfer=None):
            conn.execute(text(
                "INSERT INTO stock_movements (id, organization_id, operation_id, product_id, warehouse_id, movement_type, quantity, balance_after, reason, "
                "transfer_id, created_by, created_by_email, created_at) VALUES (gen_random_uuid(), :o, :op, :p, :w, :k, :q, :a, 'seed', :t, :u, 'x@x', "
                "'2026-11-01 10:00:00+00'::timestamptz + make_interval(mins => :m))"),
                {"o": org, "op": op, "p": ids[product], "w": ids[warehouse], "k": kind, "q": quantity, "a": after, "t": transfer, "u": user, "m": minute})

        add(operation("in"), "in", "bolt", "a", 300, 300, 1)
        add(operation("in"), "in", "bolt", "b", 100, 100, 2)
        add(operation("out"), "out", "bolt", "b", 100, 0, 3)
        transfer, op = uuid.uuid4(), operation("transfer")
        add(op, "transfer_out", "bolt", "a", 40, 260, 4, transfer)
        add(op, "transfer_in", "bolt", "b", 40, 40, 4, transfer)
        add(operation("in"), "in", "nut", "a", 5, 5, 5)
        for product, warehouse, quantity in (("bolt", "a", 260), ("bolt", "b", 40), ("nut", "a", 5)):
            conn.execute(text("INSERT INTO stock_balances (id, organization_id, product_id, warehouse_id, quantity) VALUES (gen_random_uuid(), :o, :p, :w, :q)"),
                         {"o": org, "p": ids[product], "w": ids[warehouse], "q": quantity})
    return ids


def test_stock_survives_exactly_and_the_ledger_still_explains_it(scratch):
    ids = seed(scratch)
    command.upgrade(alembic_config(), "0007")
    with scratch.connect() as conn:
        balances = {r.product_id: r.quantity for r in conn.execute(text("SELECT product_id, quantity FROM stock_balances"))}
        assert balances == {ids["bolt"]: Decimal("300.0000"), ids["nut"]: Decimal("5.0000")}  # one balance per product, nothing lost

        movements = conn.execute(text("SELECT movement_type, quantity, balance_after, product_id FROM stock_movements ORDER BY created_at")).all()
        assert [(m.movement_type, m.quantity, m.balance_after) for m in movements if m.product_id == ids["bolt"]] == [
            ("in", Decimal("300"), Decimal("300")), ("in", Decimal("100"), Decimal("400")), ("out", Decimal("100"), Decimal("300")),
        ]  # the transfer pair is gone; the running figure is now the product's total
        assert [(m.movement_type, m.balance_after) for m in movements if m.product_id == ids["nut"]] == [("in", Decimal("5"))]  # untouched

        assert conn.execute(text("SELECT count(*) FROM stock_operations WHERE kind = 'transfer'")).scalar() == 0
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0007"
        tables = {r[0] for r in conn.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"))}
        assert "warehouses" not in tables
        columns = {r[0] for r in conn.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name IN ('stock_balances', 'stock_movements')"))}
        assert "warehouse_id" not in columns and "transfer_id" not in columns

        # the ledger explains every balance
        for product, quantity in balances.items():
            total = conn.execute(text(
                "SELECT COALESCE(SUM(CASE WHEN movement_type IN ('opening','in') THEN quantity ELSE -quantity END), 0) FROM stock_movements WHERE product_id = :p"),
                {"p": product}).scalar()
            assert total == quantity


def test_the_ledger_is_append_only_again_after_the_migration(scratch):
    seed(scratch)
    command.upgrade(alembic_config(), "0007")
    with scratch.connect() as conn:
        enabled = conn.execute(text("SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_stock_movements_append_only'")).scalar()
        assert enabled == "O"
    for statement in ("UPDATE stock_movements SET balance_after = 1", "DELETE FROM stock_movements"):
        with pytest.raises(Exception, match="append-only"):
            with scratch.begin() as conn:
                conn.execute(text(statement))


def test_a_ledger_that_does_not_add_up_stops_the_migration_and_changes_nothing(scratch):
    ids = seed(scratch)
    with scratch.begin() as conn:  # someone edited a balance behind the application's back: the ledger no longer explains it
        conn.execute(text("UPDATE stock_balances SET quantity = quantity + 1 WHERE product_id = :p AND quantity = 260"), {"p": ids["bolt"]})
    with pytest.raises(Exception, match="Warehouse removal aborted"):
        command.upgrade(alembic_config(), "0007")
    with scratch.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0006"
        assert conn.execute(text("SELECT count(*) FROM warehouses")).scalar() == 2
        assert conn.execute(text("SELECT count(*) FROM stock_balances")).scalar() == 3
        assert conn.execute(text("SELECT count(*) FROM stock_movements")).scalar() == 6  # the transfer pair was NOT deleted
        assert conn.execute(text("SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_stock_movements_append_only'")).scalar() == "O"


def test_the_migration_cannot_be_reversed(scratch):
    seed(scratch)
    command.upgrade(alembic_config(), "0007")
    with pytest.raises(Exception, match="cannot be reversed"):
        command.downgrade(alembic_config(), "0006")


def test_an_empty_database_migrates_cleanly(scratch):
    command.upgrade(alembic_config(), "0007")
    with scratch.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM stock_balances")).scalar() == 0
