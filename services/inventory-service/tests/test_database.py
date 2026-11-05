"""The schema created by the migration, and the guarantees the database itself enforces."""
import uuid
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.models import Product

from conftest import alembic_config, targeting_test_database

MIGRATION = Path(__file__).resolve().parent.parent / "alembic" / "versions" / "0001_create_products_table.py"


def product(org, **overrides):
    values = dict(organization_id=org, sku="S-1", name="N", category="C", unit="pcs",
                  cost_price="1.00", selling_price="2.00", currency_code="USD")
    values.update(overrides)
    return Product(**values)


def test_the_schema_comes_from_the_migration_and_matches_the_models(engine):
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0006"
    with targeting_test_database():
        command.check(alembic_config())  # raises if models and migrations have drifted apart


def test_prices_are_numeric_and_no_column_is_floating_point(engine):
    with engine.connect() as conn:
        columns = {r.column_name: (r.data_type, r.is_nullable) for r in conn.execute(text(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'products'"))}
    assert columns["cost_price"] == ("numeric", "NO") and columns["selling_price"] == ("numeric", "NO")
    assert not [c for c, (t, _) in columns.items() if t in ("double precision", "real")]
    assert columns["organization_id"][1] == "NO"  # every product must belong to an organization
    assert set(columns) == {"id", "organization_id", "sku", "name", "description", "category", "unit", "hs_code", "cost_price",
                            "selling_price", "currency_code", "is_active", "created_at", "updated_at"}  # no stock/quantity columns


def test_the_database_enforces_sku_uniqueness_per_organization(session_factory):
    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    with session_factory() as db:
        db.add_all([product(org_a), product(org_b)])  # the same SKU in two organizations is fine
        db.commit()
        db.add(product(org_a))  # but not twice in one
        with pytest.raises(IntegrityError):
            db.commit()


def test_the_database_refuses_negative_prices(session_factory):
    for column in ("cost_price", "selling_price"):
        with session_factory() as db:
            db.add(product(uuid.uuid4(), **{column: "-0.01"}))
            with pytest.raises(IntegrityError):
                db.commit()


def test_the_database_refuses_a_product_without_an_organization(session_factory):
    with session_factory() as db:
        db.add(product(None))
        with pytest.raises(IntegrityError):
            db.commit()


def test_the_migration_creates_the_table_empty_without_sample_products():
    source = MIGRATION.read_text(encoding="utf-8").lower()
    assert "bulk_insert" not in source and "insert into" not in source and "op.execute" not in source
