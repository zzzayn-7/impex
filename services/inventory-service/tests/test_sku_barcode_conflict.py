"""A SKU and a registered barcode of two different products can never be the same text (Step 15.1 follow-up)."""
import threading
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from conftest import PRODUCTS_URL, product_payload

RESOLVE = "/api/v1/inventory/scan/resolve"


def register(api, product, value, kind="manufacturer"):
    return api.client.post(f"{PRODUCTS_URL}/{product['id']}/identifiers", json={"kind": kind, "value": value}, headers=api.headers)


def create(api, sku, **extra):
    return api.client.post(PRODUCTS_URL, json=product_payload(sku=sku, name=f"Product {sku}", **extra), headers=api.headers)


def test_a_new_product_cannot_take_another_products_barcode_as_its_sku(api):
    bolt = api.product(sku="BOLT", name="Steel bolt")
    assert register(api, bolt, "5901234123457").status_code == 201
    refused = create(api, "5901234123457")
    assert refused.status_code == 409
    assert "already registered as a barcode of Steel bolt (BOLT)" in refused.json()["detail"] and "ambiguous" in refused.json()["detail"]
    assert api.client.get(PRODUCTS_URL, params={"q": "5901234123457"}, headers=api.headers).json()["total"] == 0  # nothing was created


def test_renaming_a_sku_to_another_products_barcode_is_refused_and_nothing_changes(api):
    bolt, nut = api.product(sku="BOLT", name="Steel bolt"), api.product(sku="NUT", name="Nut")
    register(api, bolt, "EAN-1")
    refused = api.client.patch(f"{PRODUCTS_URL}/{nut['id']}", json={"sku": "ean-1"}, headers=api.headers)
    assert refused.status_code == 409 and "barcode" in refused.json()["detail"]
    assert api.client.get(f"{PRODUCTS_URL}/{nut['id']}", headers=api.headers).json()["sku"] == "NUT"


def test_a_retired_barcode_stays_reserved_so_its_text_cannot_become_another_sku(api):
    bolt = api.product(sku="BOLT")
    ident = register(api, bolt, "OLD-EAN").json()
    api.client.post(f"{PRODUCTS_URL}/{bolt['id']}/identifiers/{ident['id']}/retire", headers=api.headers)
    assert create(api, "OLD-EAN").status_code == 409


def test_a_product_may_use_its_own_barcode_text_as_its_sku(api):
    flour = api.product(sku="FLOUR")
    assert register(api, flour, "FLOUR").status_code == 201  # same product: not ambiguous
    assert api.client.patch(f"{PRODUCTS_URL}/{flour['id']}", json={"sku": "FLOUR", "name": "Flour 1kg"}, headers=api.headers).status_code == 200
    body = api.client.get(RESOLVE, params={"code": "FLOUR"}, headers=api.headers)
    assert body.status_code == 200 and body.json()["product"]["id"] == flour["id"]


def test_the_opposite_order_was_and_is_still_refused(api):
    api.product(sku="TAKEN")
    bolt = api.product(sku="BOLT")
    assert register(api, bolt, "taken").status_code == 409


def test_the_same_text_is_fine_in_two_organizations(two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    a = alpha.product(sku="A-1")
    assert register(alpha, a, "SHARED-1").status_code == 201
    assert create(beta, "SHARED-1").status_code == 201  # Beta's catalog is separate


def test_the_scan_no_longer_becomes_ambiguous_through_normal_use(api):
    bolt = api.product(sku="BOLT")
    register(api, bolt, "CLASH-1")
    assert create(api, "CLASH-1").status_code == 409
    assert api.client.get(RESOLVE, params={"code": "CLASH-1"}, headers=api.headers).status_code == 200  # still unambiguous


# --- the database enforces it even when the API is bypassed ----------------------------------------------------------
def test_the_database_refuses_a_conflicting_sku(api, two_orgs, session_factory):
    bolt = api.product(sku="BOLT")
    register(api, bolt, "DB-EAN")
    with session_factory() as db:
        with pytest.raises(DBAPIError) as caught:
            db.execute(text("INSERT INTO products (organization_id, sku, name, unit, cost_price, selling_price, currency_code) "
                            "VALUES (:o, 'DB-EAN', 'x', 'pcs', 1, 1, 'USD')"), {"o": two_orgs["alpha_id"]})
            db.commit()
        assert "already a barcode of another product" in str(caught.value)


def test_the_database_refuses_a_conflicting_barcode(api, two_orgs, session_factory):
    api.product(sku="DB-SKU")
    other = api.product(sku="OTHER")
    with session_factory() as db:
        with pytest.raises(DBAPIError) as caught:
            db.execute(text("INSERT INTO product_identifiers (organization_id, product_id, kind, value, created_by_email) VALUES (:o, :p, 'supplier', 'DB-SKU', 'x@x')"),
                       {"o": two_orgs["alpha_id"], "p": other["id"]})
            db.commit()
        assert "already the SKU of another product" in str(caught.value)


def test_a_race_between_creating_the_sku_and_registering_the_barcode_cannot_produce_both(api, two_orgs, client):
    """Run both requests at the same moment, many times: exactly one of them may win each round."""
    holder = api.product(sku="HOLDER")
    outcomes = []
    for round_ in range(6):
        text_value = f"RACE-{round_}"
        results = {}

        def make_sku():
            results["sku"] = client.post(PRODUCTS_URL, json=product_payload(sku=text_value, name=f"Racer {round_}"), headers=api.headers).status_code

        def make_barcode():
            results["barcode"] = client.post(f"{PRODUCTS_URL}/{holder['id']}/identifiers", json={"kind": "supplier", "value": text_value}, headers=api.headers).status_code

        threads = [threading.Thread(target=make_sku), threading.Thread(target=make_barcode)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        outcomes.append((results["sku"], results["barcode"]))
    assert all(sorted(pair) == [201, 409] for pair in outcomes), outcomes  # never (201, 201): that would be an ambiguous code
