"""Shared test fixtures.

Tests run against a real PostgreSQL database named `impex_inventory_test`, created fresh from the Alembic
migrations at the start of the session and dropped at the end. The real `impex_inventory` database is never touched.

Run them inside Docker (so the postgres hostname and credentials are available):
    docker compose run --rm --no-deps inventory-service sh -c \
        "pip install -q -r requirements-dev.txt && python -m pytest -v"
"""
import os
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

TEST_DB_NAME = "impex_inventory_test"
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
    """Every test starts with empty inventory tables and uses the test database. (TRUNCATE does not fire the
    append-only row trigger, which is why it can reset the ledger here without the maintenance flag.)"""
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE TABLE product_identifiers, stock_movements, stock_balances, stock_operations, warehouses, products"))

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield
    app.dependency_overrides.pop(get_db, None)


# --- stand-ins for the Auth Service and the Organization Service ---------------------------------
class Directory:
    """Answers GET /api/v1/auth/me and GET /api/v1/tenant/organization like the real services do:
    the user and the organization are decided by the Bearer token alone."""

    def __init__(self):
        self.users = {}  # token -> user record, as the Auth Service returns it
        self.organizations = {}  # organization id -> {"name": ..., "is_active": ...}
        self.auth_mode = None  # "down" | "500"
        self.org_mode = None
        self.org_calls = []

    def add_organization(self, name: str, active: bool = True, modules=None) -> str:
        org_id = str(uuid.uuid4())
        # `modules` is what the Organization Service reports as usable for the organization (default: everything this release can use)
        self.organizations[org_id] = {"name": name, "is_active": active, "setup_status": "completed", "modules": list(modules) if modules is not None else ["inventory", "purchasing", "sales"]}
        return org_id

    def add_user(self, token: str, role: str, organization_id=None, **overrides) -> dict:
        user = {
            "id": str(uuid.uuid4()), "email": f"{token}@example.org", "full_name": f"User {token}", "role": role,
            "organization_id": organization_id, "is_active": True, "profile_setup_completed_at": "2026-11-04T00:05:00+00:00", "created_at": "2026-11-04T00:00:00+00:00", **overrides,
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
        self.org_calls.append(dict(request.headers))
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
        body = {"id": user["organization_id"], "name": organization["name"], "is_active": True}
        if self.org_mode != "no-setup-status":  # an old/broken Organization Service that does not say whether setup is complete
            body["setup_status"] = organization.get("setup_status", "completed")
        if self.org_mode != "no-modules":  # "no-modules": an old/broken Organization Service that does not say which modules are enabled
            body["modules"] = organization["modules"] if self.org_mode != "garbled-modules" else "all"
        return httpx.Response(200, json=body)

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
    app.dependency_overrides.pop(get_auth_client, None)
    app.dependency_overrides.pop(get_org_client, None)


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# --- helpers for the warehouse / stock tests -----------------------------------------------------------
PRODUCTS_URL = "/api/v1/inventory/products"
WAREHOUSES_URL = "/api/v1/inventory/warehouses"
STOCK_URL = "/api/v1/inventory/stock"


def product_payload(**overrides) -> dict:
    return {"sku": "SKU-1", "name": "Thing", "category": "General", "unit": "pcs", "cost_price": "1.00",
            "selling_price": "2.00", "currency_code": "USD", **overrides}


class Api:
    """A tiny wrapper so stock tests read like the story they tell."""

    def __init__(self, client, token: str):
        self.client, self.headers = client, bearer(token)

    def product(self, **overrides) -> dict:
        response = self.client.post(PRODUCTS_URL, json=product_payload(**overrides), headers=self.headers)
        assert response.status_code == 201, response.text
        return response.json()

    def warehouse(self, code="MAIN", name=None, **extra) -> dict:
        response = self.client.post(WAREHOUSES_URL, json={"code": code, "name": name or f"{code} warehouse", **extra}, headers=self.headers)
        assert response.status_code == 201, response.text
        return response.json()

    def change(self, action, key=None, **body):
        """POST /stock/<action> with a fresh Idempotency-Key unless one is given."""
        headers = {**self.headers, "Idempotency-Key": key or f"key-{uuid.uuid4()}"}
        return self.client.post(f"{STOCK_URL}/{action}", json=body, headers=headers)

    def add(self, product, warehouse, quantity, action="in", **extra):
        response = self.change(action, product_id=product["id"], warehouse_id=warehouse["id"], quantity=str(quantity), **extra)
        assert response.status_code == 201, response.text
        return response.json()

    def transfer(self, product, source, destination, quantity, key=None, **extra):
        return self.change("transfer", key=key, product_id=product["id"], from_warehouse_id=source["id"],
                           to_warehouse_id=destination["id"], quantity=str(quantity), **extra)

    def quantity(self, product, warehouse) -> str:
        """The balance of one product in one warehouse as the overview shows it ("0" when there is none)."""
        body = self.client.get(STOCK_URL, params={"q": product["sku"], "status": "all"}, headers=self.headers).json()
        (item,) = [i for i in body["items"] if i["product_id"] == product["id"]]
        return next((line["quantity"] for line in item["lines"] if line["warehouse_id"] == warehouse["id"]), "0")

    def movements(self, **params) -> dict:
        return self.client.get(f"{STOCK_URL}/movements", params=params, headers=self.headers).json()


@pytest.fixture
def two_orgs(directory, client):
    """Alpha and Beta, each with an administrator and an Api wrapper."""
    alpha, beta = directory.add_organization("Alpha Trading"), directory.add_organization("Beta Logistics")
    directory.add_user("admin-alpha", "organization-admin", alpha)
    directory.add_user("admin-beta", "organization-admin", beta)
    return {"alpha_id": alpha, "beta_id": beta, "alpha": Api(client, "admin-alpha"), "beta": Api(client, "admin-beta")}


@pytest.fixture
def api(two_orgs):
    return two_orgs["alpha"]
