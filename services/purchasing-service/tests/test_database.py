"""The schema created by the migration, and the guarantees the database itself enforces."""
import uuid
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.models import PurchaseOrder, PurchaseOrderLine, Supplier

from conftest import alembic_config, targeting_test_database

MIGRATIONS = Path(__file__).resolve().parent.parent / "alembic" / "versions"


def make_supplier(org, name="Acme", **extra):
    return Supplier(organization_id=org, name=name, name_key=name.casefold(), **extra)


def make_order(org, supplier, number="PO-000001", **extra):
    return PurchaseOrder(organization_id=org, supplier_id=supplier.id, number=number, order_date=date(2026, 11, 6), currency_code="USD",
                         created_by=uuid.uuid4(), created_by_email="a@b.c", **extra)


def make_line(org, order, product=None, quantity="2", price="1.5", total=None, **extra):
    q, p = Decimal(quantity), Decimal(price)
    return PurchaseOrderLine(organization_id=org, purchase_order_id=order.id, product_id=product or uuid.uuid4(), product_sku="S", product_name="N", unit="pcs",
                             quantity=q, unit_price=p, line_total=Decimal(total) if total is not None else (q * p).quantize(Decimal("0.0001")), **extra)


def seed(db, org):
    supplier = make_supplier(org)
    db.add(supplier)
    db.flush()
    order = make_order(org, supplier)
    db.add(order)
    db.flush()
    return supplier, order


def test_the_schema_comes_from_the_migration_and_matches_the_models(engine):
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0004"
    with targeting_test_database():
        command.check(alembic_config())  # raises if models and migrations have drifted apart


def test_money_and_quantities_are_numeric_and_every_row_has_an_organization(engine):
    with engine.connect() as conn:
        columns = {(r.table_name, r.column_name): (r.data_type, r.is_nullable, r.numeric_precision, r.numeric_scale) for r in conn.execute(text(
            "SELECT table_name, column_name, data_type, is_nullable, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = 'public'"))}
    for column in ("quantity", "unit_price", "line_total"):
        assert columns[("purchase_order_lines", column)] == ("numeric", "NO", 18, 4)
    assert not [k for k, v in columns.items() if v[0] in ("double precision", "real")]
    for table in ("suppliers", "purchase_orders", "purchase_order_lines", "purchase_order_counters", "purchase_order_requests"):
        assert columns[(table, "organization_id")][1] == "NO"


def test_the_migration_creates_empty_tables_and_no_sample_data():
    source = "".join(p.read_text(encoding="utf-8").lower() for p in MIGRATIONS.glob("*.py"))
    assert "bulk_insert" not in source and "insert into" not in source


def test_a_product_can_only_be_on_an_order_once(session_factory):
    org, product = uuid.uuid4(), uuid.uuid4()
    with session_factory() as db:
        _, order = seed(db, org)
        db.add(make_line(org, order, product))
        db.commit()
        db.add(make_line(org, order, product))
        with pytest.raises(IntegrityError):
            db.commit()


@pytest.mark.parametrize("kwargs", [dict(quantity="0", total="0"), dict(quantity="-1", price="1", total="-1"), dict(price="-1", total="-3"), dict(total="3.0001"), dict(total="2")])
def test_the_database_refuses_bad_quantities_prices_and_totals(session_factory, kwargs):
    org = uuid.uuid4()
    with session_factory() as db:
        _, order = seed(db, org)
        db.add(make_line(org, order, **kwargs))
        with pytest.raises(IntegrityError):
            db.commit()


def test_the_database_refuses_an_unknown_status_and_bad_currency_and_dates(session_factory):
    org = uuid.uuid4()
    for extra in (dict(status="shipped"), dict(currency_code="usd"), dict(currency_code="US"), dict(expected_delivery_date=date(2026, 11, 1))):
        with session_factory() as db:
            supplier = make_supplier(org, f"S-{extra}")
            db.add(supplier)
            db.flush()
            order = make_order(org, supplier)
            for key, value in extra.items():
                setattr(order, key, value)
            db.add(order)
            with pytest.raises(IntegrityError):
                db.commit()


def test_numbers_names_and_codes_are_unique_per_organization_only(session_factory):
    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    with session_factory() as db:
        a, b = make_supplier(org_a, code="C1"), make_supplier(org_b, code="C1")  # same name and code in two organizations: fine
        db.add_all([a, b])
        db.flush()
        db.add_all([make_order(org_a, a), make_order(org_b, b)])  # same number in two organizations: fine
        db.commit()
        db.add(make_order(org_a, a))  # but not twice in one
        with pytest.raises(IntegrityError):
            db.commit()
    with session_factory() as db:
        db.add(make_supplier(org_a, "Different", code="C1"))  # same code twice in one organization
        with pytest.raises(IntegrityError):
            db.commit()
    with session_factory() as db:
        db.add_all([make_supplier(org_a, "Nocode 1"), make_supplier(org_a, "Nocode 2")])  # missing codes never clash
        db.commit()


def test_an_order_cannot_point_at_another_organizations_supplier(session_factory):
    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    with session_factory() as db:
        theirs = make_supplier(org_b)
        db.add(theirs)
        db.flush()
        db.add(make_order(org_a, theirs))
        with pytest.raises(IntegrityError):
            db.commit()


def test_a_line_cannot_point_at_another_organizations_order(session_factory):
    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    with session_factory() as db:
        _, theirs = seed(db, org_b)
        db.add(make_line(org_a, theirs))
        with pytest.raises(IntegrityError):
            db.commit()


def test_a_supplier_with_orders_cannot_be_deleted(session_factory):
    org = uuid.uuid4()
    with session_factory() as db:
        supplier, _ = seed(db, org)
        db.commit()
        with pytest.raises(IntegrityError):
            db.execute(text("DELETE FROM suppliers WHERE id = :id"), {"id": supplier.id})
            db.commit()
