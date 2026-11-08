"""Two organizations never see each other's suppliers, orders or products; and who may use the service at all."""
import uuid

import pytest
from sqlalchemy import select

from app.models import PurchaseOrder, PurchaseOrderLine, Supplier

from conftest import ORDERS, SUPPLIERS, bearer


@pytest.fixture
def world(two_orgs, inventory):
    """Both organizations have a supplier named 'Acme Supplies', a product with the SAME SKU, and an order with one line."""
    data = {}
    for who in ("alpha", "beta"):
        org = two_orgs[who]
        pid = inventory.add_product(org.org_id, "SHARED-SKU", f"{who} gadget", "pcs")
        inventory.set_stock(pid, 7 if who == "alpha" else 99)
        supplier = org.supplier("Acme Supplies", code="ACME", contact_person=f"{who} contact")
        order = org.order(supplier["id"], supplier_reference=f"{who}-REF")
        line = org.add(order["id"], pid, 3, "1.50").json()["line"]
        data[who] = {"supplier": supplier, "order": order, "line": line, "product": pid}
    return data


def snapshot(session_factory):
    with session_factory() as db:
        return {
            "suppliers": sorted((s.id, s.name, s.is_active, s.organization_id) for s in db.scalars(select(Supplier))),
            "orders": sorted((o.id, o.number, o.status, o.notes, o.organization_id) for o in db.scalars(select(PurchaseOrder))),
            "lines": sorted((l.id, l.quantity, l.unit_price, l.product_id, l.organization_id) for l in db.scalars(select(PurchaseOrderLine))),
        }


def test_each_administrator_sees_only_their_own_suppliers_and_orders(two_orgs, world):
    for who, other in (("alpha", "beta"), ("beta", "alpha")):
        org = two_orgs[who]
        suppliers = org.client.get(SUPPLIERS, params={"status": "all"}, headers=org.headers)
        orders = org.client.get(ORDERS, headers=org.headers)
        assert [s["id"] for s in suppliers.json()["items"]] == [world[who]["supplier"]["id"]]
        assert [o["id"] for o in orders.json()["items"]] == [world[who]["order"]["id"]]
        assert other not in suppliers.text.lower() + orders.text.lower()


def test_searches_cannot_find_the_other_organizations_data(two_orgs, world):
    alpha = two_orgs["alpha"]
    assert alpha.client.get(SUPPLIERS, params={"q": "beta contact"}, headers=alpha.headers).json()["total"] == 0
    assert alpha.client.get(ORDERS, params={"q": "beta-REF"}, headers=alpha.headers).json()["total"] == 0
    assert alpha.client.get(ORDERS, params={"supplier_id": world["beta"]["supplier"]["id"]}, headers=alpha.headers).json()["total"] == 0


def test_another_organizations_objects_are_indistinguishable_from_missing_ones(two_orgs, world):
    alpha, theirs = two_orgs["alpha"], world["beta"]
    for base, found in ((SUPPLIERS, theirs["supplier"]["id"]), (ORDERS, theirs["order"]["id"])):
        foreign = alpha.client.get(f"{base}/{found}", headers=alpha.headers)
        missing = alpha.client.get(f"{base}/{uuid.uuid4()}", headers=alpha.headers)
        assert foreign.status_code == missing.status_code == 404 and foreign.json() == missing.json()
        assert "beta" not in foreign.text.lower()


@pytest.mark.parametrize("attacker,victim", [("alpha", "beta"), ("beta", "alpha")])
def test_nothing_of_the_other_organization_can_be_changed(two_orgs, world, session_factory, attacker, victim):
    before = snapshot(session_factory)
    org, theirs = two_orgs[attacker], world[victim]
    oid, sid, lid = theirs["order"]["id"], theirs["supplier"]["id"], theirs["line"]["id"]
    attempts = [
        org.client.patch(f"{SUPPLIERS}/{sid}", json={"name": "HIJACKED"}, headers=org.headers),
        org.client.post(f"{SUPPLIERS}/{sid}/deactivate", headers=org.headers),
        org.client.post(f"{SUPPLIERS}/{sid}/activate", headers=org.headers),
        org.client.patch(f"{ORDERS}/{oid}", json={"notes": "HIJACKED"}, headers=org.headers),
        org.action(oid, "order"), org.action(oid, "cancel"),
        org.client.patch(f"{ORDERS}/{oid}/lines/{lid}", json={"quantity": "999"}, headers=org.headers),
        org.client.delete(f"{ORDERS}/{oid}/lines/{lid}", headers=org.headers),
        org.add(oid, world[attacker]["product"], 1, "1"),  # my product onto their order
        org.create_order(sid),  # an order for their supplier
    ]
    assert [a.status_code for a in attempts] == [404] * len(attempts)
    assert snapshot(session_factory) == before


def test_a_product_of_the_other_organization_cannot_be_ordered(two_orgs, world, session_factory):
    alpha = two_orgs["alpha"]
    before = snapshot(session_factory)
    response = alpha.add(world["alpha"]["order"]["id"], world["beta"]["product"], 1, "1")
    assert response.status_code == 404 and response.json()["detail"] == "Product not found."
    assert alpha.add(world["alpha"]["order"]["id"], str(uuid.uuid4()), 1, "1").json() == response.json()  # identical to a product that does not exist
    assert snapshot(session_factory) == before


def test_a_warehouse_cannot_be_planned_at_all(two_orgs, world):
    alpha = two_orgs["alpha"]
    fresh = alpha.order(alpha.supplier("Other")["id"])
    response = alpha.add(fresh["id"], world["alpha"]["product"], 1, "1", planned_warehouse_id=str(uuid.uuid4()))
    assert response.status_code == 422


def test_the_same_sku_supplier_name_and_code_resolve_to_each_organizations_own_data(two_orgs, world):
    for who in ("alpha", "beta"):
        detail = two_orgs[who].detail(world[who]["order"]["id"])
        assert detail["supplier"]["name"] == "Acme Supplies" and detail["lines"][0]["product_name"] == f"{who} gadget"
    assert world["alpha"]["supplier"]["id"] != world["beta"]["supplier"]["id"]


def test_the_organization_comes_from_the_token_never_from_the_request(two_orgs, world):
    alpha, beta_id = two_orgs["alpha"], two_orgs["beta_id"]
    sneaky = {**alpha.headers, "X-Organization-Id": beta_id, "X-Tenant-Id": beta_id, "Cookie": f"organization_id={beta_id}"}
    params = {"organization_id": beta_id, "tenant_id": beta_id, "org_id": beta_id}
    for url in (SUPPLIERS, ORDERS):
        assert "beta" not in alpha.client.get(url, params=params, headers=sneaky).text.lower()
    created = alpha.client.post(SUPPLIERS + f"?organization_id={beta_id}", json={"name": "Via query"}, headers=sneaky)
    assert created.status_code == 201
    assert two_orgs["beta"].client.get(SUPPLIERS, params={"q": "Via query"}, headers=two_orgs["beta"].headers).json()["total"] == 0


def test_no_endpoint_declares_an_organization_input(client):
    spec = client.get("/openapi.json").json()
    for path, operations in spec["paths"].items():
        for method, operation in operations.items():
            names = {p["name"].lower() for p in operation.get("parameters", [])}
            assert not [n for n in names if "org" in n or "tenant" in n], (method, path)
    for name, schema in spec["components"]["schemas"].items():
        assert not [p for p in schema.get("properties", {}) if "org" in p.lower() or "tenant" in p.lower()], name


# --- who may use the service ----------------------------------------------------------------------------------------------------------
SID, OID, PID = (str(uuid.uuid4()) for _ in range(3))
ENDPOINTS = [
    ("get", SUPPLIERS, None), ("post", SUPPLIERS, {"name": "X"}), ("get", f"{SUPPLIERS}/{SID}", None), ("patch", f"{SUPPLIERS}/{SID}", {"name": "Y"}),
    ("get", ORDERS, None), ("post", ORDERS, {"supplier_id": SID, "currency_code": "USD"}), ("get", f"{ORDERS}/{OID}", None),
    ("post", f"{ORDERS}/{OID}/order", None), ("post", f"{ORDERS}/{OID}/lines", {"product_id": PID, "quantity": "1", "unit_price": "1"}),
    ("delete", f"{ORDERS}/{OID}/lines/{PID}", None),
]


def call(client, method, url, body, headers):
    return getattr(client, method)(url, headers={**headers, "Idempotency-Key": "access-test-0001"}, **({"json": body} if body else {}))


@pytest.mark.parametrize("method,url,body", ENDPOINTS)
def test_anonymous_and_invalid_tokens_are_rejected(client, method, url, body):
    assert call(client, method, url, body, {}).status_code == 401
    assert call(client, method, url, body, bearer("nonsense")).status_code == 401


@pytest.mark.parametrize("method,url,body", ENDPOINTS)
def test_super_admins_orphans_staff_and_disabled_users_are_refused(client, directory, method, url, body):
    org = directory.add_organization("Alpha")
    directory.add_user("super", "super-admin")
    directory.add_user("orphan", "organization-admin", None)
    directory.add_user("staff", "employee", org)
    directory.add_user("disabled", "organization-admin", org, is_active=False)
    for token in ("super", "orphan", "staff", "disabled"):
        assert call(client, method, url, body, bearer(token)).status_code == 403, token


@pytest.mark.parametrize("method,url,body", ENDPOINTS)
def test_an_inactive_organization_is_refused_everywhere(client, directory, method, url, body):
    org = directory.add_organization("Dormant", active=False)
    directory.add_user("dormant-admin", "organization-admin", org)
    response = call(client, method, url, body, bearer("dormant-admin"))
    assert response.status_code == 403 and "not active" in response.json()["detail"].lower()


def test_a_deactivated_organization_keeps_its_data_but_cannot_use_it(two_orgs, directory, world, session_factory):
    before = snapshot(session_factory)
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = False
    alpha = two_orgs["alpha"]
    assert alpha.client.get(ORDERS, headers=alpha.headers).status_code == 403
    assert alpha.client.post(SUPPLIERS, json={"name": "New"}, headers=alpha.headers).status_code == 403
    assert snapshot(session_factory) == before
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = True
    assert alpha.client.get(ORDERS, headers=alpha.headers).status_code == 200


@pytest.mark.parametrize("service", ["auth", "org"])
@pytest.mark.parametrize("mode", ["down", "500"])
@pytest.mark.parametrize("method,url,body", ENDPOINTS[:8])
def test_a_dependency_outage_fails_closed(client, directory, two_orgs, session_factory, service, mode, method, url, body):
    before = snapshot(session_factory)
    setattr(directory, f"{service}_mode", mode)
    assert call(client, method, url, body, two_orgs["alpha"].headers).status_code == 503
    assert snapshot(session_factory) == before
