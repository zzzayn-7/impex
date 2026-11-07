"""Shared test fixtures.

Tests run against a real PostgreSQL database named `impex_finance_test`, created fresh from the Alembic migrations at the start of the session and
dropped at the end. The real `impex_finance` database is never touched.

The Auth Service, the Organization Service and the Sales/Purchasing feeds are replaced by in-process fakes that answer the way the real ones do:
who the caller is, and which organization they belong to, is decided by the Bearer token alone.

Run them inside Docker (so the postgres hostname and credentials are available):
    docker compose run --rm --no-deps finance-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -v"
"""
import os
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

os.environ["FINANCE_SYNC_ENABLED"] = "false"  # tests drive the synchronisation themselves; no background thread
os.environ.pop("MODULE_INTERNAL_API_KEY", None)

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
from app.sync import SourceUnavailable

TEST_DB_NAME = "impex_finance_test"
SERVICE_DIR = Path(__file__).resolve().parent.parent
PREFIX = "/api/v1/finance"
ENTRIES = f"{PREFIX}/journal-entries"
EXPENSES = f"{PREFIX}/expenses"
ACCOUNTS = f"{PREFIX}/accounts"
ACTIVATED = datetime(2026, 11, 1, tzinfo=timezone.utc)  # when the fake Organization Service says Finance was switched on


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
        command.upgrade(alembic_config(), "head")  # schema comes from migrations, not create_all
    yield TEST_DB_NAME
    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {TEST_DB_NAME} WITH (FORCE)"))
    admin.dispose()


@pytest.fixture(scope="session")
def engine(test_database, test_db_url):
    eng = create_engine(test_db_url, pool_size=20)
    yield eng
    eng.dispose()


@pytest.fixture
def session_factory(engine):
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture(autouse=True)
def database(engine, session_factory):
    """Every test starts with empty tables and uses the test database."""
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE TABLE finance_events, finance_requests, finance_counters, sync_events, sync_sources, expenses, journal_lines, journal_entries, accounts, finance_organizations"))

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield
    app.dependency_overrides.pop(get_db, None)


# --- stand-ins for the Auth Service and the Organization Service ---------------------------------------
class Directory:
    """Answers GET /api/v1/auth/me and GET /api/v1/tenant/organization like the real services do."""

    def __init__(self):
        self.users = {}  # token -> user record
        self.organizations = {}  # organization id -> {"name": ..., "is_active": ...}
        self.auth_mode = None  # "down" | "500"
        self.org_mode = None

    def add_organization(self, name: str, active: bool = True, modules=None, currency: str = "USD") -> str:
        org_id = str(uuid.uuid4())
        self.organizations[org_id] = {"name": name, "is_active": active, "setup_status": "completed", "modules": list(modules) if modules is not None else ["finance"], "default_currency": currency}
        return org_id

    def add_user(self, token: str, role: str, organization_id=None, **overrides) -> dict:
        user = {
            "id": str(uuid.uuid4()), "email": f"{token}@example.org", "full_name": f"User {token}", "role": role,
            "organization_id": organization_id, "is_active": True, "profile_setup_completed_at": "2026-11-04T00:05:00+00:00", "created_at": "2026-11-05T00:00:00+00:00", **overrides,
        }
        self.users[token] = user
        return user

    def _token(self, request: httpx.Request) -> str:
        return request.headers.get("authorization", "").removeprefix("Bearer ")

    def _auth(self, request: httpx.Request) -> httpx.Response:
        if self.auth_mode == "down":
            raise httpx.ConnectError("connection refused")
        if self.auth_mode == "500":
            return httpx.Response(500, json={"detail": "boom"})
        user = self.users.get(self._token(request))
        return httpx.Response(200, json=user) if user else httpx.Response(401, json={"detail": "Invalid or expired token"})

    def _org(self, request: httpx.Request) -> httpx.Response:
        if self.org_mode == "down":
            raise httpx.ConnectError("connection refused")
        if self.org_mode == "500":
            return httpx.Response(500, json={"detail": "boom"})
        user = self.users.get(self._token(request))
        if user is None:
            return httpx.Response(401, json={"detail": "Missing, invalid or expired token"})
        organization = self.organizations.get(str(user.get("organization_id")))
        if user["role"] != "organization-admin" or organization is None or not organization["is_active"]:
            return httpx.Response(403, json={"detail": "Your organization is not active."})
        body = {"id": user["organization_id"], "name": organization["name"], "is_active": True, "default_currency": organization["default_currency"]}
        if self.org_mode != "no-setup-status":
            body["setup_status"] = organization.get("setup_status", "completed")
        if self.org_mode != "no-modules":
            body["modules"] = organization["modules"] if self.org_mode != "garbled-modules" else "all"
        return httpx.Response(200, json=body)

    def clients(self):
        auth = httpx.AsyncClient(transport=httpx.MockTransport(self._auth), base_url="http://auth-service:8000")
        org = httpx.AsyncClient(transport=httpx.MockTransport(self._org), base_url="http://organization-service:8001")
        return auth, org


# --- stand-in for the Sales / Purchasing feeds and the Organization Service's list of Finance organizations ----------------------------------
class FakeFeeds:
    """Same interface as app.sync.FeedClient. Events are plain dicts as the real feeds send them; `down` makes a source unreachable."""

    def __init__(self, directory: Directory):
        self.directory = directory
        self.events = {}  # (source, org) -> [event dicts]
        self.down = set()  # {"sales", "purchasing", "organizations"}
        self.calls = []  # (source, org, since, limit)
        self.enabled_at = {}  # org -> when Finance was switched on

    def organizations(self):
        if "organizations" in self.down:
            raise SourceUnavailable("ConnectError")
        return [
            {"organization_id": org, "enabled_at": self.enabled_at.get(org, ACTIVATED).isoformat(), "default_currency": o["default_currency"]}
            for org, o in self.directory.organizations.items() if o["is_active"] and o["setup_status"] == "completed" and "finance" in o["modules"]
        ]

    def feed(self, source, organization_id, since, limit):
        self.calls.append((source, str(organization_id), since, limit))
        if source in self.down:
            raise SourceUnavailable("ConnectError")
        def when(e):  # (a malformed event with no readable time is passed through untouched, as a misbehaving real feed would)
            try:
                return datetime.fromisoformat(e["time"])
            except (KeyError, ValueError, TypeError):
                return datetime.max.replace(tzinfo=timezone.utc)

        events = [e for e in self.events.get((source, str(organization_id)), []) if since is None or when(e) >= since]
        events.sort(key=lambda e: (when(e), str(e.get("key"))))
        return {"events": [dict(e) for e in events[:limit]], "has_more": len(events) > limit}

    def close(self):
        pass

    # -- building events
    def add(self, source, org, key, kind, when, data):
        event = {"key": key, "type": kind, "time": when.isoformat(), "data": data}
        self.events.setdefault((source, str(org)), []).append(event)
        return event

    def invoice_issued(self, org, *, invoice_id=None, number="INV-000001", currency="USD", subtotal="100.00", discount="0", tax="0", total=None, when=None, client="Acme Ltd"):
        invoice_id = invoice_id or str(uuid.uuid4())
        when = when or now()
        if total is None:
            total = str(Decimal(subtotal) - Decimal(discount) + Decimal(tax))
        data = {"invoice_id": invoice_id, "number": number, "currency_code": currency, "issued_at": when.isoformat(), "subtotal": subtotal, "discount_total": discount, "tax_total": tax, "total": total, "client_name": client}
        return self.add("sales", org, f"invoice-issued:{invoice_id}", "invoice.issued", when, data)

    def invoice_voided(self, org, issued, *, when=None):
        when = when or now()
        data = issued["data"]
        return self.add("sales", org, f"invoice-voided:{data['invoice_id']}", "invoice.voided", when, {
            "invoice_id": data["invoice_id"], "number": data["number"], "currency_code": data["currency_code"], "issued_at": data["issued_at"], "voided_at": when.isoformat(), "total": data["total"]})

    def payment(self, org, invoice, amount="40.00", *, reversal_of=None, payment_id=None, when=None, method="bank_transfer"):
        payment_id = payment_id or str(uuid.uuid4())
        when = when or now()
        data = {"payment_id": payment_id, "invoice_id": invoice["data"]["invoice_id"], "invoice_number": invoice["data"]["number"], "invoice_issued_at": invoice["data"]["issued_at"],
                "currency_code": invoice["data"]["currency_code"], "amount": amount, "method": method, "payment_date": when.date().isoformat()}
        if reversal_of:
            data["reverses_payment_id"] = reversal_of
            return self.add("sales", org, f"payment-reversed:{payment_id}", "payment.reversed", when, data)
        return self.add("sales", org, f"payment-recorded:{payment_id}", "payment.recorded", when, data)

    def receipt(self, org, *, lines=(("10", "2.50"),), currency="USD", when=None, number="GR-000001", receipt_id=None):
        receipt_id = receipt_id or str(uuid.uuid4())
        when = when or now()
        data = {"receipt_id": receipt_id, "receipt_number": number, "purchase_order_id": str(uuid.uuid4()), "purchase_order_number": "PO-000001", "supplier_name": "Acme Supplies",
                "currency_code": currency, "confirmed_at": when.isoformat(), "lines": [{"accepted_quantity": q, "unit_price": p} for q, p in lines]}
        return self.add("purchasing", org, f"receipt-confirmed:{receipt_id}", "receipt.confirmed", when, data)


def now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def directory():
    return Directory()


@pytest.fixture
def feeds(directory):
    return FakeFeeds(directory)


@pytest.fixture
def client(directory, feeds):
    auth, org = directory.clients()
    app.dependency_overrides[get_auth_client] = lambda: auth
    app.dependency_overrides[get_org_client] = lambda: org
    with TestClient(app) as test_client:
        app.state.feed_client = feeds  # (the lifespan made none: no MODULE_INTERNAL_API_KEY in tests)
        yield test_client
        app.state.feed_client = None
    for dependency in (get_auth_client, get_org_client):
        app.dependency_overrides.pop(dependency, None)


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class Api:
    """A tiny wrapper so tests read like the story they tell."""

    def __init__(self, client, token: str, org_id: str):
        self.client, self.headers, self.org_id = client, bearer(token), org_id
        self._keys = 0

    def key(self) -> str:
        self._keys += 1
        return f"test-key-{uuid.uuid4().hex[:12]}-{self._keys}"

    def get(self, url, **kw):
        return self.client.get(url, headers=self.headers, **kw)

    def accounts(self, **params) -> list:
        response = self.get(ACCOUNTS, params=params)
        assert response.status_code == 200, response.text
        return response.json()

    def acct(self, code: str) -> str:
        """The id of the account with this code."""
        return next(a["id"] for a in self.accounts() if a["code"] == code)

    def new_account(self, code, name="Test account", account_type="expense", **extra) -> dict:
        response = self.client.post(ACCOUNTS, json={"code": code, "name": name, "account_type": account_type, **extra}, headers=self.headers)
        assert response.status_code == 201, response.text
        return response.json()

    def entry(self, lines, *, post=False, key=None, expect=201, **extra) -> dict:
        body = {"entry_date": "2026-11-05", "description": "Test entry", "lines": [{"account_id": a, "debit": d, "credit": c} for a, d, c in lines], "post": post, **extra}
        response = self.client.post(ENTRIES, json=body, headers={**self.headers, "Idempotency-Key": key or self.key()})
        assert response.status_code == expect, response.text
        return response.json()

    def balanced(self, *, post=True, amount="100.00", currency=None, debit="1100", credit="4000", **extra) -> dict:
        if currency:
            extra["currency_code"] = currency
        return self.entry([(self.acct(debit), amount, "0"), (self.acct(credit), "0", amount)], post=post, **extra)

    def post(self, entry_id, expect=200):
        response = self.client.post(f"{ENTRIES}/{entry_id}/post", headers=self.headers)
        assert response.status_code == expect, response.text
        return response.json()

    def reverse(self, entry_id, reason="Entered in error", expect=201, **extra):
        response = self.client.post(f"{ENTRIES}/{entry_id}/reverse", json={"reason": reason, **extra}, headers=self.headers)
        assert response.status_code == expect, response.text
        return response.json()

    def expense(self, *, post=False, key=None, expect=201, account="5000", amount="25.50", **extra) -> dict:
        body = {"expense_date": "2026-11-05", "description": "Printer paper", "account_id": self.acct(account), "amount": amount, "post": post, **extra}
        response = self.client.post(EXPENSES, json=body, headers={**self.headers, "Idempotency-Key": key or self.key()})
        assert response.status_code == expect, response.text
        return response.json()

    def sync(self):
        response = self.client.post(f"{PREFIX}/sync/run", headers=self.headers)
        assert response.status_code == 200, response.text
        return response.json()

    def entries(self, **params) -> dict:
        response = self.get(ENTRIES, params=params)
        assert response.status_code == 200, response.text
        return response.json()


@pytest.fixture
def two_orgs(directory, client):
    alpha, beta = directory.add_organization("Alpha Trading"), directory.add_organization("Beta Logistics")
    directory.add_user("admin-alpha", "organization-admin", alpha)
    directory.add_user("admin-beta", "organization-admin", beta)
    return {"alpha_id": alpha, "beta_id": beta, "alpha": Api(client, "admin-alpha", alpha), "beta": Api(client, "admin-beta", beta)}


@pytest.fixture
def api(two_orgs):
    return two_orgs["alpha"]


@pytest.fixture
def run_sync(session_factory, feeds):
    """Run the worker's work for one organization (or every Finance organization) once, like a cycle of the background loop."""
    from app import sync

    def run(org=None):
        if org is None:
            return sync.run_cycle(session_factory, feeds)
        return sync.sync_organization(session_factory, feeds, uuid.UUID(str(org)))

    return run
