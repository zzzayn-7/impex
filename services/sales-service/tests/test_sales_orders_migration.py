"""Migration 0005 (sales orders) on a database that already holds delivery lists, dispatches and an invoice.

The migration is additive: every existing row must survive untouched, an existing Ready list must stay a Ready list WITHOUT an order (it is an
older, unbooked list), and the rules of the older lists must keep working: their items stay frozen, while a list that has an ACTIVE order stays
editable only in the ways the new guard allows.
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

DB_NAME = "impex_sales_orders_migration_test"


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
        command.upgrade(alembic_config(), "0004")
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
    org, client, user = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    lists = {"draft": uuid.uuid4(), "ready": uuid.uuid4(), "partial": uuid.uuid4()}
    item_partial = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO clients (id, organization_id, name, name_key) VALUES (:c, :o, 'Acme', 'acme')"), {"c": client, "o": org})
        for number, (kind, list_id) in enumerate(lists.items(), start=1):
            conn.execute(text("INSERT INTO delivery_lists (id, organization_id, client_id, number, created_by, created_by_email) VALUES (:id, :o, :c, :n, :u, 'a@b.c')"),
                         {"id": list_id, "o": org, "c": client, "n": f"DL-{number:06d}", "u": user})
            conn.execute(text(
                "INSERT INTO delivery_list_items (id, organization_id, delivery_list_id, product_id, product_sku, product_name, quantity, unit) "
                "VALUES (:id, :o, :dl, gen_random_uuid(), 'SKU', 'Thing', 10, 'pcs')"),
                {"id": item_partial if kind == "partial" else uuid.uuid4(), "o": org, "dl": list_id})
        conn.execute(text("UPDATE delivery_lists SET status = 'ready' WHERE id IN (:a, :b)"), {"a": lists["ready"], "b": lists["partial"]})
        dispatch = uuid.uuid4()
        conn.execute(text(
            "INSERT INTO dispatches (id, organization_id, delivery_list_id, client_id, number, dispatch_date, status, posting_key, created_by, created_by_email) "
            "VALUES (:id, :o, :dl, :c, 'DS-000001', current_date, 'draft', :key, :u, 'a@b.c')"),
            {"id": dispatch, "o": org, "dl": lists["partial"], "c": client, "key": f"dispatch-{dispatch}", "u": user})
        conn.execute(text("INSERT INTO dispatch_lines (organization_id, dispatch_id, delivery_list_item_id, product_id, product_sku, product_name, unit, quantity) "
                          "SELECT organization_id, :d, id, product_id, product_sku, product_name, unit, 4 FROM delivery_list_items WHERE id = :i"), {"d": dispatch, "i": item_partial})
        conn.execute(text("UPDATE dispatches SET status = 'posting', posting_started_at = now() WHERE id = :d"), {"d": dispatch})
        conn.execute(text("UPDATE dispatch_lines SET inventory_movement_id = gen_random_uuid() WHERE dispatch_id = :d"), {"d": dispatch})
        conn.execute(text("UPDATE dispatches SET status = 'confirmed', inventory_operation_id = gen_random_uuid(), confirmed_at = now(), confirmed_by_email = 'a@b.c' WHERE id = :d"), {"d": dispatch})
        conn.execute(text("UPDATE delivery_lists SET status = 'partially_dispatched' WHERE id = :id"), {"id": lists["partial"]})
    return org, client, user, lists


def snapshot(engine):
    with engine.connect() as conn:
        return {
            table: conn.execute(text(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb)::text FROM {table} t")).scalar()
            for table in ("clients", "delivery_lists", "delivery_list_items", "dispatches", "dispatch_lines")
        }


def test_existing_lists_and_dispatches_survive_untouched_and_stay_unbooked(scratch):
    org, client, user, lists = seed(scratch)
    before = snapshot(scratch)
    command.upgrade(alembic_config(), "0005")
    assert snapshot(scratch) == before  # not one existing row changed
    with scratch.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM sales_orders")).scalar() == 0  # an older list is NOT silently turned into a booked order
        assert {r[0]: r[1] for r in conn.execute(text("SELECT id::text, status FROM delivery_lists"))} == {
            str(lists["draft"]): "draft", str(lists["ready"]): "ready", str(lists["partial"]): "partially_dispatched"}
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0005"


def test_the_older_lists_stay_frozen_and_the_new_rules_work(scratch):
    org, client, user, lists = seed(scratch)
    command.upgrade(alembic_config(), "0005")
    with pytest.raises(DBAPIError):  # a Ready list WITHOUT an order is frozen exactly as before
        with scratch.begin() as conn:
            conn.execute(text("UPDATE delivery_list_items SET quantity = 99 WHERE delivery_list_id = :id"), {"id": lists["ready"]})
    with pytest.raises(DBAPIError):  # an order cannot be created directly in a state that skips the booking
        with scratch.begin() as conn:
            conn.execute(text(
                "INSERT INTO sales_orders (organization_id, number, client_id, delivery_list_id, status, reservation_status, created_by, created_by_email) "
                "VALUES (:o, 'SO-000001', :c, :l, 'active', 'reserved', :u, 'a@b.c')"), {"o": org, "c": client, "l": lists["ready"], "u": user})
    with scratch.begin() as conn:  # the proper start: pending_reservation, then active once the booking is verified
        conn.execute(text(
            "INSERT INTO sales_orders (organization_id, number, client_id, delivery_list_id, created_by, created_by_email, origin) "
            "VALUES (:o, 'SO-000001', :c, :l, :u, 'a@b.c', 'list')"), {"o": org, "c": client, "l": lists["ready"], "u": user})
        conn.execute(text("UPDATE sales_orders SET status = 'active', reservation_status = 'reserved' WHERE number = 'SO-000001'"))
        conn.execute(text("UPDATE delivery_list_items SET quantity = 12 WHERE delivery_list_id = :id"), {"id": lists["ready"]})  # its lines may now change
    with scratch.connect() as conn:
        assert conn.execute(text("SELECT quantity FROM delivery_list_items WHERE delivery_list_id = :id"), {"id": lists["ready"]}).scalar() == Decimal("12")


def test_the_downgrade_restores_the_old_guard(scratch):
    seed(scratch)
    command.upgrade(alembic_config(), "0005")
    command.downgrade(alembic_config(), "0004")
    with scratch.connect() as conn:
        assert conn.execute(text("SELECT to_regclass('sales_orders')")).scalar() is None
        assert conn.execute(text("SELECT count(*) FROM delivery_lists")).scalar() == 3
