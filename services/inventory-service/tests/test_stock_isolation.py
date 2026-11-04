"""Two organizations, one administrator each: warehouses, balances and movements never cross the boundary.

Also: who may use the stock endpoints at all, and what happens when the organization is inactive.
"""
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.models import StockBalance, StockMovement, StockOperation, Warehouse

from conftest import STOCK_URL, WAREHOUSES_URL, bearer


@pytest.fixture
def world(two_orgs):
    """Each organization has a product, two warehouses and some history. The names differ so leaks are visible."""
    data = {}
    for who in ("alpha", "beta"):
        org = two_orgs[who]
        product = org.product(sku=f"{who.upper()}-BOLT", name=f"{who} bolt", unit="pcs")
        main, annex = org.warehouse("MAIN", f"{who} main"), org.warehouse("ANNEX", f"{who} annex")
        org.add(product, main, 10)
        org.transfer(product, main, annex, 4)
        data[who] = {"product": product, "main": main, "annex": annex}
    return data


def snapshot(session_factory):
    with session_factory() as db:
        return {
            "warehouses": sorted((w.id, w.code, w.name, w.address, w.is_active, w.organization_id) for w in db.scalars(select(Warehouse))),
            "balances": sorted((b.product_id, b.warehouse_id, b.quantity, b.organization_id) for b in db.scalars(select(StockBalance))),
            "movements": sorted((m.id, m.quantity, m.balance_after, m.reason, m.organization_id) for m in db.scalars(select(StockMovement))),
            "operations": sorted((o.id, o.idempotency_key, o.organization_id) for o in db.scalars(select(StockOperation))),
        }


# --- reading -----------------------------------------------------------------------------------------
def test_each_administrator_sees_only_their_own_warehouses(two_orgs, world):
    for who, other in (("alpha", "beta"), ("beta", "alpha")):
        response = two_orgs[who].client.get(WAREHOUSES_URL, params={"status": "all"}, headers=two_orgs[who].headers)
        assert {w["id"] for w in response.json()["items"]} == {world[who]["main"]["id"], world[who]["annex"]["id"]}
        assert other not in response.text.lower()


def test_each_administrator_sees_only_their_own_balances(two_orgs, world):
    for who, other in (("alpha", "beta"), ("beta", "alpha")):
        response = two_orgs[who].client.get(STOCK_URL, params={"status": "all"}, headers=two_orgs[who].headers)
        body = response.json()
        assert body["total"] == 1 and body["items"][0]["product_id"] == world[who]["product"]["id"]
        assert {line["warehouse_id"] for line in body["items"][0]["lines"]} == {world[who]["main"]["id"], world[who]["annex"]["id"]}
        assert body["items"][0]["total_quantity"] == "10.0000"
        assert other not in response.text.lower()


def test_each_administrator_sees_only_their_own_movements(two_orgs, world):
    for who, other in (("alpha", "beta"), ("beta", "alpha")):
        body_text = two_orgs[who].client.get(f"{STOCK_URL}/movements", headers=two_orgs[who].headers).text
        assert two_orgs[who].movements()["total"] == 3  # in, transfer_out, transfer_in
        assert other not in body_text.lower()


def test_filtering_by_the_other_tenants_ids_finds_nothing(two_orgs, world):
    alpha = two_orgs["alpha"]
    theirs = world["beta"]
    assert alpha.movements(product_id=theirs["product"]["id"])["total"] == 0
    assert alpha.movements(warehouse_id=theirs["main"]["id"])["total"] == 0
    overview = alpha.client.get(STOCK_URL, params={"warehouse_id": theirs["main"]["id"]}, headers=alpha.headers).json()
    assert overview["total"] == 0 and overview["items"] == []
    assert alpha.client.get(STOCK_URL, params={"q": "beta"}, headers=alpha.headers).json()["total"] == 0
    assert alpha.client.get(WAREHOUSES_URL, params={"q": "beta"}, headers=alpha.headers).json()["total"] == 0


def test_another_tenants_warehouse_is_indistinguishable_from_a_missing_one(two_orgs, world):
    alpha = two_orgs["alpha"]
    foreign = alpha.client.get(f"{WAREHOUSES_URL}/{world['beta']['main']['id']}", headers=alpha.headers)
    missing = alpha.client.get(f"{WAREHOUSES_URL}/{uuid.uuid4()}", headers=alpha.headers)
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json() == {"detail": "Warehouse not found."}
    assert "beta" not in foreign.text.lower()


# --- changing ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("attacker,victim", [("alpha", "beta"), ("beta", "alpha")])
def test_neither_administrator_can_change_the_others_warehouses(two_orgs, world, session_factory, attacker, victim):
    before = snapshot(session_factory)
    org, target = two_orgs[attacker], world[victim]["main"]["id"]
    url = f"{WAREHOUSES_URL}/{target}"
    assert org.client.patch(url, json={"name": "HIJACKED", "code": "EVIL"}, headers=org.headers).status_code == 404
    assert org.client.post(f"{url}/archive", headers=org.headers).status_code == 404
    assert org.client.post(f"{url}/restore", headers=org.headers).status_code == 404
    assert org.client.delete(url, headers=org.headers).status_code == 405
    assert snapshot(session_factory) == before


@pytest.mark.parametrize("attacker,victim", [("alpha", "beta"), ("beta", "alpha")])
def test_stock_cannot_be_changed_in_the_others_warehouse_or_for_the_others_product(two_orgs, world, session_factory, attacker, victim):
    before = snapshot(session_factory)
    org, mine, theirs = two_orgs[attacker], world[attacker], world[victim]
    attempts = [
        ("in", dict(product_id=mine["product"]["id"], warehouse_id=theirs["main"]["id"], quantity="5")),  # my product, their warehouse
        ("in", dict(product_id=theirs["product"]["id"], warehouse_id=mine["main"]["id"], quantity="5")),  # their product, my warehouse
        ("in", dict(product_id=theirs["product"]["id"], warehouse_id=theirs["main"]["id"], quantity="5")),  # all theirs
        ("out", dict(product_id=theirs["product"]["id"], warehouse_id=theirs["main"]["id"], quantity="1")),  # steal their stock
        ("opening", dict(product_id=mine["product"]["id"], warehouse_id=theirs["annex"]["id"], quantity="5")),
    ]
    for action, body in attempts:
        response = org.change(action, **body)
        assert response.status_code == 404, (action, body)
        assert response.json()["detail"] in ("Product not found.", "Warehouse not found.")
    transfers = [
        org.transfer(theirs["product"], theirs["main"], theirs["annex"], 1),  # all theirs
        org.transfer(mine["product"], mine["main"], theirs["annex"], 1),  # push my stock into their warehouse
        org.transfer(mine["product"], theirs["main"], mine["annex"], 1),  # pull their stock into mine
        org.transfer(theirs["product"], mine["main"], mine["annex"], 1),  # my warehouses, their product
    ]
    assert [t.status_code for t in transfers] == [404, 404, 404, 404]
    assert snapshot(session_factory) == before  # not a balance, movement or idempotency record changed


def test_a_foreign_object_error_is_identical_to_a_missing_one(two_orgs, world):
    alpha, mine, theirs = two_orgs["alpha"], world["alpha"], world["beta"]
    foreign = alpha.change("in", product_id=mine["product"]["id"], warehouse_id=theirs["main"]["id"], quantity="1")
    missing = alpha.change("in", product_id=mine["product"]["id"], warehouse_id=str(uuid.uuid4()), quantity="1")
    assert foreign.status_code == missing.status_code == 404 and foreign.json() == missing.json()


def test_an_idempotency_key_cannot_replay_another_tenants_result(two_orgs, world):
    beta_first = two_orgs["beta"].change(
        "in", key="shared-key-9999", product_id=world["beta"]["product"]["id"], warehouse_id=world["beta"]["main"]["id"], quantity="1")
    assert beta_first.status_code == 201
    alpha = two_orgs["alpha"]
    alpha_same_key = alpha.change(
        "in", key="shared-key-9999", product_id=world["alpha"]["product"]["id"], warehouse_id=world["alpha"]["main"]["id"], quantity="1")
    assert alpha_same_key.status_code == 201 and alpha_same_key.json()["replayed"] is False  # a fresh operation, not Beta's
    assert alpha_same_key.json()["operation_id"] != beta_first.json()["operation_id"]
    assert "beta" not in alpha_same_key.text.lower()


# --- the organization can never be chosen by the caller -------------------------------------------------
@pytest.mark.parametrize("field", ["organization_id", "organizationId", "tenant_id", "org_id"])
def test_an_organization_id_in_any_body_is_rejected(two_orgs, world, session_factory, field):
    before = snapshot(session_factory)
    alpha, beta_id, mine = two_orgs["alpha"], two_orgs["beta_id"], world["alpha"]
    assert alpha.client.post(WAREHOUSES_URL, json={"code": "EVIL", "name": "Evil", field: beta_id}, headers=alpha.headers).status_code == 422
    assert alpha.client.patch(f"{WAREHOUSES_URL}/{mine['main']['id']}", json={field: beta_id}, headers=alpha.headers).status_code == 422
    for action in ("in", "out", "opening"):
        response = alpha.change(action, product_id=mine["product"]["id"], warehouse_id=mine["main"]["id"], quantity="1", **{field: beta_id})
        assert response.status_code == 422
    response = alpha.transfer(mine["product"], mine["main"], mine["annex"], 1, **{field: beta_id})
    assert response.status_code == 422
    assert snapshot(session_factory) == before


def test_new_warehouses_and_movements_belong_to_the_authenticated_organization(two_orgs, session_factory):
    alpha = two_orgs["alpha"]
    warehouse, product = alpha.warehouse("NEW"), alpha.product(sku="NEW")
    alpha.add(product, warehouse, 2)
    state = snapshot(session_factory)
    owners = {row[-1] for group in state.values() for row in group}
    assert {str(o) for o in owners} == {two_orgs["alpha_id"]}


def test_query_headers_and_cookies_naming_another_organization_change_nothing(two_orgs, world):
    alpha, beta_id = two_orgs["alpha"], two_orgs["beta_id"]
    sneaky = {**alpha.headers, "X-Organization-Id": beta_id, "X-Tenant-Id": beta_id, "Cookie": f"organization_id={beta_id}"}
    params = {"organization_id": beta_id, "tenant_id": beta_id, "org_id": beta_id}
    for url in (WAREHOUSES_URL, STOCK_URL, f"{STOCK_URL}/movements"):
        body = alpha.client.get(url, params=params, headers=sneaky).json()
        assert "beta" not in str(body).lower(), url
    assert alpha.client.get(WAREHOUSES_URL, params=params, headers=sneaky).json()["total"] == 2


def test_no_stock_or_warehouse_endpoint_declares_an_organization_input(client):
    spec = client.get("/openapi.json").json()
    for path, operations in spec["paths"].items():
        for method, operation in operations.items():
            names = {p["name"].lower() for p in operation.get("parameters", [])}
            assert not [n for n in names if "org" in n or "tenant" in n], (method, path)
    for name, schema in spec["components"]["schemas"].items():
        assert not [p for p in schema.get("properties", {}) if "org" in p.lower() or "tenant" in p.lower()], name


# --- the database enforces it too -----------------------------------------------------------------------
def test_the_database_refuses_a_balance_that_mixes_organizations(two_orgs, world, session_factory):
    """Even code that forgot to scope a query cannot tie Alpha's product to Beta's warehouse."""
    with session_factory() as db:
        with pytest.raises(IntegrityError):
            db.execute(
                text("INSERT INTO stock_balances (id, organization_id, product_id, warehouse_id, quantity) VALUES (gen_random_uuid(), :org, :p, :w, 1)"),
                {"org": two_orgs["alpha_id"], "p": world["alpha"]["product"]["id"], "w": world["beta"]["main"]["id"]},
            )
            db.commit()
    with session_factory() as db:
        with pytest.raises(IntegrityError):
            db.execute(
                text("INSERT INTO stock_balances (id, organization_id, product_id, warehouse_id, quantity) VALUES (gen_random_uuid(), :org, :p, :w, 1)"),
                {"org": two_orgs["alpha_id"], "p": world["beta"]["product"]["id"], "w": world["alpha"]["main"]["id"]},
            )
            db.commit()


def test_the_database_refuses_a_movement_that_mixes_organizations(two_orgs, world, session_factory):
    with session_factory() as db:
        operation = db.scalar(select(StockOperation).where(StockOperation.organization_id == uuid.UUID(two_orgs["alpha_id"])))
        with pytest.raises(IntegrityError):
            db.execute(
                text("INSERT INTO stock_movements (id, organization_id, operation_id, product_id, warehouse_id, movement_type, quantity, "
                     "balance_after, reason, created_by, created_by_email) VALUES (gen_random_uuid(), :org, :op, :p, :w, 'in', 1, 1, 'x', :u, 'x@x')"),
                {"org": two_orgs["alpha_id"], "op": operation.id, "p": world["alpha"]["product"]["id"],
                 "w": world["beta"]["main"]["id"], "u": operation.created_by},
            )
            db.commit()


def test_warehouse_codes_are_unique_per_organization_in_the_database(two_orgs, world, session_factory):
    with session_factory() as db:
        db.add(Warehouse(organization_id=uuid.UUID(two_orgs["alpha_id"]), code="MAIN", name="dup"))
        with pytest.raises(IntegrityError):
            db.commit()


# --- who may use the stock endpoints at all ----------------------------------------------------------------
STOCK_ENDPOINTS = [
    ("get", WAREHOUSES_URL, None), ("post", WAREHOUSES_URL, {"code": "X", "name": "X"}),
    ("get", STOCK_URL, None), ("get", f"{STOCK_URL}/movements", None),
    ("post", f"{STOCK_URL}/in", {"product_id": str(uuid.uuid4()), "warehouse_id": str(uuid.uuid4()), "quantity": "1"}),
    ("post", f"{STOCK_URL}/transfer", {"product_id": str(uuid.uuid4()), "from_warehouse_id": str(uuid.uuid4()),
                                         "to_warehouse_id": str(uuid.uuid4()), "quantity": "1"}),
]


def call(client, method, url, body, headers):
    return getattr(client, method)(url, headers={**headers, "Idempotency-Key": "auth-test-0001"}, **({"json": body} if body else {}))


@pytest.mark.parametrize("method,url,body", STOCK_ENDPOINTS)
def test_anonymous_and_invalid_tokens_are_rejected(client, method, url, body):
    assert call(client, method, url, body, {}).status_code == 401
    assert call(client, method, url, body, bearer("not-a-real-token")).status_code == 401


@pytest.mark.parametrize("method,url,body", STOCK_ENDPOINTS)
def test_super_admins_and_users_without_an_organization_are_refused(client, directory, method, url, body):
    org = directory.add_organization("Alpha")
    directory.add_user("super", "super-admin")
    directory.add_user("orphan", "organization-admin", None)
    directory.add_user("staff", "employee", org)
    directory.add_user("disabled", "organization-admin", org, is_active=False)
    for token in ("super", "orphan", "staff", "disabled"):
        assert call(client, method, url, body, bearer(token)).status_code == 403, token


@pytest.mark.parametrize("method,url,body", STOCK_ENDPOINTS)
def test_an_inactive_organization_is_refused_everywhere(client, directory, method, url, body):
    org = directory.add_organization("Dormant", active=False)
    directory.add_user("dormant-admin", "organization-admin", org)
    response = call(client, method, url, body, bearer("dormant-admin"))
    assert response.status_code == 403 and "not active" in response.json()["detail"].lower()


def test_an_organization_that_is_deactivated_keeps_its_data_but_cannot_use_it(two_orgs, directory, world, session_factory):
    before = snapshot(session_factory)
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = False
    alpha = two_orgs["alpha"]
    assert alpha.client.get(STOCK_URL, headers=alpha.headers).status_code == 403
    assert alpha.change("in", product_id=world["alpha"]["product"]["id"], warehouse_id=world["alpha"]["main"]["id"], quantity="1").status_code == 403
    assert snapshot(session_factory) == before  # nothing deleted, nothing changed
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = True
    assert alpha.client.get(STOCK_URL, headers=alpha.headers).status_code == 200  # and it all comes back


@pytest.mark.parametrize("mode", ["down", "500"])
def test_an_organization_service_outage_fails_closed(two_orgs, directory, world, session_factory, mode):
    before = snapshot(session_factory)
    directory.org_mode = mode
    alpha = two_orgs["alpha"]
    assert alpha.client.get(STOCK_URL, headers=alpha.headers).status_code == 503
    response = alpha.change("out", product_id=world["alpha"]["product"]["id"], warehouse_id=world["alpha"]["main"]["id"], quantity="1")
    assert response.status_code == 503
    assert snapshot(session_factory) == before


def test_the_stock_endpoints_pass_the_callers_own_token_to_the_organization_service(two_orgs, directory, world):
    directory.org_calls.clear()
    two_orgs["beta"].client.get(STOCK_URL, headers=two_orgs["beta"].headers)
    assert directory.org_calls and all(call["authorization"] == "Bearer admin-beta" for call in directory.org_calls)
