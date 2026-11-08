"""Two organizations never see each other's clients, lists or products; and who may use the service at all."""
import uuid

import pytest
from sqlalchemy import func, select

from app.models import Client, DeliveryList, DeliveryListItem

from conftest import CLIENTS, LISTS, bearer


@pytest.fixture
def world(two_orgs, inventory):
    """Both organizations have a client named 'Acme Ltd', a product with the SAME SKU, and a list with one item."""
    data = {}
    for who in ("alpha", "beta"):
        org = two_orgs[who]
        pid = inventory.add_product(org.org_id, "SHARED-SKU", f"{who} gadget", "pcs")
        inventory.set_stock(pid, 7 if who == "alpha" else 99)
        client = org.new_client("Acme Ltd", contact_person=f"{who} contact")
        created = org.new_list(client["id"], external_reference=f"{who}-PO")
        item = org.add(created["id"], pid, 3).json()["item"]
        data[who] = {"client": client, "list": created, "item": item, "product": pid}
    return data


def snapshot(session_factory):
    with session_factory() as db:
        return {
            "clients": sorted((c.id, c.name, c.is_active, c.organization_id) for c in db.scalars(select(Client))),
            "lists": sorted((l.id, l.number, l.status, l.notes, l.organization_id) for l in db.scalars(select(DeliveryList))),
            "items": sorted((i.id, i.quantity, i.product_id, i.organization_id) for i in db.scalars(select(DeliveryListItem))),
        }


def test_each_administrator_sees_only_their_own_clients_and_lists(two_orgs, world):
    for who, other in (("alpha", "beta"), ("beta", "alpha")):
        org = two_orgs[who]
        clients = org.client.get(CLIENTS, params={"status": "all"}, headers=org.headers)
        lists = org.client.get(LISTS, headers=org.headers)
        assert [c["id"] for c in clients.json()["items"]] == [world[who]["client"]["id"]]
        assert [l["id"] for l in lists.json()["items"]] == [world[who]["list"]["id"]]
        assert other not in clients.text.lower() + lists.text.lower()


def test_searches_cannot_find_the_other_organizations_data(two_orgs, world):
    alpha = two_orgs["alpha"]
    assert alpha.client.get(CLIENTS, params={"q": "beta contact"}, headers=alpha.headers).json()["total"] == 0
    assert alpha.client.get(LISTS, params={"q": "beta-PO"}, headers=alpha.headers).json()["total"] == 0
    assert alpha.client.get(LISTS, params={"client_id": world["beta"]["client"]["id"]}, headers=alpha.headers).json()["total"] == 0


def test_another_organizations_objects_are_indistinguishable_from_missing_ones(two_orgs, world):
    alpha = two_orgs["alpha"]
    theirs = world["beta"]
    for url in (f"{CLIENTS}/{theirs['client']['id']}", f"{LISTS}/{theirs['list']['id']}"):
        foreign = alpha.client.get(url, headers=alpha.headers)
        missing = alpha.client.get(url.rsplit("/", 1)[0] + f"/{uuid.uuid4()}", headers=alpha.headers)
        assert foreign.status_code == missing.status_code == 404
        assert foreign.json()["detail"].split()[0] == missing.json()["detail"].split()[0]
        assert "beta" not in foreign.text.lower()


@pytest.mark.parametrize("attacker,victim", [("alpha", "beta"), ("beta", "alpha")])
def test_nothing_of_the_other_organization_can_be_changed(two_orgs, world, session_factory, attacker, victim):
    before = snapshot(session_factory)
    org, theirs = two_orgs[attacker], world[victim]
    lid, cid, iid = theirs["list"]["id"], theirs["client"]["id"], theirs["item"]["id"]
    attempts = [
        org.client.patch(f"{CLIENTS}/{cid}", json={"name": "HIJACKED"}, headers=org.headers),
        org.client.post(f"{CLIENTS}/{cid}/deactivate", headers=org.headers),
        org.client.post(f"{CLIENTS}/{cid}/activate", headers=org.headers),
        org.client.patch(f"{LISTS}/{lid}", json={"notes": "HIJACKED"}, headers=org.headers),
        org.status(lid, "cancel"), org.status(lid, "ready"), org.status(lid, "reopen"),
        org.client.patch(f"{LISTS}/{lid}/items/{iid}", json={"quantity": "999"}, headers=org.headers),
        org.client.post(f"{LISTS}/{lid}/items/{iid}/increase", json={"quantity": "1"}, headers=org.headers),
        org.client.delete(f"{LISTS}/{lid}/items/{iid}", headers=org.headers),
        org.add(lid, world[attacker]["product"], 1),  # my product onto their list
        org.client.post(LISTS, json={"client_id": cid}, headers=org.headers),  # a list for their client
    ]
    assert [a.status_code for a in attempts] == [404] * len(attempts)
    assert snapshot(session_factory) == before


def test_a_product_of_the_other_organization_cannot_be_put_on_my_list(two_orgs, world, session_factory):
    alpha = two_orgs["alpha"]
    before = snapshot(session_factory)
    response = alpha.add(world["alpha"]["list"]["id"], world["beta"]["product"], 1)
    assert response.status_code == 404 and response.json()["detail"] == "Product not found."
    missing = alpha.add(world["alpha"]["list"]["id"], str(uuid.uuid4()), 1)
    assert missing.json() == response.json()  # identical to a product that does not exist
    assert snapshot(session_factory) == before


def test_a_warehouse_cannot_be_planned_at_all(two_orgs, world):
    alpha = two_orgs["alpha"]
    other = alpha.new_client("Other")
    fresh = alpha.new_list(other["id"])
    response = alpha.add(fresh["id"], world["alpha"]["product"], 1, planned_warehouse_id=str(uuid.uuid4()))
    assert response.status_code == 422


def test_the_same_sku_and_client_name_resolve_to_each_organizations_own_data(two_orgs, world):
    for who in ("alpha", "beta"):
        org = two_orgs[who]
        detail = org.detail(world[who]["list"]["id"])
        assert detail["client"]["name"] == "Acme Ltd" and detail["items"][0]["product_name"] == f"{who} gadget"
        assert detail["items"][0]["stock"]["total_quantity"] == ("7" if who == "alpha" else "99")


def test_the_organization_comes_from_the_token_never_from_the_request(two_orgs, world):
    alpha, beta_id = two_orgs["alpha"], two_orgs["beta_id"]
    sneaky = {**alpha.headers, "X-Organization-Id": beta_id, "X-Tenant-Id": beta_id, "Cookie": f"organization_id={beta_id}"}
    params = {"organization_id": beta_id, "tenant_id": beta_id, "org_id": beta_id}
    for url in (CLIENTS, LISTS):
        assert "beta" not in alpha.client.get(url, params=params, headers=sneaky).text.lower()
    created = alpha.client.post(CLIENTS + f"?organization_id={beta_id}", json={"name": "Via query"}, headers=sneaky)
    assert created.status_code == 201
    assert two_orgs["beta"].client.get(CLIENTS, params={"q": "Via query"}, headers=two_orgs["beta"].headers).json()["total"] == 0


def test_no_endpoint_declares_an_organization_input(client):
    spec = client.get("/openapi.json").json()
    for path, operations in spec["paths"].items():
        for method, operation in operations.items():
            names = {p["name"].lower() for p in operation.get("parameters", [])}
            assert not [n for n in names if "org" in n or "tenant" in n], (method, path)
    for name, schema in spec["components"]["schemas"].items():
        assert not [p for p in schema.get("properties", {}) if "org" in p.lower() or "tenant" in p.lower()], name


# --- who may use the service ----------------------------------------------------------------------------------------------
def _ids():
    return str(uuid.uuid4()), str(uuid.uuid4())


LID, IID = _ids()
ENDPOINTS = [
    ("get", CLIENTS, None), ("post", CLIENTS, {"name": "X"}), ("get", f"{CLIENTS}/{LID}", None),
    ("get", LISTS, None), ("post", LISTS, {"client_id": LID}), ("get", f"{LISTS}/{LID}", None),
    ("post", f"{LISTS}/{LID}/ready", None), ("post", f"{LISTS}/{LID}/items", {"product_id": IID, "quantity": "1"}),
    ("delete", f"{LISTS}/{LID}/items/{IID}", None),
]


def call(client, method, url, body, headers):
    return getattr(client, method)(url, headers=headers, **({"json": body} if body else {}))


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
    directory.add_user("dormant", "organization-admin", org)
    response = call(client, method, url, body, bearer("dormant"))
    assert response.status_code == 403 and "not active" in response.json()["detail"].lower()


def test_an_organization_that_is_deactivated_keeps_its_data_but_cannot_use_it(two_orgs, directory, world, session_factory):
    before = snapshot(session_factory)
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = False
    alpha = two_orgs["alpha"]
    assert alpha.client.get(LISTS, headers=alpha.headers).status_code == 403
    assert alpha.client.post(CLIENTS, json={"name": "New"}, headers=alpha.headers).status_code == 403
    assert snapshot(session_factory) == before
    directory.organizations[two_orgs["alpha_id"]]["is_active"] = True
    assert alpha.client.get(LISTS, headers=alpha.headers).status_code == 200


@pytest.mark.parametrize("service", ["auth", "org"])
@pytest.mark.parametrize("mode", ["down", "500"])
@pytest.mark.parametrize("method,url,body", ENDPOINTS[:6])
def test_a_dependency_outage_fails_closed(client, directory, two_orgs, session_factory, service, mode, method, url, body):
    before = snapshot(session_factory)
    setattr(directory, f"{service}_mode", mode)
    assert call(client, method, url, body, two_orgs["alpha"].headers).status_code == 503
    assert snapshot(session_factory) == before
