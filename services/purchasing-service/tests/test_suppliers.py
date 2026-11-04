"""Supplier directory: create, view, search, update, deactivate, reactivate."""
import uuid

import pytest
from sqlalchemy import select

from app.models import Supplier

from conftest import SUPPLIERS


def test_creating_a_supplier_hides_the_organization_and_normalizes_input(api, session_factory):
    response = api.client.post(SUPPLIERS, json={
        "name": "  Acme   Supplies  GmbH ", "code": " acme-01 ", "contact_person": " Jane Doe ", "email": " Jane@ACME.example ", "phone": " +49 30 1 ",
        "address": " 1 Main St ", "country_code": "de", "tax_identifier": " DE123456789 "}, headers=api.headers)
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"id", "name", "code", "contact_person", "email", "phone", "address", "country_code", "tax_identifier", "is_active", "created_at", "updated_at"}
    assert (body["name"], body["code"], body["contact_person"], body["email"], body["phone"], body["address"], body["country_code"], body["tax_identifier"], body["is_active"]) == \
           ("Acme Supplies GmbH", "ACME-01", "Jane Doe", "jane@acme.example", "+49 30 1", "1 Main St", "DE", "DE123456789", True)
    with session_factory() as db:
        (row,) = db.scalars(select(Supplier)).all()
    assert str(row.organization_id) == api.org_id and uuid.UUID(body["id"]) == row.id


def test_only_the_name_is_required_and_blanks_become_empty(api):
    body = api.client.post(SUPPLIERS, json={"name": "Solo", "code": "", "email": "", "phone": "", "contact_person": "", "address": "", "country_code": "", "tax_identifier": ""}, headers=api.headers).json()
    assert all(body[f] is None for f in ("code", "email", "phone", "contact_person", "address", "country_code", "tax_identifier"))


@pytest.mark.parametrize("payload", [
    {}, {"name": ""}, {"name": "   "}, {"name": "x" * 256}, {"name": "A", "email": "not-an-email"}, {"name": "A", "phone": "1" * 51},
    {"name": "A", "address": "x" * 501}, {"name": "A", "country_code": "DEU"}, {"name": "A", "country_code": "1"}, {"name": "A", "country_code": "D3"},
    {"name": "A", "code": "has space"}, {"name": "A", "code": "-lead"}, {"name": "A", "code": "x" * 33}, {"name": "A", "tax_identifier": "x" * 51},
    {"name": "A", "is_active": False}, {"name": "A", "organization_id": str(uuid.uuid4())}, {"name": "A", "id": str(uuid.uuid4())},
])
def test_invalid_suppliers_are_rejected(api, payload):
    assert api.client.post(SUPPLIERS, json=payload, headers=api.headers).status_code == 422
    assert api.client.get(SUPPLIERS, params={"status": "all"}, headers=api.headers).json()["total"] == 0


def test_a_name_is_unique_within_an_organization_ignoring_case_and_spacing(api, two_orgs):
    api.supplier("Acme Supplies")
    for name in ("acme supplies", "ACME   SUPPLIES", " Acme Supplies "):
        response = api.client.post(SUPPLIERS, json={"name": name}, headers=api.headers)
        assert response.status_code == 409 and "already exists" in response.json()["detail"]
    assert two_orgs["beta"].supplier("Acme Supplies")["name"] == "Acme Supplies"  # another organization may use the same name


def test_a_supplier_code_is_unique_within_an_organization_but_optional(api, two_orgs):
    api.supplier("One", code="S-1")
    clash = api.client.post(SUPPLIERS, json={"name": "Two", "code": "s-1"}, headers=api.headers)
    assert clash.status_code == 409 and "S-1" in clash.json()["detail"]
    api.supplier("No code A")
    api.supplier("No code B")  # several suppliers without a code are fine
    assert two_orgs["beta"].supplier("Beta one", code="S-1")["code"] == "S-1"  # and another organization may reuse the code


def test_searching_and_filtering(api):
    api.supplier("Acme Supplies", code="AC-1", contact_person="Jane Doe", email="jane@acme.example", phone="555-0100", tax_identifier="DE111")
    api.supplier("Beta Metals", contact_person="Hans Meyer")
    old = api.supplier("Old Vendor")
    api.client.post(f"{SUPPLIERS}/{old['id']}/deactivate", headers=api.headers)

    def names(**params):
        body = api.client.get(SUPPLIERS, params=params, headers=api.headers).json()
        return [s["name"] for s in body["items"]], body["total"]

    assert names() == (["Acme Supplies", "Beta Metals"], 2)  # active only by default, alphabetical
    assert names(status="inactive") == (["Old Vendor"], 1) and names(status="all")[1] == 3
    assert names(q="acme") == (["Acme Supplies"], 1) and names(q="MEYER") == (["Beta Metals"], 1)
    assert names(q="ac-1") == (["Acme Supplies"], 1) and names(q="jane@") == (["Acme Supplies"], 1)
    assert names(q="0100") == (["Acme Supplies"], 1) and names(q="de111") == (["Acme Supplies"], 1)
    assert names(q="%") == ([], 0) and names(q="_") == ([], 0)  # wildcards are matched literally
    assert names(limit=1, offset=1) == (["Beta Metals"], 2)


def test_viewing_and_updating(api):
    acme, other = api.supplier("Acme", code="A-1", phone="1"), api.supplier("Other")
    url = f"{SUPPLIERS}/{acme['id']}"
    assert api.client.get(url, headers=api.headers).json()["name"] == "Acme"
    edited = api.client.patch(url, json={"name": "Acme International", "phone": None, "country_code": "pk", "tax_identifier": "NTN-1"}, headers=api.headers)
    assert edited.status_code == 200
    assert (edited.json()["name"], edited.json()["phone"], edited.json()["country_code"], edited.json()["tax_identifier"], edited.json()["code"]) == ("Acme International", None, "PK", "NTN-1", "A-1")
    assert api.client.patch(url, json={"name": "acme   international", "code": "a-1"}, headers=api.headers).status_code == 200  # itself is not a clash
    assert api.client.patch(url, json={"name": "other"}, headers=api.headers).status_code == 409
    api.client.patch(f"{SUPPLIERS}/{other['id']}", json={"code": "O-1"}, headers=api.headers)
    assert api.client.patch(url, json={"code": "o-1"}, headers=api.headers).status_code == 409
    for bad in ({}, {"name": None}, {"name": ""}, {"is_active": False}, {"organization_id": str(uuid.uuid4())}, {"country_code": "XYZ"}):
        assert api.client.patch(url, json=bad, headers=api.headers).status_code == 422


def test_deactivating_keeps_the_supplier_and_is_reversible(api):
    acme = api.supplier("Acme")
    url = f"{SUPPLIERS}/{acme['id']}"
    off = api.client.post(f"{url}/deactivate", headers=api.headers)
    assert off.status_code == 200 and off.json()["is_active"] is False
    assert api.client.post(f"{url}/deactivate", headers=api.headers).status_code == 200  # idempotent
    assert api.client.get(url, headers=api.headers).json()["is_active"] is False  # still viewable
    assert api.client.post(f"{url}/activate", headers=api.headers).json()["is_active"] is True


def test_a_supplier_can_never_be_deleted(api):
    acme = api.supplier("Acme")
    assert api.client.delete(f"{SUPPLIERS}/{acme['id']}", headers=api.headers).status_code == 405
    assert api.client.get(f"{SUPPLIERS}/{acme['id']}", headers=api.headers).status_code == 200


def test_unknown_ids_are_404(api):
    assert api.client.get(f"{SUPPLIERS}/{uuid.uuid4()}", headers=api.headers).status_code == 404
    assert api.client.post(f"{SUPPLIERS}/{uuid.uuid4()}/deactivate", headers=api.headers).status_code == 404
    assert api.client.get(f"{SUPPLIERS}/not-a-uuid", headers=api.headers).status_code == 422
