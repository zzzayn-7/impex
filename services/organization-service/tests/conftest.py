"""Shared test fixtures.

Tests run against a real PostgreSQL database named `impex_organizations_test`, created
fresh from the Alembic migrations at the start of the session and dropped at the end.
The real `impex_organizations` database is never touched.

Run them inside Docker (so the postgres hostname and credentials are available):
    docker compose run --rm --no-deps organization-service sh -c \
        "pip install -q -r requirements-dev.txt && python -m pytest -v"
"""
import os
import re
import smtplib
from contextlib import contextmanager
from pathlib import Path

import httpx
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
        conn.execute(text("TRUNCATE TABLE organizations CASCADE"))  # also clears invitations

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield
    app.dependency_overrides.pop(get_db, None)


# --- fake SMTP + helpers shared by the invitation/mailer tests ----------------
class FakeSMTPServer:
    """Stands in for smtplib.SMTP / SMTP_SSL and records everything that is sent."""

    def __init__(self):
        self.messages = []
        self.connections = []  # one dict per connection: host, port, ssl, starttls, login
        self.fail_on_connect = None  # an exception instance to raise when connecting
        self.fail_on_send = None
        self.fail_on_login = None

    def factory(self, use_ssl):
        server = self

        class _Connection:
            def __init__(self, host, port, timeout=None, **_):
                if server.fail_on_connect:
                    raise server.fail_on_connect
                self.info = {"host": host, "port": port, "ssl": use_ssl, "starttls": False, "login": None}
                server.connections.append(self.info)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def starttls(self, context=None):
                self.info["starttls"] = True

            def login(self, user, password):
                if server.fail_on_login:
                    raise server.fail_on_login
                self.info["login"] = (user, password)

            def send_message(self, message):
                if server.fail_on_send:
                    raise server.fail_on_send
                server.messages.append(message)

        return _Connection


@pytest.fixture
def smtp(monkeypatch):
    server = FakeSMTPServer()
    monkeypatch.setattr(smtplib, "SMTP", server.factory(use_ssl=False))
    monkeypatch.setattr(smtplib, "SMTP_SSL", server.factory(use_ssl=True))
    for name in ("SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_STARTTLS", "SMTP_SSL",
                 "SMTP_FROM_ADDRESS", "SMTP_FROM_NAME"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("APP_BASE_URL", "http://app.test")
    return server


TOKEN_IN_LINK = re.compile(r"/activate#token=([A-Za-z0-9_-]+)")


def token_from_message(message) -> str:
    """The plaintext token exists only in the email; tests read it from there."""
    body = message.get_body(preferencelist=("plain",)).get_content()
    found = TOKEN_IN_LINK.search(body)
    assert found, "activation link not found in email"
    return found.group(1)


def fake_auth_client(tokens: dict) -> httpx.AsyncClient:
    """An Auth Service stand-in. tokens: bearer token -> (status code, JSON body)."""

    def handler(request: httpx.Request) -> httpx.Response:
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        status, body = tokens.get(token, (401, {"detail": "Invalid or expired token"}))
        return httpx.Response(status, json=body)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://auth-service:8000")


@pytest.fixture(autouse=True)
def demo_mode_off_by_default(monkeypatch):
    """Tests never inherit DEMO_MODE from a developer's .env; the demo tests switch it on explicitly."""
    monkeypatch.delenv("DEMO_MODE", raising=False)
    monkeypatch.delenv("DEMO_ADMIN_PASSWORD", raising=False)
