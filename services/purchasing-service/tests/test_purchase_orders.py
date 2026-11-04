"""Purchase orders: creating, numbering, duplicate protection, header editing, listing."""
import threading
import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import func, select

from app.models import PurchaseOrder

from conftest import ORDERS, SUPPLIERS


def test_creating_an_order_for_a_supplier(api, session_factory):
    acme = api.supplier("Acme Supplies")
    today = date.today()
    response = api.client.post(ORDERS, json={
        "supplier_id": acme["id"], "currency_code": "eur", "supplier_reference": " QUOTE-9 ", "order_date": today.isoformat(),
        "expected_delivery_date": (today + timedelta(days=14)).isoformat(), "notes": " Deliver to dock 3 "},
        headers={**api.headers, "Idempotency-Key": "create-key-0001"})
    assert response.status_code == 201
    body = response.json()
    assert (body["number"], body["status"], body["currency_code"], body["line_count"], body["total_amount"]) == ("PO-000001", "draft", "EUR", 0, "0")
    assert (body["supplier_reference"], body["notes"]) == ("QUOTE-9", "Deliver to dock 3")
    assert body["supplier"] == {"id": acme["id"], "name": "Acme Supplies", "code": None, "is_active": True}
    assert body["created_by_email"] == "admin-alpha@example.org" and "organization_id" not in body
    with session_factory() as db:
        (row,) = db.scalars(select(PurchaseOrder)).all()
    assert str(row.organization_id) == api.org_id and str(row.supplier_id) == acme["id"]


def test_the_order_date_defaults_to_today(api):
    created = api.order(api.supplier("Acme")["id"])
    assert created["order_date"] == date.today().isoformat() and created["expected_delivery_date"] is None


def test_numbers_count_up_per_organization(two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    a, b = alpha.supplier("S"), beta.supplier("S")
    assert [alpha.order(a["id"])["number"] for _ in range(3)] == ["PO-000001", "PO-000002", "PO-000003"]
    assert beta.order(b["id"])["number"] == "PO-000001"  # a different organization starts at 1 as well


def test_simultaneous_creations_never_share_a_number(api, client):
    acme = api.supplier("Acme")
    numbers, errors = [], []

    def create():
        response = client.post(ORDERS, json={"supplier_id": acme["id"], "currency_code": "USD"}, headers={**api.headers, "Idempotency-Key": f"race-{uuid.uuid4()}"})
        (numbers if response.status_code == 201 else errors).append(response.json().get("number", response.text))

    threads = [threading.Thread(target=create) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert errors == []
    assert sorted(numbers) == [f"PO-{i:06d}" for i in range(1, 11)]


def test_a_failed_creation_leaves_no_gap_in_the_numbers(api):
    acme = api.supplier("Acme")
    api.order(acme["id"])
    bad = api.create_order(str(uuid.uuid4()))  # unknown supplier: fails after the number was reserved inside the transaction
    assert bad.status_code == 404
    assert api.order(acme["id"])["number"] == "PO-000002"


# --- duplicate submissions and retries -----------------------------------------------------------------------------------------
def test_a_retry_with_the_same_key_returns_the_first_order_and_creates_nothing(api, session_factory):
    acme = api.supplier("Acme")
    first = api.create_order(acme["id"], key="retry-key-0001", supplier_reference="R1")
    second = api.create_order(acme["id"], key="retry-key-0001", supplier_reference="R1")
    third = api.create_order(acme["id"], key="retry-key-0001", supplier_reference="R1")
    assert (first.status_code, second.status_code, third.status_code) == (201, 200, 200)
    assert second.json()["id"] == first.json()["id"] == third.json()["id"] and second.json()["number"] == "PO-000001"
    with session_factory() as db:
        assert db.scalar(select(func.count()).select_from(PurchaseOrder)) == 1


def test_reusing_a_key_for_a_different_order_is_refused(api):
    acme = api.supplier("Acme")
    api.create_order(acme["id"], key="reuse-key-0001", supplier_reference="A")
    clash = api.create_order(acme["id"], key="reuse-key-0001", supplier_reference="B")
    assert clash.status_code == 409 and "different request" in clash.json()["detail"]


def test_simultaneous_duplicates_make_one_order(api, client, session_factory):
    acme = api.supplier("Acme")
    codes = []

    def create():
        codes.append(client.post(ORDERS, json={"supplier_id": acme["id"], "currency_code": "USD"}, headers={**api.headers, "Idempotency-Key": "double-click-0001"}).status_code)

    threads = [threading.Thread(target=create) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(codes) == [200] * 5 + [201]
    with session_factory() as db:
        assert db.scalar(select(func.count()).select_from(PurchaseOrder)) == 1


def test_a_failed_attempt_does_not_burn_its_key(api):
    acme = api.supplier("Acme")
    assert api.create_order(str(uuid.uuid4()), key="burn-key-0001").status_code == 404
    assert api.create_order(acme["id"], key="burn-key-0001").status_code == 201  # same key, now it can succeed


def test_the_key_is_required_and_validated(api):
    acme = api.supplier("Acme")
    body = {"supplier_id": acme["id"], "currency_code": "USD"}
    assert api.client.post(ORDERS, json=body, headers=api.headers).status_code == 400
    for bad in ("short", "has space in it", "x" * 101, "bad/chars!"):
        assert api.client.post(ORDERS, json=body, headers={**api.headers, "Idempotency-Key": bad}).status_code == 400
    assert api.client.get(ORDERS, headers=api.headers).json()["total"] == 0


def test_the_same_key_in_two_organizations_is_independent(two_orgs):
    ids = [two_orgs[w].supplier("S")["id"] for w in ("alpha", "beta")]
    codes = [two_orgs[w].create_order(i, key="shared-key-0001").status_code for w, i in zip(("alpha", "beta"), ids)]
    assert codes == [201, 201]


# --- validation ----------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("extra", [
    {"currency_code": "US"}, {"currency_code": "USDX"}, {"currency_code": "12$"}, {"currency_code": ""}, {"order_date": "yesterday"}, {"order_date": "2026-13-45"},
    {"supplier_reference": "x" * 101}, {"notes": "x" * 2001}, {"status": "ordered"}, {"number": "PO-9"}, {"organization_id": str(uuid.uuid4())},
    {"total_amount": "1.00"}, {"created_by": str(uuid.uuid4())},
])
def test_invalid_orders_are_rejected(api, extra):
    acme = api.supplier("Acme")
    body = {"supplier_id": acme["id"], "currency_code": "USD", **extra}
    assert api.client.post(ORDERS, json=body, headers={**api.headers, "Idempotency-Key": f"bad-{uuid.uuid4()}"}).status_code == 422
    assert api.client.get(ORDERS, headers=api.headers).json()["total"] == 0


def test_the_expected_delivery_cannot_be_before_the_order_date(api):
    acme = api.supplier("Acme")
    response = api.create_order(acme["id"], order_date="2026-11-10", expected_delivery_date="2026-11-09")
    assert response.status_code == 422 and "before the order date" in response.json()["detail"]
    assert api.create_order(acme["id"], order_date="2026-11-10", expected_delivery_date="2026-11-10").status_code == 201


def test_an_order_needs_an_existing_active_supplier(api):
    assert api.create_order(str(uuid.uuid4())).status_code == 404
    acme = api.supplier("Acme")
    api.client.post(f"{SUPPLIERS}/{acme['id']}/deactivate", headers=api.headers)
    refused = api.create_order(acme["id"])
    assert refused.status_code == 409 and "inactive" in refused.json()["detail"]
    api.client.post(f"{SUPPLIERS}/{acme['id']}/activate", headers=api.headers)
    assert api.create_order(acme["id"]).status_code == 201


# --- editing the header ----------------------------------------------------------------------------------------------------------------------------
def test_editing_a_drafts_header(api):
    acme, other = api.supplier("Acme"), api.supplier("Other Co")
    created = api.order(acme["id"], supplier_reference="OLD")
    url = f"{ORDERS}/{created['id']}"
    edited = api.client.patch(url, json={"supplier_id": other["id"], "supplier_reference": " NEW ", "expected_delivery_date": "2099-01-01", "notes": "Call first", "currency_code": "gbp"}, headers=api.headers)
    assert edited.status_code == 200
    body = edited.json()
    assert (body["supplier"]["id"], body["supplier_reference"], body["expected_delivery_date"], body["notes"], body["currency_code"]) == (other["id"], "NEW", "2099-01-01", "Call first", "GBP")
    cleared = api.client.patch(url, json={"supplier_reference": "", "expected_delivery_date": None, "notes": None}, headers=api.headers)
    assert (cleared.json()["supplier_reference"], cleared.json()["expected_delivery_date"], cleared.json()["notes"]) == (None, None, None)


@pytest.mark.parametrize("body", [{}, {"supplier_id": None}, {"currency_code": None}, {"order_date": None}, {"currency_code": "EU"}, {"status": "ordered"},
                                   {"number": "PO-9"}, {"organization_id": str(uuid.uuid4())}, {"notes": "x" * 2001}])
def test_invalid_header_edits_are_rejected(api, body):
    created = api.order(api.supplier("Acme")["id"])
    assert api.client.patch(f"{ORDERS}/{created['id']}", json=body, headers=api.headers).status_code == 422


def test_header_edits_keep_the_dates_consistent(api):
    created = api.order(api.supplier("Acme")["id"], order_date="2026-11-10", expected_delivery_date="2026-11-20")
    url = f"{ORDERS}/{created['id']}"
    assert api.client.patch(url, json={"order_date": "2026-11-25"}, headers=api.headers).status_code == 422  # would now be after the delivery date
    assert api.client.patch(url, json={"expected_delivery_date": "2026-11-01"}, headers=api.headers).status_code == 422
    assert api.client.patch(url, json={"order_date": "2026-11-05", "expected_delivery_date": "2026-11-06"}, headers=api.headers).status_code == 200


def test_the_supplier_of_a_draft_can_only_become_an_active_supplier(api):
    acme, dormant = api.supplier("Acme"), api.supplier("Dormant")
    api.client.post(f"{SUPPLIERS}/{dormant['id']}/deactivate", headers=api.headers)
    created = api.order(acme["id"])
    refused = api.client.patch(f"{ORDERS}/{created['id']}", json={"supplier_id": dormant["id"]}, headers=api.headers)
    assert refused.status_code == 409 and "inactive" in refused.json()["detail"]
    assert api.client.patch(f"{ORDERS}/{created['id']}", json={"supplier_id": str(uuid.uuid4())}, headers=api.headers).status_code == 404
    assert api.detail(created["id"])["supplier"]["id"] == acme["id"]


def test_the_currency_cannot_change_once_there_are_lines(api, shop):
    created = api.order(api.supplier("Acme")["id"], currency="USD")
    assert api.client.patch(f"{ORDERS}/{created['id']}", json={"currency_code": "EUR"}, headers=api.headers).status_code == 200  # no lines yet
    api.add(created["id"], shop["bolt"], 10, "1.50")
    refused = api.client.patch(f"{ORDERS}/{created['id']}", json={"currency_code": "USD"}, headers=api.headers)
    assert refused.status_code == 409 and "currency" in refused.json()["detail"].lower()
    assert api.client.patch(f"{ORDERS}/{created['id']}", json={"currency_code": "EUR"}, headers=api.headers).status_code == 200  # unchanged value is fine


# --- listing --------------------------------------------------------------------------------------------------------------------------------------------
def test_viewing_filtering_and_searching_orders(api, shop):
    acme, beta = api.supplier("Acme Supplies"), api.supplier("Beta Metals")
    first = api.order(acme["id"], supplier_reference="QUOTE-ALPHA-1", order_date="2026-01-10")
    second = api.order(acme["id"], supplier_reference="QUOTE-ALPHA-2", order_date="2026-02-10")
    third = api.order(beta["id"], supplier_reference="WEB-77", order_date="2026-03-10")
    api.client.post(f"{ORDERS}/{second['id']}/cancel", headers=api.headers)
    api.add(first["id"], shop["bolt"], 4, "2.5")

    def numbers(**params):
        body = api.client.get(ORDERS, params=params, headers=api.headers).json()
        return [o["number"] for o in body["items"]], body["total"]

    assert numbers() == (["PO-000003", "PO-000002", "PO-000001"], 3)  # newest first
    assert numbers(supplier_id=beta["id"]) == (["PO-000003"], 1)
    assert numbers(status="cancelled") == (["PO-000002"], 1) and numbers(status="draft")[1] == 2
    assert numbers(q="quote-alpha")[1] == 2 and numbers(q="WEB-77") == (["PO-000003"], 1)
    assert numbers(q="po-000001") == (["PO-000001"], 1) and numbers(q="beta metals") == (["PO-000003"], 1)
    assert numbers(q="%") == ([], 0)
    assert numbers(date_from="2026-02-01", date_to="2026-02-28") == (["PO-000002"], 1)
    assert numbers(limit=1, offset=2) == (["PO-000001"], 3)
    assert api.client.get(ORDERS, params={"status": "bogus"}, headers=api.headers).status_code == 422
    listed = api.client.get(ORDERS, headers=api.headers).json()["items"]
    assert {o["number"]: (o["line_count"], o["total_amount"]) for o in listed}["PO-000001"] == (1, "10.0000")


def test_orders_are_never_deleted_and_their_status_is_not_directly_settable(api):
    created = api.order(api.supplier("Acme")["id"])
    assert api.client.delete(f"{ORDERS}/{created['id']}", headers=api.headers).status_code == 405
    assert api.client.put(f"{ORDERS}/{created['id']}", json={}, headers=api.headers).status_code == 405
    assert api.client.patch(f"{ORDERS}/{created['id']}", json={"status": "ordered"}, headers=api.headers).status_code == 422
