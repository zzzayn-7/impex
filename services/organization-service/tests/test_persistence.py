"""Database persistence tests for the Organization Service (real PostgreSQL, see conftest.py)."""
from contextlib import contextmanager

import httpx
import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

import app.main as main_module
from app.auth import get_auth_client
from app.database import get_db
from app.main import app
from app.models import Organization

from conftest import alembic_config, targeting_test_database

ADMIN = {"id": "1", "email": "root@example.org", "full_name": "Root", "role": "super-admin", "is_active": True}
HEADERS = {"Authorization": "Bearer admin-token"}
URL = "/api/v1/organizations"


def new_org(slug="acme-imports", **overrides):
    return {
        "name": "Acme Imports",
        "slug": slug,
        "country_code": "DE",
        "tax_identifier": "DE123456789",
        "contact_email": "ops@acme.example",
        **overrides,
    }


def fake_auth_client() -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") == "Bearer admin-token":
            return httpx.Response(200, json=ADMIN)
        return httpx.Response(401, json={"detail": "Invalid or expired token"})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://auth-service:8000")


@contextmanager
def running_service(engine):
    """Start the app as a fresh process would: own engine, own sessions, own startup/shutdown."""
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def override_get_db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    auth = fake_auth_client()
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_auth_client] = lambda: auth
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_auth_client, None)


@pytest.fixture
def client(engine):
    with running_service(engine) as c:
        yield c


# --- stored in PostgreSQL ---------------------------------------------------
def test_created_organization_is_stored_in_postgres(client, session_factory):
    response = client.post(URL, json=new_org(), headers=HEADERS)
    assert response.status_code == 201
    body = response.json()

    with session_factory() as db:  # independent session: reads what is really in the database
        row = db.query(Organization).one()
    assert str(row.id) == body["id"]
    assert (row.name, row.slug, row.country_code, row.tax_identifier, row.contact_email) == (
        "Acme Imports", "acme-imports", "DE", "DE123456789", "ops@acme.example",
    )
    assert row.is_active is True
    assert row.primary_admin_email is None
    assert row.created_at.tzinfo is not None
    assert body["is_active"] is True
    assert set(body) == {  # response shape is unchanged from the in-memory version
        "id", "name", "slug", "country_code", "tax_identifier", "contact_email", "primary_admin_email",
        "is_active", "created_at",
    }


def test_optional_tax_identifier_can_be_omitted(client):
    payload = new_org()
    del payload["tax_identifier"]
    response = client.post(URL, json=payload, headers=HEADERS)
    assert response.status_code == 201
    assert response.json()["tax_identifier"] is None


def test_primary_admin_email_is_stored_lowercased(client, session_factory):
    response = client.post(URL, json=new_org(primary_admin_email="Owner@Acme.Example"), headers=HEADERS)
    assert response.status_code == 201
    assert response.json()["primary_admin_email"] == "owner@acme.example"
    with session_factory() as db:
        assert db.query(Organization).one().primary_admin_email == "owner@acme.example"


def test_invalid_primary_admin_email_is_rejected(client, session_factory):
    assert client.post(URL, json=new_org(primary_admin_email="not-an-email"), headers=HEADERS).status_code == 422
    with session_factory() as db:
        assert db.query(Organization).count() == 0


# --- persistence across a service restart -----------------------------------
def test_data_survives_service_restart(test_db_url):
    first_run = create_engine(test_db_url)
    with running_service(first_run) as client:
        ids = [client.post(URL, json=new_org(slug=slug), headers=HEADERS).json()["id"] for slug in ("alpha", "beta")]
    first_run.dispose()  # the "process" is gone: every connection and session is closed

    second_run = create_engine(test_db_url)  # brand-new engine, sessions and app startup
    try:
        with running_service(second_run) as client:
            listed = client.get(URL, headers=HEADERS).json()
            assert [org["id"] for org in listed] == ids
            assert client.get(f"{URL}/{ids[0]}", headers=HEADERS).json()["slug"] == "alpha"
            assert client.get(f"{URL}/beta", headers=HEADERS).json()["id"] == ids[1]
            # the unique constraint is still enforced after the restart
            assert client.post(URL, json=new_org(slug="alpha"), headers=HEADERS).status_code == 409
    finally:
        second_run.dispose()


# --- duplicate slugs --------------------------------------------------------
def test_duplicate_slug_returns_409_and_stores_nothing_extra(client, session_factory):
    assert client.post(URL, json=new_org(), headers=HEADERS).status_code == 201
    duplicate = client.post(URL, json=new_org(name="Another Co"), headers=HEADERS)
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == "Organization slug 'acme-imports' already exists."
    with session_factory() as db:
        assert db.query(Organization).count() == 1


def test_concurrent_duplicate_is_caught_by_the_database_constraint(client, session_factory, monkeypatch):
    """Two requests can both pass the pre-check; the unique constraint must still produce a 409."""
    monkeypatch.setattr(main_module, "slug_exists", lambda db, slug: False)
    assert client.post(URL, json=new_org(), headers=HEADERS).status_code == 201

    raced = client.post(URL, json=new_org(), headers=HEADERS)
    assert raced.status_code == 409
    assert raced.json()["detail"] == "Organization slug 'acme-imports' already exists."

    # the failed transaction was rolled back cleanly: the service keeps working
    assert client.post(URL, json=new_org(slug="other"), headers=HEADERS).status_code == 201
    with session_factory() as db:
        assert db.query(Organization).count() == 2


def test_database_enforces_unique_slug_directly(session_factory):
    with session_factory() as db:
        db.add_all([
            Organization(name="A", slug="same", country_code="US", contact_email="a@x.org"),
            Organization(name="B", slug="same", country_code="US", contact_email="b@x.org"),
        ])
        with pytest.raises(IntegrityError):
            db.commit()


# --- reads ------------------------------------------------------------------
def test_get_by_uuid_slug_and_missing(client):
    org = client.post(URL, json=new_org(), headers=HEADERS).json()
    assert client.get(f"{URL}/{org['id']}", headers=HEADERS).json() == org
    assert client.get(f"{URL}/acme-imports", headers=HEADERS).json() == org
    missing_uuid = "00000000-0000-4000-8000-000000000000"
    assert client.get(f"{URL}/{missing_uuid}", headers=HEADERS).status_code == 404
    assert client.get(f"{URL}/org_default_01", headers=HEADERS).status_code == 404  # not a UUID, not a slug


def test_list_is_ordered_by_creation_time(client):
    for slug in ("first", "second", "third"):
        client.post(URL, json=new_org(slug=slug), headers=HEADERS)
    assert [org["slug"] for org in client.get(URL, headers=HEADERS).json()] == ["first", "second", "third"]


def test_over_long_values_are_rejected_not_a_server_error(client):
    assert client.post(URL, json=new_org(slug="x" * 101), headers=HEADERS).status_code == 422
    assert client.post(URL, json=new_org(name="n" * 256), headers=HEADERS).status_code == 422


# --- authorization still guards the database --------------------------------
def test_unauthenticated_create_stores_nothing(client, session_factory):
    assert client.post(URL, json=new_org()).status_code == 401
    assert client.post(URL, json=new_org(), headers={"Authorization": "Bearer nope"}).status_code == 401
    with session_factory() as db:
        assert db.query(Organization).count() == 0


# --- migrations -------------------------------------------------------------
def test_schema_comes_from_migration_and_matches_models(engine):
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0003"
        columns = {
            row.column_name: row.is_nullable
            for row in conn.execute(text(
                "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'organizations'"
            ))
        }
    assert columns == {
        "id": "NO", "name": "NO", "slug": "NO", "country_code": "NO", "tax_identifier": "YES",
        "contact_email": "NO", "primary_admin_email": "YES", "is_active": "NO", "created_at": "NO",
    }
    with targeting_test_database():
        command.check(alembic_config())  # raises if models and migrations have drifted apart
