"""Two organizations, one administrator each: balances and movements never cross the boundary.

Also: who may use the stock endpoints at all, and what happens when the organization is inactive.
"""
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.models import StockBalance, StockMovement, StockOperation

from conftest import STOCK_URL, bearer


@pytest.fixture
def world(two_orgs):
    """Each organization has a product and some history. The names differ so leaks are visible."""
    data = {}
    for who in ("alpha", "beta"):
        org = two_orgs[who]
        product = org.product(sku=f"{who.upper()}-BOLT", name=f"{who} bolt", unit="pcs")
        org.add(product, 10)
        org.add(product, 4, action="out")
        data[who] = {"product": product}
    return data


def snapshot(session_factory):
    with session_factory() as db:
        return {
            "balances": sorted((b.product_id, b.quantity, b.organization_id) for b in db.scalars(select(StockBalance))),
            "movements": sorted((m.id, m.quantity, m.balance_after, m.reason, m.organization_id) for m in db.scalars(select(StockMovement))),
            "operations": sorted((o.id, o.idempotency_key, o.organization_id) for o in db.scalars(select(StockOperation))),
        }


# --- reading -----------------------------------------------------------------------------------------
def test_each_administrator_sees_only_their_own_balances(two_orgs, world):
    for who, other in (("alpha", "beta"), ("beta", "alpha")):
        response = two_orgs[who].client.get(STOCK_URL, params={"status": "all"}, headers=two_orgs[who].headers)
        body = response.json()
        assert body["total"] == 1 and body["items"][0]["product_id"] == world[who]["product"]["id"]
        assert body["items"][0]["total_quantity"] == "6.0000"
        assert other not in response.text.lower()


def test_each_administrator_sees_only_their_own_movements(two_orgs, world):
    for who, other in (("alpha", "beta"), ("beta", "alpha")):
        body_text = two_orgs[who].client.get(f"{STOCK_URL}/movements", headers=two_orgs[who].headers).text
        assert two_orgs[who].movements()["total"] == 2  # in, out
        assert other not in body_text.lower()


def test_filtering_by_the_other_tenants_ids_finds_nothing(two_orgs, world):
    alpha = two_orgs["alpha"]
    theirs = world["beta"]
    assert alpha.movements(product_id=theirs["product"]["id"])["total"] == 0
    assert alpha.client.get(STOCK_URL, params={"q": "beta"}, headers=alpha.headers).json()["total"] == 0


# --- changing ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("attacker,victim", [("alpha", "beta"), ("beta", "alpha")])
def test_stock_cannot_be_changed_for_the_others_product(two_orgs, world, session_factory, attacker, victim):
    before = snapshot(session_factory)
    org, theirs = two_orgs[attacker], world[victim]
    attempts = [
        ("in", dict(product_id=theirs["product"]["id"], quantity="5")),
        ("out", dict(product_id=theirs["product"]["id"], quantity="1")),  # steal their stock
        ("opening", dict(product_id=theirs["product"]["id"], quantity="5")),
    ]
    for action, body in attempts:
        response = org.change(action, **body)
        assert response.status_code == 404, (action, body)
        assert response.json()["detail"] == "Product not found."
    assert snapshot(session_factory) == before  # not a balance, movement or idempotency record changed


def test_a_foreign_object_error_is_identical_to_a_missing_one(two_orgs, world):
    alpha, theirs = two_orgs["alpha"], world["beta"]
    foreign = alpha.change("in", product_id=theirs["product"]["id"], quantity="1")
    missing = alpha.change("in", product_id=str(uuid.uuid4()), quantity="1")
    assert foreign.status_code == missing.status_code == 404 and foreign.json() == missing.json()


def test_an_idempotency_key_cannot_replay_another_tenants_result(two_orgs, world):
    beta_first = two_orgs["beta"].change("in", key="shared-key-9999", product_id=world["beta"]["product"]["id"], quantity="1")
    assert beta_first.status_code == 201
    alpha = two_orgs["alpha"]
    alpha_same_key = alpha.change("in", key="shared-key-9999", product_id=world["alpha"]["product"]["id"], quantity="1")
    assert alpha_same_key.status_code == 201 and alpha_same_key.json()["replayed"] is False  # a fresh operation, not Beta's
    assert alpha_same_key.json()["operation_id"] != beta_first.json()["operation_id"]
    assert "beta" not in alpha_same_key.text.lower()


# --- the organization can never be chosen by the caller -------------------------------------------------
@pytest.mark.parametrize("field", ["organization_id", "organizationId", "tenant_id", "org_id"])
def test_an_organization_id_in_any_body_is_rejected(two_orgs, world, session_factory, field):
    before = snapshot(session_factory)
    alpha, beta_id, mine = two_orgs["alpha"], two_orgs["beta_id"], world["alpha"]
    for action in ("in", "out", "opening"):
        response = alpha.change(action, product_id=mine["product"]["id"], quantity="1", **{field: beta_id})
        assert response.status_code == 422
    assert snapshot(session_factory) == before


def test_new_movements_belong_to_the_authenticated_organization(two_orgs, session_factory):
    alpha = two_orgs["alpha"]
    product = alpha.product(sku="NEW")
    alpha.add(product, 2)
    state = snapshot(session_factory)
    owners = {row[-1] for group in state.values() for row in group}
    assert {str(o) for o in owners} == {two_orgs["alpha_id"]}


def test_query_headers_and_cookies_naming_another_organization_change_nothing(two_orgs, world):
    alpha, beta_id = two_orgs["alpha"], two_orgs["beta_id"]
    sneaky = {**alpha.headers, "X-Organization-Id": beta_id, "X-Tenant-Id": beta_id, "Cookie": f"organization_id={beta_id}"}
    params = {"organization_id": beta_id, "tenant_id": beta_id, "org_id": beta_id}
    for url in (STOCK_URL, f"{STOCK_URL}/movements"):
        body = alpha.client.get(url, params=params, headers=sneaky).json()
        assert "beta" not in str(body).lower(), url
    assert alpha.client.get(STOCK_URL, params=params, headers=sneaky).json()["total"] == 1


def test_no_stock_endpoint_declares_an_organization_input(client):
    spec = client.get("/openapi.json").json()
    for path, operations in spec["paths"].items():
        for method, operation in operations.items():
            names = {p["name"].lower() for p in operation.get("parameters", [])}
            assert not [n for n in names if "org" in n or "tenant" in n], (method, path)
    for name, schema in spec["components"]["schemas"].items():
        assert not [p for p in schema.get("properties", {}) if "org" in p.lower() or "tenant" in p.lower()], name


def test_the_api_has_no_warehouse_or_transfer_anywhere(client):
    spec = client.get("/openapi.json").json()
    assert not [p for p in spec["paths"] if "warehouse" in p.lower() or "transfer" in p.lower()]
    text_of_spec = str(spec).lower()
    assert "warehouse" not in text_of_spec and "transfer" not in text_of_spec


# --- the database enforces it too -----------------------------------------------------------------------
def test_the_database_refuses_a_balance_that_mixes_organizations(two_orgs, world, session_factory):
    """Even code that forgot to scope a query cannot tie Beta's product to Alpha's balance."""
    with session_factory() as db:
        with pytest.raises(IntegrityError):
            db.execute(
                text("INSERT INTO stock_balances (id, organization_id, product_id, quantity) VALUES (gen_random_uuid(), :org, :p, 1)"),
                {"org": two_orgs["alpha_id"], "p": world["beta"]["product"]["id"]},
            )
            db.commit()


def test_the_database_refuses_a_movement_that_mixes_organizations(two_orgs, world, session_factory):
    with session_factory() as db:
        operation = db.scalar(select(StockOperation).where(StockOperation.organization_id == uuid.UUID(two_orgs["alpha_id"])))
        with pytest.raises(IntegrityError):
            db.execute(
                text("INSERT INTO stock_movements (id, organization_id, operation_id, product_id, movement_type, quantity, "
                     "balance_after, reason, created_by, created_by_email) VALUES (gen_random_uuid(), :org, :op, :p, 'in', 1, 1, 'x', :u, 'x@x')"),
                {"org": two_orgs["alpha_id"], "op": operation.id, "p": world["beta"]["product"]["id"], "u": operation.created_by},
            )
            db.commit()


# --- who may use the stock endpoints at all ----------------------------------------------------------------
STOCK_ENDPOINTS = [
    ("get", STOCK_URL, None), ("get", f"{STOCK_URL}/movements", None),
    ("post", f"{STOCK_URL}/in", {"product_id": str(uuid.uuid4()), "quantity": "1"}),
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
    assert alpha.change("in", product_id=world["alpha"]["product"]["id"], quantity="1").status_code == 403
    assert snapshot(session_factory) == before  # nothing deleted, nothing changed
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = True
    assert alpha.client.get(STOCK_URL, headers=alpha.headers).status_code == 200  # and it all comes back


@pytest.mark.parametrize("mode", ["down", "500"])
def test_an_organization_service_outage_fails_closed(two_orgs, directory, world, session_factory, mode):
    before = snapshot(session_factory)
    directory.org_mode = mode
    alpha = two_orgs["alpha"]
    assert alpha.client.get(STOCK_URL, headers=alpha.headers).status_code == 503
    response = alpha.change("out", product_id=world["alpha"]["product"]["id"], quantity="1")
    assert response.status_code == 503
    assert snapshot(session_factory) == before


def test_the_stock_endpoints_pass_the_callers_own_token_to_the_organization_service(two_orgs, directory, world):
    directory.org_calls.clear()
    two_orgs["beta"].client.get(STOCK_URL, headers=two_orgs["beta"].headers)
    assert directory.org_calls and all(call["authorization"] == "Bearer admin-beta" for call in directory.org_calls)
