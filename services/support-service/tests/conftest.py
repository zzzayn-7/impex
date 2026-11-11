"""Shared fixtures for the Support Service.

Tests run against a real PostgreSQL database named `impex_support_test`, created fresh from the Alembic migrations at the start of
the session and dropped at the end. The real `impex_support` database is never touched. Run them inside Docker:

    docker compose run --rm --no-deps support-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -v"

The Auth and Organization services are in-process fakes that answer by bearer token exactly like the real ones: an inactive account
is a 401 from Auth, an inactive organization is a 403 from the Organization Service.
"""
import os

os.environ.setdefault("SCHEMA_CHECK", "off")  # the tests build their own database; test_migration_gate.py turns the gate on for its scratch databases
import smtplib
import uuid
from contextlib import contextmanager
from pathlib import Path

import httpx
import pytest
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from app.auth import get_auth_client, get_org_client
from app.database import get_database_url, get_db
from app.main import app

TEST_DB_NAME = "impex_support_test"
SERVICE_DIR = Path(__file__).resolve().parent.parent
SUPPORT_EMAIL = "support-inbox@example.org"
TICKETS = "/api/v1/support/tickets"
ADMIN = "/api/v1/support/admin"


def alembic_config() -> Config:
    config = Config(str(SERVICE_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(SERVICE_DIR / "alembic"))
    return config


@contextmanager
def targeting_test_database():
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
        command.upgrade(alembic_config(), "head")  # the schema comes from the migrations, not create_all
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
def database(engine, session_factory, monkeypatch):
    """Every test starts with empty tables, the test database, no background worker and a known configuration."""
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE TABLE support_requests, support_email_outbox, support_ticket_events, support_messages, support_tickets, support_counters"))
    monkeypatch.setenv("SUPPORT_OUTBOX_WORKER", "off")  # tests run the outbox explicitly
    monkeypatch.setenv("SUPPORT_NOTIFICATION_EMAIL", SUPPORT_EMAIL)
    monkeypatch.setenv("SMTP_HOST", "smtp.test")
    monkeypatch.setenv("SMTP_FROM_ADDRESS", "no-reply@impex.test")
    monkeypatch.setenv("SMTP_FROM_NAME", "Impex")
    monkeypatch.setenv("SUPER_ADMIN_PORTAL_URL", "http://admin.test")
    monkeypatch.setenv("TENANT_PORTAL_URL", "http://portal.test")
    for name in ("SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_STARTTLS", "SMTP_SSL", "SUPPORT_TICKETS_PER_HOUR", "SUPPORT_MESSAGES_PER_10_MIN", "SUPPORT_OUTBOX_MAX_ATTEMPTS"):
        monkeypatch.delenv(name, raising=False)

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield
    app.dependency_overrides.pop(get_db, None)


# --- fake Auth and Organization services ------------------------------------------------------------------------------------
class Directory:
    def __init__(self):
        self.organizations = {}  # id -> {"name", "is_active", "setup_status"}
        self.users = {}  # token -> user dict
        self.auth_down = False
        self.org_down = False
        self.requests = []  # (service, method, path)

    def add_organization(self, name, active=True, setup_status="completed") -> str:
        oid = str(uuid.uuid4())
        self.organizations[oid] = {"name": name, "is_active": active, "setup_status": setup_status}
        return oid

    def add_user(self, token, role, organization_id=None, **overrides) -> dict:
        user = {"id": str(uuid.uuid4()), "email": f"{token}@example.org", "full_name": f"User {token}", "role": role, "organization_id": organization_id,
                "is_active": True, "created_at": "2026-11-04T00:00:00+00:00", **overrides}
        self.users[token] = user
        return user

    def _token(self, request):
        return request.headers.get("authorization", "").removeprefix("Bearer ")

    def _auth(self, request):
        self.requests.append(("auth", request.method, request.url.path))
        if self.auth_down:
            raise httpx.ConnectError("auth is down")
        user = self.users.get(self._token(request))
        if user is None or not user["is_active"]:  # the real Auth Service answers 401 for a disabled account
            return httpx.Response(401, json={"detail": "Invalid or expired token"})
        return httpx.Response(200, json=user)

    def _org(self, request):
        self.requests.append(("org", request.method, request.url.path))
        if self.org_down:
            raise httpx.ConnectError("organization service is down")
        user = self.users.get(self._token(request))
        if user is None or not user["is_active"]:
            return httpx.Response(401, json={"detail": "Missing, invalid or expired token"})
        org = self.organizations.get(str(user.get("organization_id")))
        if user["role"] != "organization-admin" or org is None or not org["is_active"]:
            return httpx.Response(403, json={"detail": "not allowed"})
        # `modules` is what the real Organization Service also reports: Help & Support never looks at it (it is a permanent capability)
        return httpx.Response(200, json={"id": user["organization_id"], "name": org["name"], "is_active": True, "setup_status": org["setup_status"], "modules": org.get("modules", [])})

    def clients(self):
        auth = httpx.AsyncClient(transport=httpx.MockTransport(self._auth), base_url="http://auth-service:8000")
        org = httpx.AsyncClient(transport=httpx.MockTransport(self._org), base_url="http://organization-service:8001")
        return auth, org


@pytest.fixture
def directory():
    return Directory()


@pytest.fixture
def client(directory):
    auth, org = directory.clients()
    app.dependency_overrides[get_auth_client] = lambda: auth
    app.dependency_overrides[get_org_client] = lambda: org
    with TestClient(app) as test_client:
        yield test_client
    for dependency in (get_auth_client, get_org_client):
        app.dependency_overrides.pop(dependency, None)


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


class Api:
    """So the tests read like the story they tell."""

    def __init__(self, client, token):
        self.client, self.token, self.headers = client, token, bearer(token)

    def key(self):
        return {"Idempotency-Key": f"key-{uuid.uuid4()}"}

    def open(self, subject="Cannot print labels", category="technical_issue", priority="normal", message="The label printer shows an error.", key=None, **extra):
        headers = {**self.headers, **({"Idempotency-Key": key} if key else self.key())}
        return self.client.post(TICKETS, json={"subject": subject, "category": category, "priority": priority, "message": message, **extra}, headers=headers)

    def ticket(self, **kwargs) -> dict:
        response = self.open(**kwargs)
        assert response.status_code == 201, response.text
        return response.json()

    def follow_up(self, ticket_id, body="Any news?", key=None):
        headers = {**self.headers, **({"Idempotency-Key": key} if key else self.key())}
        return self.client.post(f"{TICKETS}/{ticket_id}/messages", json={"body": body}, headers=headers)

    def read(self, ticket_id):
        return self.client.get(f"{TICKETS}/{ticket_id}", headers=self.headers)

    def mine(self, **params):
        return self.client.get(TICKETS, params=params, headers=self.headers)

    # Super Admin
    def inbox(self, **params):
        return self.client.get(f"{ADMIN}/tickets", params=params, headers=self.headers)

    def open_admin(self, ticket_id):
        return self.client.get(f"{ADMIN}/tickets/{ticket_id}", headers=self.headers)

    def reply(self, ticket_id, body="We are on it.", status=None, key=None):
        headers = {**self.headers, **({"Idempotency-Key": key} if key else self.key())}
        payload = {"body": body, **({"status": status} if status else {})}
        return self.client.post(f"{ADMIN}/tickets/{ticket_id}/messages", json=payload, headers=headers)

    def update(self, ticket_id, **changes):
        return self.client.patch(f"{ADMIN}/tickets/{ticket_id}", json=changes, headers=self.headers)


@pytest.fixture
def world(directory, client):
    """Two organizations with an administrator each (plus a second one in Alpha), and a Super Admin."""
    alpha, beta = directory.add_organization("Alpha Trading"), directory.add_organization("Beta Logistics")
    directory.add_user("alpha", "organization-admin", alpha, full_name="Alice Alpha", email="alice@alpha.example")
    directory.add_user("alpha2", "organization-admin", alpha, full_name="Alan Alpha", email="alan@alpha.example")
    directory.add_user("beta", "organization-admin", beta, full_name="Bob Beta", email="bob@beta.example")
    directory.add_user("root", "super-admin", None, full_name="Root Admin", email="root@impex.example")
    return {
        "alpha_id": alpha, "beta_id": beta, "directory": directory,
        "alpha": Api(client, "alpha"), "alpha2": Api(client, "alpha2"), "beta": Api(client, "beta"), "root": Api(client, "root"),
    }


# --- fake SMTP ---------------------------------------------------------------------------------------------------------------
class FakeSMTPServer:
    """Stands in for smtplib.SMTP / SMTP_SSL and records everything that is sent."""

    def __init__(self):
        self.messages = []
        self.connections = []
        self.fail_on_connect = None
        self.fail_on_send = None
        self.attempts = 0

    def factory(self, use_ssl):
        server = self

        class _Connection:
            def __init__(self, host, port, timeout=None, **_):
                server.attempts += 1
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
    return server


def plain_text(message) -> str:
    return message.get_body(preferencelist=("plain",)).get_content()


def html_text(message) -> str:
    return message.get_body(preferencelist=("html",)).get_content()
