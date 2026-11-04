"""Product catalog behavior for a single organization."""
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.main import app
from app.models import Product

from conftest import bearer

URL = "/api/v1/inventory/products"


@pytest.fixture
def acme(directory):
    org = directory.add_organization("Acme Imports")
    directory.add_user("acme-admin", "organization-admin", org)
    return org, bearer("acme-admin")


def payload(**overrides):
    return {
        "sku": "WID-001", "name": "Widget", "description": "A very fine widget", "category": "Hardware", "unit": "pcs",
        "hs_code": "8479.89", "cost_price": "10.50", "selling_price": "15.99", "currency_code": "USD", **overrides,
    }


def create(client, headers, **overrides):
    response = client.post(URL, json=payload(**overrides), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def skus(response):
    return [p["sku"] for p in response.json()["items"]]


# --- create -------------------------------------------------------------------
def test_create_returns_the_product_and_stores_it_for_the_callers_organization(client, acme, session_factory):
    org, headers = acme
    response = client.post(URL, json=payload(sku=" wid-001 ", currency_code="usd"), headers=headers)
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"id", "sku", "name", "description", "category", "unit", "hs_code", "cost_price", "selling_price",
                         "currency_code", "is_active", "created_at", "updated_at", "unit_allows_fractions"}  # organization_id is never exposed
    assert (body["sku"], body["currency_code"], body["is_active"]) == ("WID-001", "USD", True)  # normalized
    assert (body["name"], body["category"], body["unit"], body["hs_code"]) == ("Widget", "Hardware", "pcs", "8479.89")
    with session_factory() as db:
        (row,) = db.scalars(select(Product)).all()
        assert str(row.organization_id) == org  # taken from the authenticated user, not from the request


def test_optional_fields_can_be_omitted_or_blank(client, acme):
    _, headers = acme
    minimal = {k: v for k, v in payload().items() if k not in ("description", "hs_code")}
    body = client.post(URL, json=minimal, headers=headers).json()
    assert body["description"] is None and body["hs_code"] is None
    blank = client.post(URL, json=payload(sku="B-1", description="", hs_code="  "), headers=headers).json()
    assert blank["description"] is None and blank["hs_code"] is None


def test_prices_are_exact_decimals_not_floats(client, acme, engine):
    _, headers = acme
    body = create(client, headers, cost_price="0.1", selling_price="0.2")
    assert (body["cost_price"], body["selling_price"]) == ("0.1000", "0.2000")  # strings: no binary rounding
    assert Decimal(body["cost_price"]) + Decimal(body["selling_price"]) == Decimal("0.3")  # 0.1 + 0.2 == 0.3 exactly
    big = create(client, headers, sku="BIG", cost_price="9999999999.9999", selling_price="0.0001")
    assert (big["cost_price"], big["selling_price"]) == ("9999999999.9999", "0.0001")
    assert client.get(f"{URL}/{big['id']}", headers=headers).json()["cost_price"] == "9999999999.9999"
    with engine.connect() as conn:
        from sqlalchemy import text
        types = conn.execute(text("SELECT column_name, data_type, numeric_precision, numeric_scale FROM information_schema.columns "
                                  "WHERE table_name = 'products' AND column_name IN ('cost_price', 'selling_price')")).all()
    assert {(t.data_type, t.numeric_precision, t.numeric_scale) for t in types} == {("numeric", 14, 4)}


@pytest.mark.parametrize("overrides", [
    {"cost_price": "-1"}, {"selling_price": "-0.01"}, {"cost_price": "1.23456"}, {"selling_price": "12345678901"},
    {"cost_price": "abc"}, {"cost_price": None}, {"currency_code": "US"}, {"currency_code": "USDX"}, {"currency_code": "12A"},
    {"sku": ""}, {"sku": "has space"}, {"sku": "bad#sku"}, {"sku": "X" * 65}, {"name": ""}, {"name": "N" * 256},
    {"category": ""}, {"unit": ""}, {"unit": "U" * 21}, {"hs_code": "12"}, {"hs_code": "abcd"}, {"description": "D" * 2001},
    {"organization_id": "00000000-0000-4000-8000-000000000000"}, {"stock": 5}, {"quantity": 10},
])
def test_invalid_products_are_rejected_and_nothing_is_stored(client, acme, session_factory, overrides):
    _, headers = acme
    response = client.post(URL, json=payload(**overrides), headers=headers)
    assert response.status_code == 422
    with session_factory() as db:
        assert db.scalars(select(Product)).all() == []


def test_missing_required_fields_are_rejected(client, acme):
    _, headers = acme
    for field in ("sku", "name", "category", "unit", "cost_price", "selling_price", "currency_code"):
        body = payload()
        del body[field]
        assert client.post(URL, json=body, headers=headers).status_code == 422, field


def test_valid_hs_codes_are_accepted(client, acme):
    _, headers = acme
    for index, code in enumerate(["8517", "8517.12", "8517.12.00", "85171200", "8517.12.00.10"]):
        assert client.post(URL, json=payload(sku=f"HS-{index}", hs_code=code), headers=headers).status_code == 201, code


# --- SKU uniqueness (per organization) -------------------------------------------
def test_a_duplicate_sku_in_the_same_catalog_is_rejected(client, acme, session_factory):
    _, headers = acme
    create(client, headers)
    for sku in ("WID-001", "wid-001", " Wid-001 "):
        response = client.post(URL, json=payload(sku=sku, name="Other"), headers=headers)
        assert response.status_code == 409 and "WID-001" in response.json()["detail"]
    with session_factory() as db:
        assert len(db.scalars(select(Product)).all()) == 1


def test_simultaneous_creates_with_the_same_sku_produce_exactly_one_product(client, acme, session_factory):
    _, headers = acme

    def call(_):
        with TestClient(app) as c:
            return c.post(URL, json=payload(), headers=headers).status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        statuses = sorted(pool.map(call, range(6)))
    assert statuses == [201, 409, 409, 409, 409, 409]
    with session_factory() as db:
        assert len(db.scalars(select(Product)).all()) == 1


# --- list, search, filter ---------------------------------------------------------
@pytest.fixture
def catalog(client, acme):
    _, headers = acme
    create(client, headers, sku="BOLT-10", name="Steel bolt", category="Hardware", description="M10 hex bolt", hs_code="7318.15")
    create(client, headers, sku="NUT-10", name="Steel nut", category="Hardware", description="M10 hex nut")
    create(client, headers, sku="CAB-USB", name="USB cable", category="Electronics", description="1 m cable", hs_code="8544.42")
    create(client, headers, sku="PHN-01", name="Phone case", category="Electronics", description="Silicone")
    create(client, headers, sku="BOX-S", name="Small box", category="Packaging", description="Cardboard, 100% recycled_paper")
    return headers


def test_list_returns_the_catalog_ordered_by_name_with_a_total(client, catalog):
    body = client.get(URL, headers=catalog).json()
    assert body["total"] == 5 and body["limit"] == 50 and body["offset"] == 0
    assert [p["name"] for p in body["items"]] == ["Phone case", "Small box", "Steel bolt", "Steel nut", "USB cable"]


@pytest.mark.parametrize("term,expected", [
    ("bolt", ["BOLT-10"]), ("BOLT", ["BOLT-10"]), ("nut-1", ["NUT-10"]), ("hex", ["BOLT-10", "NUT-10"]),
    ("electronics", ["CAB-USB", "PHN-01"]), ("8544", ["CAB-USB"]), ("cardboard", ["BOX-S"]), ("  steel  ", ["BOLT-10", "NUT-10"]),
    ("nothing-matches", []),
])
def test_search_looks_in_sku_name_description_category_and_hs_code(client, catalog, term, expected):
    assert sorted(skus(client.get(URL, params={"q": term}, headers=catalog))) == expected


def test_search_treats_percent_and_underscore_literally(client, catalog):
    assert skus(client.get(URL, params={"q": "100%"}, headers=catalog)) == ["BOX-S"]
    assert skus(client.get(URL, params={"q": "recycled_paper"}, headers=catalog)) == ["BOX-S"]
    assert client.get(URL, params={"q": "%"}, headers=catalog).json()["total"] == 1  # not "match everything"
    assert client.get(URL, params={"q": "_"}, headers=catalog).json()["total"] == 1


def test_category_filter_is_case_insensitive_and_combines_with_search(client, catalog):
    assert sorted(skus(client.get(URL, params={"category": "electronics"}, headers=catalog))) == ["CAB-USB", "PHN-01"]
    assert skus(client.get(URL, params={"category": "Electronics", "q": "usb"}, headers=catalog)) == ["CAB-USB"]
    assert client.get(URL, params={"category": "Hardware", "q": "usb"}, headers=catalog).json()["total"] == 0


def test_pagination_reports_the_full_total(client, catalog):
    first = client.get(URL, params={"limit": 2, "offset": 0}, headers=catalog).json()
    second = client.get(URL, params={"limit": 2, "offset": 2}, headers=catalog).json()
    last = client.get(URL, params={"limit": 2, "offset": 4}, headers=catalog).json()
    assert [first["total"], second["total"], last["total"]] == [5, 5, 5]
    assert [len(first["items"]), len(second["items"]), len(last["items"])] == [2, 2, 1]
    all_ids = [p["id"] for page in (first, second, last) for p in page["items"]]
    assert len(set(all_ids)) == 5


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 201}, {"offset": -1}, {"status": "deleted"}, {"q": "x" * 101}])
def test_bad_query_parameters_are_rejected(client, catalog, params):
    assert client.get(URL, params=params, headers=catalog).status_code == 422


def test_categories_lists_the_distinct_categories(client, catalog):
    assert client.get("/api/v1/inventory/categories", headers=catalog).json() == ["Electronics", "Hardware", "Packaging"]


# --- view and update ------------------------------------------------------------------
def test_view_one_product(client, acme):
    _, headers = acme
    product = create(client, headers)
    assert client.get(f"{URL}/{product['id']}", headers=headers).json() == product
    assert client.get(f"{URL}/00000000-0000-4000-8000-000000000000", headers=headers).status_code == 404
    assert client.get(f"{URL}/not-a-uuid", headers=headers).status_code == 422


def test_update_changes_only_the_fields_sent(client, acme):
    _, headers = acme
    product = create(client, headers)
    response = client.patch(f"{URL}/{product['id']}", json={"name": "Widget Mk II", "selling_price": "17.25"}, headers=headers)
    assert response.status_code == 200
    updated = response.json()
    assert (updated["name"], updated["selling_price"]) == ("Widget Mk II", "17.2500")
    for unchanged in ("sku", "description", "category", "unit", "hs_code", "cost_price", "currency_code", "created_at"):
        assert updated[unchanged] == product[unchanged], unchanged
    assert updated["updated_at"] > product["updated_at"]


def test_update_can_clear_optional_fields_and_change_the_sku(client, acme):
    _, headers = acme
    product = create(client, headers)
    updated = client.patch(f"{URL}/{product['id']}", json={"description": None, "hs_code": "", "sku": "wid-002"}, headers=headers).json()
    assert (updated["description"], updated["hs_code"], updated["sku"]) == (None, None, "WID-002")


def test_update_cannot_take_another_products_sku(client, acme):
    _, headers = acme
    first, second = create(client, headers, sku="A-1"), create(client, headers, sku="A-2")
    assert client.patch(f"{URL}/{second['id']}", json={"sku": "a-1"}, headers=headers).status_code == 409
    assert client.patch(f"{URL}/{second['id']}", json={"sku": "A-2"}, headers=headers).status_code == 200  # its own SKU is fine
    assert client.get(f"{URL}/{second['id']}", headers=headers).json()["sku"] == "A-2"


@pytest.mark.parametrize("body", [
    {}, {"name": None}, {"name": ""}, {"cost_price": "-5"}, {"cost_price": None}, {"currency_code": "EURO"}, {"is_active": None},
    {"organization_id": "00000000-0000-4000-8000-000000000000"}, {"id": "00000000-0000-4000-8000-000000000000"}, {"created_at": "2020-01-01T00:00:00Z"},
])
def test_invalid_updates_are_rejected_and_change_nothing(client, acme, body):
    _, headers = acme
    product = create(client, headers)
    assert client.patch(f"{URL}/{product['id']}", json=body, headers=headers).status_code == 422
    assert client.get(f"{URL}/{product['id']}", headers=headers).json() == product


# --- archive / restore ---------------------------------------------------------------
def test_archiving_hides_a_product_from_the_default_list_without_erasing_it(client, acme, session_factory):
    _, headers = acme
    keep, gone = create(client, headers, sku="KEEP"), create(client, headers, sku="GONE")
    archived = client.post(f"{URL}/{gone['id']}/archive", headers=headers)
    assert archived.status_code == 200 and archived.json()["is_active"] is False
    assert skus(client.get(URL, headers=headers)) == ["KEEP"]
    assert skus(client.get(URL, params={"status": "archived"}, headers=headers)) == ["GONE"]
    assert sorted(skus(client.get(URL, params={"status": "all"}, headers=headers))) == ["GONE", "KEEP"]
    assert client.get(f"{URL}/{gone['id']}", headers=headers).json()["name"] == "Widget"  # still viewable
    with session_factory() as db:
        assert len(db.scalars(select(Product)).all()) == 2  # nothing deleted
    assert client.post(f"{URL}/{gone['id']}/archive", headers=headers).status_code == 200  # idempotent


def test_a_product_can_be_restored_and_edited_while_archived(client, acme):
    _, headers = acme
    product = create(client, headers)
    client.post(f"{URL}/{product['id']}/archive", headers=headers)
    assert client.patch(f"{URL}/{product['id']}", json={"name": "Renamed while archived"}, headers=headers).status_code == 200
    restored = client.post(f"{URL}/{product['id']}/restore", headers=headers)
    assert restored.json()["is_active"] is True and restored.json()["name"] == "Renamed while archived"
    assert skus(client.get(URL, headers=headers)) == ["WID-001"]


def test_health_is_public(client):
    assert client.get("/health").status_code == 200
    assert client.get("/api/v1/inventory/health").json()["service"] == "inventory-service"
