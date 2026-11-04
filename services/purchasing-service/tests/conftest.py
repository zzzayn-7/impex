"""Shared test fixtures.

Tests run against a real PostgreSQL database named `impex_purchasing_test`, created fresh from the Alembic migrations at the
start of the session and dropped at the end. The real `impex_purchasing` database is never touched.

The Auth, Organization and Inventory services are replaced by in-process fakes that answer the way the real ones do:
who the caller is, and which organization's products are visible, is decided by the Bearer token alone.

Run them inside Docker (so the postgres hostname and credentials are available):
    docker compose run --rm --no-deps sales-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -v"
"""
import os
import uuid
from contextlib import contextmanager
from decimal import Decimal
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
from app.inventory import get_inventory_client
from app.main import app

TEST_DB_NAME = "impex_purchasing_test"
SERVICE_DIR = Path(__file__).resolve().parent.parent
SUPPLIERS = "/api/v1/purchasing/suppliers"
ORDERS = "/api/v1/purchasing/purchase-orders"


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
    eng = create_engine(test_db_url)
    yield eng
    eng.dispose()


@pytest.fixture
def session_factory(engine):
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture(autouse=True)
def database(engine, session_factory):
    """Every test starts with empty tables and uses the test database."""
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE TABLE purchase_order_lines, purchase_order_requests, purchase_orders, purchase_order_counters, suppliers"))

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

    def add_organization(self, name: str, active: bool = True) -> str:
        org_id = str(uuid.uuid4())
        self.organizations[org_id] = {"name": name, "is_active": active}
        return org_id

    def add_user(self, token: str, role: str, organization_id=None, **overrides) -> dict:
        user = {
            "id": str(uuid.uuid4()), "email": f"{token}@example.org", "full_name": f"User {token}", "role": role,
            "organization_id": organization_id, "is_active": True, "created_at": "2026-11-05T00:00:00+00:00", **overrides,
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
        return httpx.Response(200, json={"id": user["organization_id"], "name": organization["name"], "is_active": True})

    def clients(self):
        auth = httpx.AsyncClient(transport=httpx.MockTransport(self._auth), base_url="http://auth-service:8000")
        org = httpx.AsyncClient(transport=httpx.MockTransport(self._org), base_url="http://organization-service:8001")
        return auth, org


class FakeInventory:
    """The Inventory Service as the Purchasing Service sees it. Products and warehouses belong to organizations; what a caller
    can see is decided by their token, exactly like the real service. Every request is recorded, so tests can prove that
    Purchasing only ever READS from it (no stock is ever written)."""

    def __init__(self, directory: Directory):
        self.directory = directory
        self.products = {}  # org id -> {product id -> dict}
        self.warehouses = {}  # org id -> {warehouse id -> dict}
        self.stock = {}  # (product id, warehouse id) -> Decimal
        self.mode = None  # "down" | "500" | "401" | "403"
        self.requests = []  # (method, path, token)

    # -- building the world
    def add_warehouse(self, org: str, code: str = "MAIN", active: bool = True) -> str:
        wid = str(uuid.uuid4())
        self.warehouses.setdefault(org, {})[wid] = {"id": wid, "code": code, "is_active": active}
        return wid

    def add_product(self, org: str, sku: str, name: str, unit: str = "pcs", active: bool = True) -> str:
        pid = str(uuid.uuid4())
        self.products.setdefault(org, {})[pid] = {"id": pid, "sku": sku, "name": name, "unit": unit, "is_active": active, "selling_price": "9.9900", "cost_price": "5.0000"}
        return pid

    def set_stock(self, product: str, warehouse: str, quantity) -> None:
        self.stock[(product, warehouse)] = Decimal(str(quantity))

    def snapshot(self):
        """Every quantity in the fake: used to prove that delivery-list operations leave inventory untouched."""
        return dict(self.stock)

    # -- answering requests
    def _org_of(self, request: httpx.Request):
        user = self.directory.users.get(request.headers.get("authorization", "").removeprefix("Bearer "))
        return None if user is None else str(user.get("organization_id"))

    def _stock_item(self, org: str, product: dict) -> dict:
        lines = [(w, q) for (p, w_id), q in self.stock.items() if p == product["id"] for w in [self.warehouses[org][w_id]] if q > 0]
        total = sum((q for _, q in lines), Decimal(0))
        available = sum((q for w, q in lines if w["is_active"]), Decimal(0))
        return {
            "product_id": product["id"], "sku": product["sku"], "name": product["name"], "category": "General", "unit": product["unit"],
            "unit_allows_fractions": product["unit"] in ("kg", "g", "l", "m"), "is_active": product["is_active"],
            "total_quantity": format(total, "f"), "available_quantity": format(available, "f"), "lines": [],
        }

    def handle(self, request: httpx.Request) -> httpx.Response:
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        self.requests.append((request.method, request.url.path, token))
        if self.mode == "down":
            raise httpx.ConnectError("connection refused")
        if self.mode == "500":
            return httpx.Response(500, json={"detail": "boom"})
        if self.mode == "401":
            return httpx.Response(401, json={"detail": "expired"})
        if self.mode == "403":
            return httpx.Response(403, json={"detail": "inactive"})
        org = self._org_of(request)
        if org is None:
            return httpx.Response(401, json={"detail": "Invalid or expired token"})
        path = request.url.path
        if request.method == "GET" and path == "/api/v1/inventory/stock/summary":
            ids = request.url.params.get_list("product_id")
            items = [self._stock_item(org, p) for pid, p in self.products.get(org, {}).items() if pid in ids]
            return httpx.Response(200, json={"items": items})
        if request.method == "GET" and path.startswith("/api/v1/inventory/warehouses/"):
            warehouse = self.warehouses.get(org, {}).get(path.rsplit("/", 1)[1])
            return httpx.Response(200, json=warehouse) if warehouse else httpx.Response(404, json={"detail": "Warehouse not found."})
        return httpx.Response(404, json={"detail": "not found"})

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle), base_url="http://inventory-service:8002")

    def writes(self):
        return [r for r in self.requests if r[0] != "GET"]


@pytest.fixture
def directory():
    return Directory()


@pytest.fixture
def inventory(directory):
    return FakeInventory(directory)


@pytest.fixture
def client(directory, inventory):
    auth, org = directory.clients()
    inventory_client = inventory.client()
    app.dependency_overrides[get_auth_client] = lambda: auth
    app.dependency_overrides[get_org_client] = lambda: org
    app.dependency_overrides[get_inventory_client] = lambda: inventory_client
    with TestClient(app) as test_client:
        yield test_client
    for dependency in (get_auth_client, get_org_client, get_inventory_client):
        app.dependency_overrides.pop(dependency, None)


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class Api:
    """A tiny wrapper so tests read like the story they tell."""

    def __init__(self, client, token: str, org_id: str):
        self.client, self.headers, self.org_id = client, bearer(token), org_id

    def supplier(self, name="Acme Supplies", **extra) -> dict:
        response = self.client.post(SUPPLIERS, json={"name": name, **extra}, headers=self.headers)
        assert response.status_code == 201, response.text
        return response.json()

    def order(self, supplier_id, currency="USD", key=None, **extra) -> dict:
        response = self.create_order(supplier_id, currency, key, **extra)
        assert response.status_code == 201, response.text
        return response.json()

    def create_order(self, supplier_id, currency="USD", key=None, **extra):
        headers = {**self.headers, "Idempotency-Key": key or f"key-{uuid.uuid4()}"}
        return self.client.post(ORDERS, json={"supplier_id": supplier_id, "currency_code": currency, **extra}, headers=headers)

    def add(self, order_id, product_id, quantity, price, **extra):
        return self.client.post(f"{ORDERS}/{order_id}/lines", json={"product_id": product_id, "quantity": str(quantity), "unit_price": str(price), **extra}, headers=self.headers)

    def detail(self, order_id) -> dict:
        response = self.client.get(f"{ORDERS}/{order_id}", headers=self.headers)
        assert response.status_code == 200, response.text
        return response.json()

    def action(self, order_id, action):
        return self.client.post(f"{ORDERS}/{order_id}/{action}", headers=self.headers)


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
def shop(inventory, two_orgs):
    """Alpha's inventory: a bolt (pieces) and flour (kg) with stock, one archived product, two warehouses."""
    org = two_orgs["alpha_id"]
    main, annex = inventory.add_warehouse(org, "MAIN"), inventory.add_warehouse(org, "ANNEX", active=False)
    bolt, flour = inventory.add_product(org, "BOLT-1", "Steel bolt", "pcs"), inventory.add_product(org, "FLOUR", "Flour", "kg")
    old = inventory.add_product(org, "OLD-1", "Old widget", "pcs", active=False)
    inventory.set_stock(bolt, main, 40)
    inventory.set_stock(flour, main, "2.5")
    return {"bolt": bolt, "flour": flour, "old": old, "main": main, "annex": annex, "org": org}
