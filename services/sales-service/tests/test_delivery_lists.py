"""Delivery lists: creating, numbering, searching, editing, and the Draft / Ready / Cancelled life cycle."""
import threading
import uuid

import pytest
from sqlalchemy import select

from app.models import DeliveryList

from conftest import CLIENTS, LISTS, bearer


def test_creating_a_list_for_a_client(api, session_factory):
    acme = api.new_client("Acme Ltd")
    response = api.client.post(LISTS, json={"client_id": acme["id"], "external_reference": " PO-4711 ", "notes": " Deliver to dock 3 "}, headers=api.headers)
    assert response.status_code == 201
    body = response.json()
    assert (body["number"], body["status"], body["item_count"]) == ("DL-000001", "draft", 0)
    assert (body["external_reference"], body["notes"]) == ("PO-4711", "Deliver to dock 3")
    assert body["client"] == {"id": acme["id"], "name": "Acme Ltd", "is_active": True}
    assert body["created_by_email"] == "admin-alpha@example.org" and "organization_id" not in body
    with session_factory() as db:
        (row,) = db.scalars(select(DeliveryList)).all()
    assert str(row.organization_id) == api.org_id and str(row.client_id) == acme["id"]


def test_numbers_count_up_per_organization(two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    a_client, b_client = alpha.new_client("Client"), beta.new_client("Client")
    assert [alpha.new_list(a_client["id"])["number"] for _ in range(3)] == ["DL-000001", "DL-000002", "DL-000003"]
    assert beta.new_list(b_client["id"])["number"] == "DL-000001"  # a different organization starts at 1 as well


def test_simultaneous_creations_never_share_a_number(api, client):
    acme = api.new_client("Acme Ltd")
    numbers, errors = [], []

    def create():
        response = client.post(LISTS, json={"client_id": acme["id"]}, headers=api.headers)
        (numbers if response.status_code == 201 else errors).append(response.json().get("number", response.text))

    threads = [threading.Thread(target=create) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert errors == []
    assert sorted(numbers) == [f"DL-{i:06d}" for i in range(1, 9)]


@pytest.mark.parametrize("payload", [
    {}, {"client_id": "nope"}, {"client_id": str(uuid.uuid4()), "status": "ready"}, {"client_id": str(uuid.uuid4()), "number": "DL-9"},
    {"client_id": str(uuid.uuid4()), "organization_id": str(uuid.uuid4())}, {"client_id": str(uuid.uuid4()), "external_reference": "x" * 101},
    {"client_id": str(uuid.uuid4()), "notes": "x" * 2001}, {"client_id": str(uuid.uuid4()), "created_by": str(uuid.uuid4())},
])
def test_invalid_lists_are_rejected(api, payload):
    assert api.client.post(LISTS, json=payload, headers=api.headers).status_code in (404, 422)
    assert api.client.get(LISTS, headers=api.headers).json()["total"] == 0


def test_a_list_for_an_unknown_client_is_404(api):
    response = api.client.post(LISTS, json={"client_id": str(uuid.uuid4())}, headers=api.headers)
    assert response.status_code == 404 and response.json()["detail"] == "Client not found."


def test_an_inactive_client_gets_no_new_lists_but_keeps_the_old_ones(api):
    acme = api.new_client("Acme Ltd")
    existing = api.new_list(acme["id"])
    api.client.post(f"{CLIENTS}/{acme['id']}/deactivate", headers=api.headers)
    refused = api.client.post(LISTS, json={"client_id": acme["id"]}, headers=api.headers)
    assert refused.status_code == 409 and "inactive" in refused.json()["detail"]
    assert api.detail(existing["id"])["client"]["is_active"] is False  # still viewable, flagged
    api.client.post(f"{CLIENTS}/{acme['id']}/activate", headers=api.headers)
    assert api.client.post(LISTS, json={"client_id": acme["id"]}, headers=api.headers).status_code == 201


def test_several_lists_for_the_same_client(api):
    acme = api.new_client("Acme Ltd")
    lists = [api.new_list(acme["id"], external_reference=f"PO-{i}") for i in range(3)]
    assert len({l["id"] for l in lists}) == 3
    assert api.client.get(LISTS, params={"client_id": acme["id"]}, headers=api.headers).json()["total"] == 3


def test_viewing_filtering_and_searching_lists(api):
    acme, beta = api.new_client("Acme Ltd"), api.new_client("Beta GmbH")
    first = api.new_list(acme["id"], external_reference="PO-ALPHA-1")
    second = api.new_list(acme["id"], external_reference="PO-ALPHA-2")
    third = api.new_list(beta["id"], external_reference="WEB-77")
    api.status(second["id"], "cancel")

    def numbers(**params):
        body = api.client.get(LISTS, params=params, headers=api.headers).json()
        return [l["number"] for l in body["items"]], body["total"]

    assert numbers() == (["DL-000003", "DL-000002", "DL-000001"], 3)  # newest first
    assert numbers(client_id=beta["id"]) == (["DL-000003"], 1)
    assert numbers(status="cancelled") == (["DL-000002"], 1) and numbers(status="draft")[1] == 2
    assert numbers(q="po-alpha")[1] == 2 and numbers(q="WEB-77") == (["DL-000003"], 1)
    assert numbers(q="dl-000001") == (["DL-000001"], 1)
    assert numbers(q="beta gmbh") == (["DL-000003"], 1)  # by client name
    assert numbers(q="%") == ([], 0)
    assert numbers(client_id=acme["id"], status="draft", q="ALPHA-1") == (["DL-000001"], 1)
    assert numbers(limit=1, offset=2) == (["DL-000001"], 3)
    assert api.client.get(LISTS, params={"status": "bogus"}, headers=api.headers).status_code == 422


def test_editing_reference_and_notes_of_a_draft(api):
    acme = api.new_client("Acme Ltd")
    created = api.new_list(acme["id"], external_reference="OLD")
    url = f"{LISTS}/{created['id']}"
    edited = api.client.patch(url, json={"external_reference": " NEW-1 ", "notes": "Fragile"}, headers=api.headers)
    assert edited.status_code == 200 and (edited.json()["external_reference"], edited.json()["notes"]) == ("NEW-1", "Fragile")
    assert api.client.patch(url, json={"external_reference": ""}, headers=api.headers).json()["external_reference"] is None
    for bad in ({}, {"status": "ready"}, {"client_id": str(uuid.uuid4())}, {"number": "X"}):
        assert api.client.patch(url, json=bad, headers=api.headers).status_code == 422


# --- the life cycle -----------------------------------------------------------------------------------------------
def test_a_list_must_have_items_to_become_ready(api, shop):
    acme = api.new_client("Acme Ltd")
    created = api.new_list(acme["id"])
    refused = api.status(created["id"], "ready")
    assert refused.status_code == 409 and "at least one product" in refused.json()["detail"]
    assert api.detail(created["id"])["status"] == "draft"


def test_draft_ready_reopen_cancel(api, shop, inventory):
    created = api.new_list(api.new_client("Acme Ltd")["id"])
    api.add(created["id"], shop["bolt"], 5)
    ready = api.status(created["id"], "ready")  # Ready BOOKS the quantities: the list becomes a sales order
    assert ready.status_code == 200 and ready.json()["status"] == "ready" and ready.json()["booking_state"] == "booked"
    assert api.status(created["id"], "ready").status_code == 200  # repeating is harmless (and books nothing twice)
    assert inventory.reserved(shop["bolt"]) == 5 and len(inventory.reservation_posts()) == 1
    reopened = api.status(created["id"], "reopen")  # a booked list is changed through its order, never reopened
    assert reopened.status_code == 409 and "Edit the order" in reopened.json()["detail"]
    cancelled = api.status(created["id"], "cancel")  # cancelled through the order: the reservation is released
    assert cancelled.json()["status"] == "cancelled" and inventory.reserved(shop["bolt"]) == 0
    for action in ("ready", "reopen"):
        again = api.status(created["id"], action)
        assert again.status_code == 409 and "cancelled" in again.json()["detail"]  # cancelled is final
    assert api.detail(created["id"])["items"][0]["quantity"] == "5.0000"  # nothing deleted by cancelling


def test_an_empty_draft_can_be_cancelled(api):
    created = api.new_list(api.new_client("Acme Ltd")["id"])
    assert api.status(created["id"], "cancel").json()["status"] == "cancelled"


def test_the_status_cannot_be_set_through_other_routes(api):
    created = api.new_list(api.new_client("Acme Ltd")["id"])
    assert api.client.patch(f"{LISTS}/{created['id']}", json={"status": "ready"}, headers=api.headers).status_code == 422
    assert api.client.put(f"{LISTS}/{created['id']}", json={}, headers=api.headers).status_code == 405
    assert api.client.delete(f"{LISTS}/{created['id']}", headers=api.headers).status_code == 405  # lists are never deleted


def test_a_ready_or_cancelled_list_is_read_only(api, shop):
    created = api.new_list(api.new_client("Acme Ltd")["id"])
    added = api.add(created["id"], shop["bolt"], 5).json()["item"]
    api.status(created["id"], "ready")
    base = f"{LISTS}/{created['id']}"
    attempts = [
        api.client.patch(base, json={"notes": "x"}, headers=api.headers),
        api.add(created["id"], shop["flour"], 1),
        api.client.patch(f"{base}/items/{added['id']}", json={"quantity": "9"}, headers=api.headers),
        api.client.post(f"{base}/items/{added['id']}/increase", json={"quantity": "1"}, headers=api.headers),
        api.client.delete(f"{base}/items/{added['id']}", headers=api.headers),
    ]
    assert [a.status_code for a in attempts] == [409] * 5
    assert all("reopen" in a.json()["detail"] for a in attempts)
    assert api.detail(created["id"])["items"][0]["quantity"] == "5.0000"
    api.status(created["id"], "cancel")
    assert api.add(created["id"], shop["flour"], 1).status_code == 409


def test_marking_ready_needs_an_active_client_and_still_available_products(api, shop, inventory):
    acme = api.new_client("Acme Ltd")
    created = api.new_list(acme["id"])
    api.add(created["id"], shop["bolt"], 5)
    api.client.post(f"{CLIENTS}/{acme['id']}/deactivate", headers=api.headers)
    refused = api.status(created["id"], "ready")
    assert refused.status_code == 409 and "inactive" in refused.json()["detail"]
    api.client.post(f"{CLIENTS}/{acme['id']}/activate", headers=api.headers)
    inventory.products[shop["org"]][shop["bolt"]]["is_active"] = False  # archived in the meantime
    refused = api.status(created["id"], "ready")
    assert refused.status_code == 409 and "Steel bolt" in refused.json()["detail"]
    inventory.products[shop["org"]][shop["bolt"]]["is_active"] = True
    assert api.status(created["id"], "ready").status_code == 200


def test_marking_ready_needs_the_inventory_service(api, shop, inventory):
    created = api.new_list(api.new_client("Acme Ltd")["id"])
    api.add(created["id"], shop["bolt"], 5)
    inventory.mode = "down"
    assert api.status(created["id"], "ready").status_code == 503
    inventory.mode = None
    assert api.detail(created["id"])["status"] == "draft"
