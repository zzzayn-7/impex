"""Shared test fixtures.

Tests run against a real PostgreSQL database named `impex_organizations_test`, created
fresh from the Alembic migrations at the start of the session and dropped at the end.
The real `impex_organizations` database is never touched.

Run them inside Docker (so the postgres hostname and credentials are available):
    docker compose run --rm --no-deps organization-service sh -c \
        "pip install -q -r requirements-dev.txt && python -m pytest -v"
"""
import os
from contextlib import contextmanager
from pathlib import Path

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from app.database import get_database_url, get_db
from app.main import app

TEST_DB_NAME = "impex_organizations_test"
SERVICE_DIR = Path(__file__).resolve().parent.parent


def alembic_config() -> Config:
    config = Config(str(SERVICE_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(SERVICE_DIR / "alembic"))
    return config


@contextmanager
def targeting_test_database():
    """Alembic's env.py builds its URL from DB_NAME; point it at the test database."""
    previous = os.environ.get("DB_NAME")
    os.environ["DB_NAME"] = TEST_DB_NAME
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("DB_NAME", None)
        else:
            os.environ["DB_NAME"] = previous


@pytest.fixture(scope="session")
def test_db_url():
    return get_database_url().set(database=TEST_DB_NAME)


@pytest.fixture(scope="session")
def test_database(test_db_url):
    from alembic import command

    admin = create_engine(get_database_url().set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            conn.execute(text(f"DROP DATABASE IF EXISTS {TEST_DB_NAME} WITH (FORCE)"))
            conn.execute(text(f"CREATE DATABASE {TEST_DB_NAME}"))
    except OperationalError as exc:
        pytest.fail(f"PostgreSQL is not reachable ({exc.orig}). Run the tests inside Docker; see tests/conftest.py.")

    with targeting_test_database():
        command.upgrade(alembic_config(), "head")  # schema comes from migrations, not create_all
    yield TEST_DB_NAME

    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {TEST_DB_NAME} WITH (FORCE)"))
    admin.dispose()


@pytest.fixture(scope="session")
def engine(test_database, test_db_url):
    eng = create_engine(test_db_url)
    yield eng
    eng.dispose()


@pytest.fixture
def session_factory(engine):
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture(autouse=True)
def database(engine, session_factory):
    """Every test starts with an empty organizations table and uses the test database."""
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE TABLE organizations"))

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield
    app.dependency_overrides.pop(get_db, None)
