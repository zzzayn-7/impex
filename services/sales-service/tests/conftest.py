"""Shared test fixtures.

Tests run against a real PostgreSQL database named `impex_sales_test`, created fresh from the Alembic migrations at the
start of the session and dropped at the end. The real `impex_sales` database is never touched.

The Auth, Organization and Inventory services are replaced by in-process fakes that answer the way the real ones do:
who the caller is, and which organization's products are visible, is decided by the Bearer token alone.

Run them inside Docker (so the postgres hostname and credentials are available):
    docker compose run --rm --no-deps sales-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -v"
"""
import json
import os
import threading
import uuid
from collections import defaultdict
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

os.environ.setdefault("RESERVATION_API_KEY", "test-reservation-key")  # the shared secret the fake Inventory Service requires on reservation writes
TEST_DB_NAME = "impex_sales_test"
SERVICE_DIR = Path(__file__).resolve().parent.parent
CLIENTS = "/api/v1/sales/clients"
LISTS = "/api/v1/sales/delivery-lists"
DISPATCHES = "/api/v1/sales/dispatches"
INVOICES = "/api/v1/sales/invoices"


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
        conn.execute(text("TRUNCATE TABLE sales_order_requests, sales_orders, sales_order_counters, invoice_payments, invoice_allocations, invoice_lines, invoice_requests, invoices, invoice_counters, dispatch_lines, dispatch_requests, dispatches, dispatch_counters, delivery_list_items, delivery_lists, delivery_list_counters, clients"))

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

    def add_organization(self, name: str, active: bool = True, modules=None) -> str:
        org_id = str(uuid.uuid4())
        # `modules` is what the Organization Service reports as usable for the organization (default: everything this release can use)
        self.organizations[org_id] = {"name": name, "is_active": active, "setup_status": "completed", "modules": list(modules) if modules is not None else ["inventory", "purchasing", "sales"]}
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


class FakeInventory:
    """The Inventory Service as the Sales Service sees it. Products belong to organizations; what a caller
    can see is decided by their token, exactly like the real service. Every request is recorded, so tests can prove that
    Sales only ever READS from it (no stock is ever written)."""

    def __init__(self, directory: Directory):
        self.directory = directory
        self.products = {}  # org id -> {product id -> dict}
        self.stock = {}  # product id -> Decimal
        self.mode = None  # "down" | "500" | "401" | "403"
        self.requests = []  # (method, path, token)
        # --- dispatch postings (the one write Sales makes), like the real Inventory Service: atomic, idempotent by key, one ledger
        # movement per line, stock never negative, a source line posted at most once. Failures can be injected, one per POST, in order:
        #   "timeout_before"  the request never reaches the service        "timeout_after"  it is applied but the answer is lost
        #   "500_before"      the service fails before doing anything        "500_after"      it is applied, then answers 500
        #   "reject"          a definitive 409 (nothing applied)             "wrong_answer"   applied, but the answer names other goods
        self.post_modes = []
        self.lookup_mode = None  # "500": the by-key lookup itself fails
        self.operations = {}  # (org, idempotency key) -> the posting result
        self.ledger = []  # every movement ever made by a posting
        self.posted_lines = set()
        self.post_calls = 0
        # --- reservations (stock booked for sales orders), like the real service: totals not deltas, all lines or none, idempotent by key.
        # Failures can be injected, one per reservation POST, in order: "timeout_before", "timeout_after", "500_before", "500_after".
        self.res_modes = []
        self.reservations = {}  # (org, order line id) -> {"org", "product", "source_id", "number", "original", "consumed", "released", "remaining"}
        self.res_ops = {}  # (org, idempotency key) -> result
        self.res_calls = 0
        self.res_lookup_mode = None
        self._res_lock = threading.RLock()  # the real service books under a row lock: one booking at a time

    # -- building the world
    def add_product(self, org: str, sku: str, name: str, unit: str = "pcs", active: bool = True) -> str:
        pid = str(uuid.uuid4())
        self.products.setdefault(org, {})[pid] = {"id": pid, "sku": sku, "name": name, "unit": unit, "is_active": active}
        return pid

    def set_stock(self, product: str, quantity) -> None:
        self.stock[product] = Decimal(str(quantity))

    def snapshot(self):
        """Every quantity in the fake: used to prove that delivery-list operations leave inventory untouched."""
        return dict(self.stock)

    # -- answering requests
    def _org_of(self, request: httpx.Request):
        user = self.directory.users.get(request.headers.get("authorization", "").removeprefix("Bearer "))
        return None if user is None else str(user.get("organization_id"))

    def reserved(self, product: str) -> Decimal:
        return sum((r["remaining"] for r in self.reservations.values() if r["product"] == product), Decimal(0))

    def available(self, product: str) -> Decimal:
        return self.stock.get(product, Decimal(0)) - self.reserved(product)

    def reserved_for(self, line_id: str) -> Decimal:
        return sum((r["remaining"] for (org, lid), r in self.reservations.items() if lid == line_id), Decimal(0))

    def _stock_item(self, org: str, product: dict) -> dict:
        total = max(self.stock.get(product["id"], Decimal(0)), Decimal(0))
        reserved = self.reserved(product["id"])
        return {
            "product_id": product["id"], "sku": product["sku"], "name": product["name"], "category": "General", "unit": product["unit"],
            "unit_allows_fractions": product["unit"] in ("kg", "g", "l", "m"), "is_active": product["is_active"],
            "total_quantity": format(total, "f") if total > 0 else "0",
            "reserved_quantity": format(reserved, "f") if reserved > 0 else "0",
            "available_quantity": format(total - reserved, "f") if total - reserved > 0 else "0",
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
        if request.method == "POST" and path == "/api/v1/inventory/dispatches":
            return self._post_dispatch(org, request)
        if request.method == "POST" and path in ("/api/v1/inventory/reservations", "/api/v1/inventory/reservations/release"):
            return self._reserve(org, request, release=path.endswith("/release"))
        if request.method == "GET" and path.startswith("/api/v1/inventory/reservations/by-key/"):
            if self.res_lookup_mode == "500":
                return httpx.Response(500, json={"detail": "boom"})
            found = self.res_ops.get((org, path.rsplit("/", 1)[1]))
            if found is None:
                return httpx.Response(404, json={"detail": "No reservation was made with this key."})
            return httpx.Response(200, json={**found, "replayed": True})
        if request.method == "GET" and path.startswith("/api/v1/inventory/dispatches/by-key/"):
            if self.lookup_mode == "500":
                return httpx.Response(500, json={"detail": "boom"})
            found = self.operations.get((org, path.rsplit("/", 1)[1]))
            if found is None:
                return httpx.Response(404, json={"detail": "No dispatch was posted with this key."})
            return httpx.Response(200, json={**found, "replayed": True})
        return httpx.Response(404, json={"detail": "not found"})

    def _post_dispatch(self, org: str, request: httpx.Request) -> httpx.Response:
        self.post_calls += 1
        mode = self.post_modes.pop(0) if self.post_modes else None
        if mode == "timeout_before":
            raise httpx.ReadTimeout("no answer")
        if mode == "500_before":
            return httpx.Response(500, json={"detail": "boom"})
        if mode == "reject":
            return httpx.Response(409, json={"detail": "Steel bolt is archived. Restore it before changing its stock."})
        key, body = request.headers.get("idempotency-key", ""), json.loads(request.content)
        previous = self.operations.get((org, key))
        if previous is not None:
            result, status_code = {**previous, "replayed": True}, 200
        else:
            problem = self._validate_posting(org, body)
            if problem:
                return httpx.Response(problem[0], json={"detail": problem[1]})
            movements = []
            for line in body["lines"]:
                quantity = Decimal(line["quantity"])
                if line.get("order_line_id"):
                    reservation = self.reservations[(org, line["order_line_id"])]
                    reservation["consumed"] += quantity
                    reservation["remaining"] -= quantity
                balance = self.stock.get(line["product_id"], Decimal(0)) - quantity
                self.stock[line["product_id"]] = balance
                movement = {"id": str(uuid.uuid4()), "line_id": line["line_id"], "product_id": line["product_id"],
                            "quantity": format(quantity, "f"), "balance_after": format(balance, "f")}
                movements.append(movement)
                self.ledger.append({**movement, "source_reference": body["dispatch_number"], "org": org})
                self.posted_lines.add((org, line["line_id"]))
            result = {"operation_id": str(uuid.uuid4()), "dispatch_number": body["dispatch_number"], "replayed": False, "movements": movements}
            self.operations[(org, key)] = result
            status_code = 201
        if mode == "timeout_after":
            raise httpx.ReadTimeout("the answer was lost")
        if mode == "500_after":
            return httpx.Response(500, json={"detail": "boom"})
        if mode == "wrong_answer":
            result = {**result, "movements": [{**result["movements"][0], "quantity": "9999.0000"}, *result["movements"][1:]]}
        return httpx.Response(status_code, json=result)

    def _validate_posting(self, org: str, body: dict):
        """(status, message) if the real service would refuse the whole posting, else None. Nothing is applied before this passes."""
        needed, consumed_by_product = {}, defaultdict(Decimal)
        for line in body["lines"]:
            product = self.products.get(org, {}).get(line["product_id"])
            if product is None:
                return 404, "Product not found."
            if line.get("order_line_id"):
                reservation = self.reservations.get((org, line["order_line_id"]))
                if reservation is None or reservation["product"] != line["product_id"] or reservation["remaining"] <= 0:
                    return 409, {"code": "no_reservation", "message": "No stock is reserved for this order line."}
                if Decimal(line["quantity"]) > reservation["remaining"]:
                    return 409, {"code": "exceeds_reservation", "message": "More than is reserved for this order line."}
                consumed_by_product[line["product_id"]] += Decimal(line["quantity"])
            if "warehouse_id" in line:
                return 422, "Extra inputs are not permitted"  # the real service no longer knows warehouses
            if not product["is_active"]:
                return 409, "archived"
            if product["unit"] != line["unit"]:
                return 409, "A quantity is never converted"
            if product["unit"] not in ("kg", "g", "l", "m") and Decimal(line["quantity"]) != Decimal(line["quantity"]).to_integral_value():
                return 422, "Quantity must be a whole number"
            if (org, line["line_id"]) in self.posted_lines:
                return 409, "One of these dispatch lines was already deducted from stock by an earlier posting."
            needed[line["product_id"]] = needed.get(line["product_id"], Decimal(0)) + Decimal(line["quantity"])
        for product_id, quantity in needed.items():
            free = self.stock.get(product_id, Decimal(0)) - (self.reserved(product_id) - consumed_by_product[product_id])
            if free < quantity:
                return 409, "Insufficient stock: not enough of the product."
        return None

    # -- reservations
    def _reserve(self, org: str, request: httpx.Request, release: bool) -> httpx.Response:
        with self._res_lock:
            return self._reserve_locked(org, request, release)

    def _reserve_locked(self, org: str, request: httpx.Request, release: bool) -> httpx.Response:
        self.res_calls += 1
        mode = self.res_modes.pop(0) if self.res_modes else None
        if mode == "timeout_before":
            raise httpx.ReadTimeout("no answer")
        if mode == "500_before":
            return httpx.Response(500, json={"detail": "boom"})
        key, body = request.headers.get("idempotency-key", ""), json.loads(request.content)
        if release and set(body) != {"source_id", "source_reference"}:  # the real service forbids extra fields on a release
            return httpx.Response(422, json={"detail": [{"loc": ["body"], "msg": "Extra inputs are not permitted"}]})
        if not request.headers.get("x-internal-key"):
            return httpx.Response(403, json={"detail": "Only the Sales Service can change reservations."})
        previous = self.res_ops.get((org, key))
        if previous is not None:
            result, code = {**previous, "replayed": True}, 200
        else:
            outcome = self._apply_reservation(org, body, release)
            if isinstance(outcome, httpx.Response):
                return outcome
            result = {"operation_id": str(uuid.uuid4()), "kind": "release" if release else "reserve", "source_id": body["source_id"], "source_reference": body["source_reference"], "replayed": False, "lines": outcome}
            self.res_ops[(org, key)] = result
            code = 201
        if mode == "timeout_after":
            raise httpx.ReadTimeout("the answer was lost")
        if mode == "500_after":
            return httpx.Response(500, json={"detail": "boom"})
        return httpx.Response(code, json=result)

    def _apply_reservation(self, org: str, body: dict, release: bool):
        source = body["source_id"]
        wanted = {} if release else {l["line_id"]: l for l in body["lines"]}
        mine = {k: dict(v) for k, v in self.reservations.items() if k[0] == org and v["source_id"] == source}
        free = {}

        def free_of(product):
            if product not in free:
                free[product] = self.stock.get(product, Decimal(0)) - self.reserved(product)
            return free[product]

        for (_, line_id), r in mine.items():
            target = wanted.get(line_id)
            desired = Decimal(0) if target is None else Decimal(target["quantity"]) - r["consumed"]
            if target is not None and desired < 0:
                return httpx.Response(409, json={"detail": {"code": "below_dispatched", "message": "Already dispatched."}})
            if desired < r["remaining"]:
                give = r["remaining"] - desired
                r["released"] += give
                r["remaining"] -= give
                free[r["product"]] = free_of(r["product"]) + give
        shortages = []
        for line_id, line in wanted.items():
            product = self.products.get(org, {}).get(line["product_id"])
            if product is None:
                return httpx.Response(404, json={"detail": "Product not found."})
            r = mine.get((org, line_id))
            consumed = r["consumed"] if r else Decimal(0)
            own = r["remaining"] if r else Decimal(0)
            more = Decimal(line["quantity"]) - consumed - own
            if more <= 0:
                continue
            if not product["is_active"]:
                return httpx.Response(409, json={"detail": "archived"})
            if product["unit"] != line["unit"]:
                return httpx.Response(409, json={"detail": "A quantity is never converted"})
            if product["unit"] not in ("kg", "g", "l", "m") and Decimal(line["quantity"]) != Decimal(line["quantity"]).to_integral_value():
                return httpx.Response(422, json={"detail": "Quantity must be a whole number"})
            available = free_of(line["product_id"])
            if available < more:
                reserved_elsewhere = self.reserved(line["product_id"]) - sum((v["remaining"] for k, v in self.reservations.items() if k[0] == org and v["source_id"] == source and v["product"] == line["product_id"]), Decimal(0))
                shortages.append({"product_id": line["product_id"], "name": product["name"], "unit": product["unit"], "requested": line["quantity"],
                                  "available": format(max(available + own, Decimal(0)), "f"), "free": format(max(available, Decimal(0)), "f"),
                                  "on_hand": format(self.stock.get(line["product_id"], Decimal(0)), "f"), "reserved_elsewhere": format(max(reserved_elsewhere, Decimal(0)), "f")})
                continue
            free[line["product_id"]] = available - more
            if r is None:
                mine[(org, line_id)] = {"org": org, "product": line["product_id"], "source_id": source, "number": body["source_reference"],
                                        "original": more, "consumed": Decimal(0), "released": Decimal(0), "remaining": more}
            else:
                r["original"] += more
                r["remaining"] += more
        if shortages:
            message = " ".join(f"Only {s['available']} {s['unit']} of {s['name']} available." for s in shortages)
            return httpx.Response(409, json={"detail": {"code": "insufficient_available", "message": message, "shortages": shortages}})
        self.reservations.update(mine)
        return [
            {"line_id": line_id, "product_id": r["product"], "original_quantity": format(r["original"], "f"), "consumed_quantity": format(r["consumed"], "f"),
             "released_quantity": format(r["released"], "f"), "remaining_quantity": format(r["remaining"], "f"),
             "status": "active" if r["remaining"] > 0 else ("fulfilled" if r["consumed"] > 0 else "released")}
            for (_, line_id), r in mine.items()
        ]

    def reservation_posts(self):
        return [r for r in self.requests if r[0] == "POST" and r[1].startswith("/api/v1/inventory/reservations")]

    def quantity(self, product: str) -> Decimal:
        return self.stock.get(product, Decimal(0))

    def postings(self):
        """The dispatch POSTs made to the (fake) Inventory Service."""
        return [r for r in self.requests if r[0] == "POST" and r[1] == "/api/v1/inventory/dispatches"]

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle), base_url="http://inventory-service:8002")

    def writes(self):
        return [r for r in self.requests if r[0] != "GET"]

    def deduction_writes(self):
        """Every write that is NOT a reservation request: the only way stock is ever deducted (a dispatch posting)."""
        return [r for r in self.requests if r[0] != "GET" and not r[1].startswith("/api/v1/inventory/reservations")]


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

    def new_client(self, name="Acme Ltd", **extra) -> dict:
        response = self.client.post(CLIENTS, json={"name": name, **extra}, headers=self.headers)
        assert response.status_code == 201, response.text
        return response.json()

    def new_list(self, client_id, **extra) -> dict:
        response = self.client.post(LISTS, json={"client_id": client_id, **extra}, headers=self.headers)
        assert response.status_code == 201, response.text
        return response.json()

    def add(self, list_id, product_id, quantity, **extra):
        return self.client.post(f"{LISTS}/{list_id}/items", json={"product_id": product_id, "quantity": str(quantity), **extra}, headers=self.headers)

    def detail(self, list_id) -> dict:
        response = self.client.get(f"{LISTS}/{list_id}", headers=self.headers)
        assert response.status_code == 200, response.text
        return response.json()

    def status(self, list_id, action):
        return self.client.post(f"{LISTS}/{list_id}/{action}", headers=self.headers)

    # -- dispatches
    def ready_list(self, shop, items=(("bolt", 15), ("flour", 2)), client_name="Acme Ltd") -> dict:
        """A Ready delivery list with these items (product key in `shop`, quantity)."""
        created = self.new_list(self.new_client(client_name)["id"])
        for product, quantity in items:
            response = self.add(created["id"], shop[product], quantity)
            assert response.status_code == 201, response.text
        marked = self.status(created["id"], "ready")
        assert marked.status_code == 200, marked.text
        return marked.json()

    def dispatch_request(self, list_id, lines=(), key=None, **extra):
        headers = {**self.headers, "Idempotency-Key": key or f"key-{uuid.uuid4()}"}
        return self.client.post(DISPATCHES, json={"delivery_list_id": list_id, "lines": list(lines), **extra}, headers=headers)

    def draft(self, list_id, lines=(), **extra) -> dict:
        response = self.dispatch_request(list_id, lines, **extra)
        assert response.status_code == 201, response.text
        return response.json()

    def put_lines(self, dispatch_id, lines):
        return self.client.put(f"{DISPATCHES}/{dispatch_id}/lines", json={"lines": list(lines)}, headers=self.headers)

    def confirm(self, dispatch_id):
        return self.client.post(f"{DISPATCHES}/{dispatch_id}/confirm", headers=self.headers)

    def cancel_dispatch(self, dispatch_id):
        return self.client.post(f"{DISPATCHES}/{dispatch_id}/cancel", headers=self.headers)

    # -- invoices and payments
    def confirmed_dispatch(self, shop, delivery_list, lines) -> dict:
        """A CONFIRMED dispatch of these (product key, quantity) lines of a Ready / Partially Dispatched list."""
        body = [sent(delivery_list, shop[product], quantity) for product, quantity in lines]
        draft = self.draft(delivery_list["id"], body)
        confirmed = self.confirm(draft["id"])
        assert confirmed.status_code == 200, confirmed.text
        return confirmed.json()

    def invoice_request(self, client_id, lines=(), currency="USD", key=None, **extra):
        headers = {**self.headers, "Idempotency-Key": key or f"key-{uuid.uuid4()}"}
        return self.client.post(INVOICES, json={"client_id": client_id, "currency_code": currency, "lines": list(lines), **extra}, headers=headers)

    def draft_invoice(self, client_id, lines=(), currency="USD", **extra) -> dict:
        response = self.invoice_request(client_id, lines, currency, **extra)
        assert response.status_code == 201, response.text
        return response.json()

    def issued_invoice(self, client_id, lines, currency="USD", **extra) -> dict:
        made = self.draft_invoice(client_id, lines, currency, **extra)
        issued = self.issue(made["id"])
        assert issued.status_code == 200, issued.text
        return issued.json()

    def issue(self, invoice_id):
        return self.client.post(f"{INVOICES}/{invoice_id}/issue", headers=self.headers)

    def void(self, invoice_id, reason="entered in error"):
        return self.client.post(f"{INVOICES}/{invoice_id}/void", json={"reason": reason}, headers=self.headers)

    def pay(self, invoice_id, amount, key=None, method="bank_transfer", **extra):
        headers = {**self.headers, "Idempotency-Key": key or f"pay-{uuid.uuid4()}"}
        return self.client.post(f"{INVOICES}/{invoice_id}/payments", json={"amount": str(amount), "method": method, **extra}, headers=headers)

    def reverse(self, invoice_id, payment_id, reason="paid twice", key=None):
        headers = {**self.headers, "Idempotency-Key": key or f"rev-{uuid.uuid4()}"}
        return self.client.post(f"{INVOICES}/{invoice_id}/payments/{payment_id}/reverse", json={"reason": reason}, headers=headers)

    def get_invoice(self, invoice_id) -> dict:
        response = self.client.get(f"{INVOICES}/{invoice_id}", headers=self.headers)
        assert response.status_code == 200, response.text
        return response.json()

    def get_dispatch(self, dispatch_id) -> dict:
        response = self.client.get(f"{DISPATCHES}/{dispatch_id}", headers=self.headers)
        assert response.status_code == 200, response.text
        return response.json()


def bill(dispatch, product_id, quantity, price, **extra) -> dict:
    """An invoice line body for the dispatch line of this product (price, discount and tax exactly as an administrator would type them)."""
    line = next(l for l in dispatch["lines"] if l["product_id"] == product_id)
    return {"dispatch_line_id": line["id"], "quantity": str(quantity), "unit_price": str(price), **extra}


def item_of(delivery_list, product_id) -> dict:
    return next(i for i in delivery_list["items"] if i["product_id"] == product_id)


def sent(delivery_list, product_id, quantity) -> dict:
    """A dispatch line body for the list's item of this product."""
    return {"delivery_list_item_id": item_of(delivery_list, product_id)["id"], "quantity": str(quantity)}


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
    """Alpha's inventory: a bolt (pieces, 50 in stock) and flour (kg, 2.5 in stock), and one archived product."""
    org = two_orgs["alpha_id"]
    bolt, flour = inventory.add_product(org, "BOLT-1", "Steel bolt", "pcs"), inventory.add_product(org, "FLOUR", "Flour", "kg")
    old = inventory.add_product(org, "OLD-1", "Old widget", "pcs", active=False)
    inventory.set_stock(bolt, 50)
    inventory.set_stock(flour, "2.5")
    return {"bolt": bolt, "flour": flour, "old": old, "org": org}
