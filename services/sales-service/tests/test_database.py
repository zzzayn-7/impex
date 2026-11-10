"""The schema created by the migration, and the guarantees the database itself enforces."""
import uuid
from decimal import Decimal
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.models import Client, DeliveryList, DeliveryListItem

from conftest import alembic_config, targeting_test_database

MIGRATIONS = Path(__file__).resolve().parent.parent / "alembic" / "versions"


def make_client(org, name="Acme", **extra):
    return Client(organization_id=org, name=name, name_key=name.casefold(), **extra)


def make_list(org, client, number="DL-000001", **extra):
    return DeliveryList(organization_id=org, client_id=client.id, number=number, created_by=uuid.uuid4(), created_by_email="a@b.c", **extra)


def make_item(org, delivery_list, product=None, quantity="1", **extra):
    return DeliveryListItem(organization_id=org, delivery_list_id=delivery_list.id, product_id=product or uuid.uuid4(), product_sku="S", product_name="N",
                            quantity=Decimal(quantity), unit="pcs", **extra)


def test_the_schema_comes_from_the_migration_and_matches_the_models(engine):
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0006"
    with targeting_test_database():
        command.check(alembic_config())  # raises if models and migrations have drifted apart


def test_quantities_are_numeric_and_every_row_has_an_organization(engine):
    with engine.connect() as conn:
        columns = {(r.table_name, r.column_name): (r.data_type, r.is_nullable, r.numeric_precision, r.numeric_scale) for r in conn.execute(text(
            "SELECT table_name, column_name, data_type, is_nullable, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = 'public'"))}
    assert columns[("delivery_list_items", "quantity")] == ("numeric", "NO", 18, 4)
    assert not [k for k, v in columns.items() if v[0] in ("double precision", "real")]
    for table in ("clients", "delivery_lists", "delivery_list_items", "delivery_list_counters"):
        assert columns[(table, "organization_id")][1] == "NO"


def test_the_migration_creates_empty_tables_and_no_sample_data():
    source = "".join(p.read_text(encoding="utf-8").lower() for p in MIGRATIONS.glob("*.py"))
    assert "bulk_insert" not in source and "insert into" not in source


def test_a_product_can_only_be_on_a_list_once(session_factory):
    org = uuid.uuid4()
    with session_factory() as db:
        client = make_client(org)
        db.add(client)
        db.flush()
        delivery_list = make_list(org, client)
        db.add(delivery_list)
        db.flush()
        product = uuid.uuid4()
        db.add(make_item(org, delivery_list, product))
        db.commit()
        db.add(make_item(org, delivery_list, product))
        with pytest.raises(IntegrityError):
            db.commit()


@pytest.mark.parametrize("quantity", ["0", "-1", "-0.0001"])
def test_the_database_refuses_non_positive_quantities(session_factory, quantity):
    org = uuid.uuid4()
    with session_factory() as db:
        client = make_client(org)
        db.add(client)
        db.flush()
        delivery_list = make_list(org, client)
        db.add(delivery_list)
        db.flush()
        db.add(make_item(org, delivery_list, quantity=quantity))
        with pytest.raises(IntegrityError):
            db.commit()


def test_the_database_refuses_an_unknown_status(session_factory):
    org = uuid.uuid4()
    with session_factory() as db:
        client = make_client(org)
        db.add(client)
        db.flush()
        db.add(make_list(org, client, status="shipped"))
        with pytest.raises(IntegrityError):
            db.commit()


def test_numbers_and_client_names_are_unique_per_organization_only(session_factory):
    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    with session_factory() as db:
        a, b = make_client(org_a), make_client(org_b)  # same name in two organizations: fine
        db.add_all([a, b])
        db.flush()
        db.add_all([make_list(org_a, a), make_list(org_b, b)])  # same number in two organizations: fine
        db.commit()
        db.add(make_list(org_a, a))  # but not twice in one
        with pytest.raises(IntegrityError):
            db.commit()
    with session_factory() as db:
        db.add(make_client(org_a))
        with pytest.raises(IntegrityError):
            db.commit()


def test_a_list_cannot_point_at_another_organizations_client(session_factory):
    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    with session_factory() as db:
        theirs = make_client(org_b)
        db.add(theirs)
        db.flush()
        db.add(make_list(org_a, theirs))
        with pytest.raises(IntegrityError):
            db.commit()


def test_an_item_cannot_point_at_another_organizations_list(session_factory):
    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    with session_factory() as db:
        client = make_client(org_b)
        db.add(client)
        db.flush()
        theirs = make_list(org_b, client)
        db.add(theirs)
        db.flush()
        db.add(make_item(org_a, theirs))
        with pytest.raises(IntegrityError):
            db.commit()


def test_a_client_with_lists_cannot_be_deleted(session_factory):
    org = uuid.uuid4()
    with session_factory() as db:
        client = make_client(org)
        db.add(client)
        db.flush()
        db.add(make_list(org, client))
        db.commit()
        with pytest.raises(IntegrityError):
            db.execute(text("DELETE FROM clients WHERE id = :id"), {"id": client.id})
            db.commit()
