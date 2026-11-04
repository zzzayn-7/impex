"""Client directory: register, search, select, edit, deactivate."""
import uuid

import pytest

from conftest import CLIENTS, bearer


def test_registering_a_client_hides_the_organization_and_normalizes_input(api, session_factory):
    from sqlalchemy import select

    from app.models import Client

    response = api.client.post(CLIENTS, json={
        "name": "  Acme   Trading  Ltd ", "contact_person": " Jane Doe ", "email": " Jane@ACME.example ", "phone": " +49 30 123 ", "address": " 1 Main St "},
        headers=api.headers)
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"id", "name", "contact_person", "email", "phone", "address", "is_active", "created_at", "updated_at"}
    assert (body["name"], body["contact_person"], body["email"], body["phone"], body["address"], body["is_active"]) == \
           ("Acme Trading Ltd", "Jane Doe", "jane@acme.example", "+49 30 123", "1 Main St", True)
    with session_factory() as db:
        (row,) = db.scalars(select(Client)).all()
    assert str(row.organization_id) == api.org_id and uuid.UUID(body["id"]) == row.id


def test_only_the_name_is_required_and_blanks_become_empty(api):
    body = api.client.post(CLIENTS, json={"name": "Solo", "email": "", "phone": "", "contact_person": "", "address": ""}, headers=api.headers).json()
    assert (body["email"], body["phone"], body["contact_person"], body["address"]) == (None, None, None, None)


@pytest.mark.parametrize("payload", [
    {}, {"name": ""}, {"name": "   "}, {"name": "x" * 256}, {"name": "A", "email": "not-an-email"}, {"name": "A", "email": "a@b"},
    {"name": "A", "phone": "1" * 51}, {"name": "A", "address": "x" * 501}, {"name": "A", "is_active": False},
    {"name": "A", "organization_id": str(uuid.uuid4())}, {"name": "A", "id": str(uuid.uuid4())},
])
def test_invalid_clients_are_rejected(api, payload):
    assert api.client.post(CLIENTS, json=payload, headers=api.headers).status_code == 422
    assert api.client.get(CLIENTS, params={"status": "all"}, headers=api.headers).json()["total"] == 0


def test_a_name_is_unique_within_an_organization_ignoring_case_and_spacing(api, two_orgs):
    api.new_client("Acme Ltd")
    for name in ("acme ltd", "ACME   LTD", " Acme Ltd "):
        response = api.client.post(CLIENTS, json={"name": name}, headers=api.headers)
        assert response.status_code == 409 and "already exists" in response.json()["detail"]
    assert two_orgs["beta"].new_client("Acme Ltd")["name"] == "Acme Ltd"  # another organization may have the same client name


def test_searching_and_filtering(api):
    acme = api.new_client("Acme Ltd", contact_person="Jane Doe", email="jane@acme.example", phone="555-0100")
    api.new_client("Beta GmbH", contact_person="Hans Meyer")
    old = api.new_client("Old Customer")
    api.client.post(f"{CLIENTS}/{old['id']}/deactivate", headers=api.headers)

    def names(**params):
        body = api.client.get(CLIENTS, params=params, headers=api.headers).json()
        return [c["name"] for c in body["items"]], body["total"]

    assert names() == (["Acme Ltd", "Beta GmbH"], 2)  # active only by default, alphabetical
    assert names(status="inactive") == (["Old Customer"], 1)
    assert names(status="all")[1] == 3
    assert names(q="acme") == (["Acme Ltd"], 1) and names(q="MEYER") == (["Beta GmbH"], 1)
    assert names(q="jane@") == (["Acme Ltd"], 1) and names(q="0100") == (["Acme Ltd"], 1)
    assert names(q="%") == ([], 0) and names(q="_") == ([], 0)  # wildcards are matched literally
    assert names(limit=1, offset=1) == (["Beta GmbH"], 2)
    assert api.client.get(f"{CLIENTS}/{acme['id']}", headers=api.headers).json()["name"] == "Acme Ltd"


def test_editing_a_client(api):
    acme, other = api.new_client("Acme Ltd", phone="1"), api.new_client("Other")
    url = f"{CLIENTS}/{acme['id']}"
    edited = api.client.patch(url, json={"name": "Acme International", "phone": None, "email": "ops@acme.example"}, headers=api.headers)
    assert edited.status_code == 200
    assert (edited.json()["name"], edited.json()["phone"], edited.json()["email"]) == ("Acme International", None, "ops@acme.example")
    assert api.client.patch(url, json={"name": "acme   international"}, headers=api.headers).status_code == 200  # itself is not a clash
    assert api.client.patch(url, json={"name": "other"}, headers=api.headers).status_code == 409
    for bad in ({}, {"name": None}, {"name": ""}, {"is_active": False}, {"organization_id": str(uuid.uuid4())}):
        assert api.client.patch(url, json=bad, headers=api.headers).status_code == 422


def test_deactivating_keeps_the_client_and_is_reversible(api):
    acme = api.new_client("Acme Ltd")
    url = f"{CLIENTS}/{acme['id']}"
    off = api.client.post(f"{url}/deactivate", headers=api.headers)
    assert off.status_code == 200 and off.json()["is_active"] is False
    assert api.client.post(f"{url}/deactivate", headers=api.headers).status_code == 200  # idempotent
    assert api.client.get(url, headers=api.headers).json()["is_active"] is False  # still viewable
    assert api.client.post(f"{url}/activate", headers=api.headers).json()["is_active"] is True


def test_a_client_can_never_be_deleted(api):
    acme = api.new_client("Acme Ltd")
    assert api.client.delete(f"{CLIENTS}/{acme['id']}", headers=api.headers).status_code == 405
    assert api.client.get(f"{CLIENTS}/{acme['id']}", headers=api.headers).status_code == 200


def test_unknown_ids_are_404(api):
    for url in (f"{CLIENTS}/{uuid.uuid4()}", f"{CLIENTS}/{uuid.uuid4()}/deactivate"):
        method = api.client.post if url.endswith("deactivate") else api.client.get
        assert method(url, headers=api.headers).status_code == 404
    assert api.client.get(f"{CLIENTS}/not-a-uuid", headers=api.headers).status_code == 422
