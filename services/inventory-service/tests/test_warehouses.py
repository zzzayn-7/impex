"""Warehouse management: create, list, view, edit, archive, restore."""
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.models import Warehouse

from conftest import WAREHOUSES_URL as URL, bearer


def test_creating_a_warehouse_normalizes_and_hides_the_organization(api, two_orgs, session_factory):
    response = api.client.post(URL, json={"code": " main-01 ", "name": "  Main Warehouse ", "address": " 1 Dock Rd, Karachi "}, headers=api.headers)
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"id", "code", "name", "address", "is_active", "created_at", "updated_at", "products_in_stock"}
    assert (body["code"], body["name"], body["address"], body["is_active"], body["products_in_stock"]) == \
           ("MAIN-01", "Main Warehouse", "1 Dock Rd, Karachi", True, 0)
    with session_factory() as db:
        (row,) = db.scalars(select(Warehouse)).all()
    assert str(row.organization_id) == two_orgs["alpha_id"]


def test_the_address_is_optional(api):
    assert api.warehouse("NOADDR")["address"] is None
    blank = api.client.post(URL, json={"code": "BLANK", "name": "Blank", "address": ""}, headers=api.headers)
    assert blank.status_code == 201 and blank.json()["address"] is None


@pytest.mark.parametrize("body", [
    {"name": "No code"}, {"code": "X"}, {"code": "", "name": "Empty"}, {"code": "has space", "name": "Bad"},
    {"code": "A" * 33, "name": "Too long"}, {"code": "OK", "name": ""}, {"code": "OK", "name": "x" * 256},
    {"code": "OK", "name": "Fine", "address": "x" * 501}, {"code": "OK", "name": "Fine", "is_active": False},
])
def test_invalid_warehouses_are_rejected(api, session_factory, body):
    assert api.client.post(URL, json=body, headers=api.headers).status_code == 422
    with session_factory() as db:
        assert db.scalars(select(Warehouse)).all() == []


def test_the_code_is_unique_within_an_organization_ignoring_case(api):
    api.warehouse("MAIN")
    for code in ("MAIN", "main", " Main "):
        response = api.client.post(URL, json={"code": code, "name": "Duplicate"}, headers=api.headers)
        assert response.status_code == 409 and "MAIN" in response.json()["detail"]
    assert api.client.get(URL, headers=api.headers).json()["total"] == 1


def test_two_organizations_may_use_the_same_code(two_orgs):
    two_orgs["alpha"].warehouse("MAIN", "Alpha main")
    two_orgs["beta"].warehouse("MAIN", "Beta main")
    assert [w["name"] for w in two_orgs["alpha"].client.get(URL, headers=bearer("admin-alpha")).json()["items"]] == ["Alpha main"]
    assert [w["name"] for w in two_orgs["beta"].client.get(URL, headers=bearer("admin-beta")).json()["items"]] == ["Beta main"]


def test_listing_searching_and_status_filters(api):
    api.warehouse("MAIN", "Main depot", address="Port Qasim")
    api.warehouse("ANNEX", "Annex")
    old = api.warehouse("OLD", "Old shed")
    api.client.post(f"{URL}/{old['id']}/archive", headers=api.headers)

    def codes(**params):
        body = api.client.get(URL, params=params, headers=api.headers).json()
        return [w["code"] for w in body["items"]], body["total"]

    assert codes() == (["ANNEX", "MAIN"], 2)  # active by default, ordered by code
    assert codes(status="archived") == (["OLD"], 1)
    assert codes(status="all") == (["ANNEX", "MAIN", "OLD"], 3)
    assert codes(q="qasim") == (["MAIN"], 1)  # matches the address too
    assert codes(q="an") == (["ANNEX"], 1)
    assert codes(q="%") == ([], 0)  # a literal percent sign, not a wildcard
    assert codes(limit=1, offset=1) == (["MAIN"], 2)


def test_viewing_and_editing_a_warehouse(api):
    warehouse = api.warehouse("MAIN", "Main", address="Old address")
    url = f"{URL}/{warehouse['id']}"
    assert api.client.get(url, headers=api.headers).json()["code"] == "MAIN"

    edited = api.client.patch(url, json={"name": "Main depot", "address": None}, headers=api.headers)
    assert edited.status_code == 200
    assert (edited.json()["name"], edited.json()["address"], edited.json()["code"]) == ("Main depot", None, "MAIN")

    renamed = api.client.patch(url, json={"code": "hq"}, headers=api.headers)
    assert renamed.json()["code"] == "HQ"
    assert api.client.patch(url, json={"code": "hq"}, headers=api.headers).status_code == 200  # same code is not a clash with itself


def test_editing_rejects_bad_input_and_clashing_codes(api):
    api.warehouse("ONE")
    second = api.warehouse("TWO")
    url = f"{URL}/{second['id']}"
    assert api.client.patch(url, json={"code": "one"}, headers=api.headers).status_code == 409
    assert api.client.patch(url, json={}, headers=api.headers).status_code == 422
    assert api.client.patch(url, json={"name": None}, headers=api.headers).status_code == 422
    assert api.client.patch(url, json={"code": None}, headers=api.headers).status_code == 422
    assert api.client.patch(url, json={"is_active": False}, headers=api.headers).status_code == 422  # only archive/restore do that
    assert api.client.get(url, headers=api.headers).json()["code"] == "TWO"


def test_archiving_and_restoring_keeps_the_warehouse(api, session_factory):
    warehouse = api.warehouse("MAIN")
    url = f"{URL}/{warehouse['id']}"
    archived = api.client.post(f"{url}/archive", headers=api.headers)
    assert archived.status_code == 200 and archived.json()["is_active"] is False
    assert api.client.post(f"{url}/archive", headers=api.headers).status_code == 200  # idempotent
    assert api.client.get(url, headers=api.headers).json()["is_active"] is False  # still viewable
    restored = api.client.post(f"{url}/restore", headers=api.headers)
    assert restored.status_code == 200 and restored.json()["is_active"] is True
    with session_factory() as db:
        assert db.scalar(select(Warehouse.id)) == uuid.UUID(warehouse["id"])


def test_a_warehouse_can_never_be_hard_deleted(api):
    warehouse = api.warehouse("MAIN")
    assert api.client.delete(f"{URL}/{warehouse['id']}", headers=api.headers).status_code == 405
    assert api.client.delete(URL, headers=api.headers).status_code == 405
    assert api.client.get(f"{URL}/{warehouse['id']}", headers=api.headers).status_code == 200


def test_archiving_reports_how_many_products_still_hold_stock(api):
    warehouse, bolt, nut = api.warehouse("MAIN"), api.product(sku="BOLT", name="Bolt"), api.product(sku="NUT", name="Nut")
    api.add(bolt, warehouse, 5)
    api.add(nut, warehouse, 3)
    api.add(nut, warehouse, 3, action="out")
    assert api.client.get(f"{URL}/{warehouse['id']}", headers=api.headers).json()["products_in_stock"] == 1  # only the bolt
    assert api.client.post(f"{URL}/{warehouse['id']}/archive", headers=api.headers).json()["products_in_stock"] == 1


def test_the_database_refuses_to_delete_a_warehouse_with_history(api, session_factory):
    warehouse, product = api.warehouse("MAIN"), api.product()
    api.add(product, warehouse, 1)
    with session_factory() as db:
        with pytest.raises(IntegrityError):
            db.execute(text("DELETE FROM warehouses WHERE id = :id"), {"id": warehouse["id"]})
            db.commit()
