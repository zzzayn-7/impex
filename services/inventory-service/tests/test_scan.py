"""Resolving a scanned code to a product: secure, tenant-scoped, read-only."""
import uuid

import pytest
from sqlalchemy import func, select

from app.models import Product, StockBalance, StockMovement, StockOperation

from conftest import PRODUCTS_URL, STOCK_URL, bearer

RESOLVE = "/api/v1/inventory/scan/resolve"


def resolve(api, code):
    return api.client.get(RESOLVE, params={"code": code}, headers=api.headers)


def generate(api, product):
    return api.client.post(f"{PRODUCTS_URL}/{product['id']}/identifiers/generate", headers=api.headers).json()["value"]


def register(api, product, value, kind="manufacturer"):
    response = api.client.post(f"{PRODUCTS_URL}/{product['id']}/identifiers", json={"kind": kind, "value": value}, headers=api.headers)
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def shop(api):
    """A bolt (pieces) in two warehouses, one of them archived, and flour (kg) in one."""
    bolt, flour = api.product(sku="BOLT-1", name="Steel bolt", unit="pcs"), api.product(sku="FLOUR", name="Flour", unit="kg")
    main, annex = api.warehouse("MAIN", "Main depot"), api.warehouse("ANNEX", "Annex")
    api.add(bolt, main, 40)
    api.add(bolt, annex, 10)
    api.add(flour, main, "2.5")
    api.client.post(f"/api/v1/inventory/warehouses/{annex['id']}/archive", headers=api.headers)
    return {"bolt": bolt, "flour": flour, "main": main, "annex": annex}


# --- finding the product -------------------------------------------------------------------------------------
def test_the_generated_qr_code_value_resolves_to_its_product(api, shop):
    code = generate(api, shop["bolt"])
    response = resolve(api, code)
    assert response.status_code == 200
    body = response.json()
    assert (body["matched_by"], body["identifier_kind"]) == ("identifier", "generated")
    assert body["product"]["id"] == shop["bolt"]["id"] and body["product"]["sku"] == "BOLT-1"


def test_a_manufacturer_or_supplier_barcode_resolves(api, shop):
    register(api, shop["bolt"], "5901234123457", kind="manufacturer")
    register(api, shop["flour"], "SUP-9981", kind="supplier")
    one, two = resolve(api, "5901234123457").json(), resolve(api, "SUP-9981").json()
    assert (one["identifier_kind"], one["product"]["sku"]) == ("manufacturer", "BOLT-1")
    assert (two["identifier_kind"], two["product"]["sku"]) == ("supplier", "FLOUR")


def test_a_sku_resolves_too(api, shop):
    body = resolve(api, "bolt-1").json()
    assert (body["matched_by"], body["identifier_kind"], body["product"]["id"]) == ("sku", None, shop["bolt"]["id"])


@pytest.mark.parametrize("decorate", [str.lower, lambda c: f"  {c}  ", lambda c: f"{c}\r", lambda c: f"{c}\r\n", lambda c: f"\t{c}\n"])
def test_scanner_decoration_is_tolerated(api, shop, decorate):
    code = generate(api, shop["bolt"])
    assert resolve(api, decorate(code)).json()["product"]["id"] == shop["bolt"]["id"]


def test_the_result_carries_product_details_and_current_stock(api, shop):
    body = resolve(api, "BOLT-1").json()
    product, stock = body["product"], body["stock"]
    assert (product["name"], product["unit"], product["unit_allows_fractions"], product["unit_locked"]) == ("Steel bolt", "pcs", False, True)
    assert "organization_id" not in str(body)
    assert stock["total_quantity"] == "50.0000"
    assert stock["available_quantity"] == "40.0000"  # the archived warehouse's 10 is not available
    assert {(l["warehouse_code"], l["quantity"], l["warehouse_active"]) for l in stock["lines"]} == {("MAIN", "40.0000", True), ("ANNEX", "10.0000", False)}
    flour = resolve(api, "FLOUR").json()
    assert flour["product"]["unit_allows_fractions"] is True and flour["stock"]["total_quantity"] == "2.5000"


def test_a_product_with_no_stock_resolves_with_zero(api):
    api.product(sku="NEW", name="Brand new")
    stock = resolve(api, "NEW").json()["stock"]
    assert stock["total_quantity"] == "0" and stock["available_quantity"] == "0" and stock["lines"] == []


# --- unknown, invalid, retired, archived, ambiguous ---------------------------------------------------------------
def test_an_unknown_code_is_a_404_with_no_hint(api, shop):
    response = resolve(api, "NOT-A-PRODUCT")
    assert response.status_code == 404 and response.json() == {"detail": "No product in your catalog matches this code."}


@pytest.mark.parametrize("code", ["   ", "has space", "x" * 65, "bad|pipe", "emoji😀", "a\u0000b", "a\u001bb", "' OR 1=1 --", "<script>"])
def test_invalid_codes_are_422(api, shop, code):
    assert resolve(api, code).status_code == 422


@pytest.mark.parametrize("payload", ["http://evil.example/x", "https://evil.example", "HTTP://EVIL", "javascript:alert(1)", "data:text/html,hi", "ftp://x/y"])
def test_a_link_in_a_qr_code_is_refused_as_text_and_never_followed(api, directory, shop, payload):
    directory.org_calls.clear()
    response = resolve(api, payload)
    assert response.status_code == 422
    assert "web link" in response.json()["detail"] and "never opened" in response.json()["detail"]
    assert len(directory.org_calls) == 1  # only the usual tenant check: no request was made towards the payload


def test_a_retired_barcode_is_410_unless_a_sku_claims_it(api, shop):
    created = register(api, shop["bolt"], "OLD-EAN")
    api.client.post(f"{PRODUCTS_URL}/{shop['bolt']['id']}/identifiers/{created['id']}/retire", headers=api.headers)
    gone = resolve(api, "OLD-EAN")
    assert gone.status_code == 410 and "retired" in gone.json()["detail"]
    api.product(sku="OLD-EAN", name="Now a SKU")
    assert resolve(api, "OLD-EAN").json()["product"]["name"] == "Now a SKU"


def test_an_archived_product_is_returned_flagged_not_hidden(api, shop):
    code = generate(api, shop["bolt"])
    api.client.post(f"{PRODUCTS_URL}/{shop['bolt']['id']}/archive", headers=api.headers)
    body = resolve(api, code).json()
    assert body["product"]["is_active"] is False and body["stock"]["is_active"] is False
    assert body["stock"]["total_quantity"] == "50.0000"  # still reports what is there
    # ...and stock cannot be changed for it (the existing rule)
    refused = api.change("in", product_id=shop["bolt"]["id"], warehouse_id=shop["main"]["id"], quantity="1")
    assert refused.status_code == 409 and "archived" in refused.json()["detail"]


def test_a_code_that_would_mean_two_products_is_refused_not_guessed(api, shop):
    register(api, shop["bolt"], "AMBIG-1")
    api.product(sku="AMBIG-1", name="Created later with that code as its SKU")  # now barcode of A == SKU of B
    response = resolve(api, "AMBIG-1")
    assert response.status_code == 409 and "more than one product" in response.json()["detail"]
    assert resolve(api, generate(api, shop["bolt"])).status_code == 200  # the unambiguous routes still work


def test_the_same_product_via_barcode_and_sku_is_not_ambiguous(api, shop):
    register(api, shop["flour"], "flour")  # barcode equal to its OWN sku
    body = resolve(api, "FLOUR").json()
    assert body["product"]["id"] == shop["flour"]["id"] and body["matched_by"] == "identifier"


# --- reading changes nothing -----------------------------------------------------------------------------------
def counts(session_factory):
    with session_factory() as db:
        return {
            "movements": db.scalar(select(func.count()).select_from(StockMovement)),
            "balances": sorted(db.scalars(select(StockBalance.quantity))),
            "operations": db.scalar(select(func.count()).select_from(StockOperation)),
            "products": sorted((p.id, p.updated_at, p.is_active, p.unit) for p in db.scalars(select(Product))),
        }


def test_scanning_never_changes_inventory(api, shop, session_factory):
    code = generate(api, shop["bolt"])
    before = counts(session_factory)
    for _ in range(5):
        for scanned in (code, "BOLT-1", "FLOUR", "nope", "http://x.y/z"):
            resolve(api, scanned)
    assert counts(session_factory) == before


def test_repeated_scans_give_identical_answers(api, shop):
    code = generate(api, shop["bolt"])
    first = resolve(api, code).json()
    assert all(resolve(api, code).json() == first for _ in range(5))


def test_the_org_id_is_not_an_input(api, shop, two_orgs):
    mine = resolve(api, "BOLT-1")
    sneaky = api.client.get(RESOLVE, params={"code": "BOLT-1", "organization_id": two_orgs["beta_id"]},
                            headers={**api.headers, "X-Organization-Id": two_orgs["beta_id"]})
    assert mine.json() == sneaky.json()


# --- scan -> stock operation uses the existing, idempotent stock API ------------------------------------------------
def test_a_scanned_product_can_be_stocked_through_the_existing_api_and_is_audited(api, shop):
    scanned = resolve(api, generate(api, shop["bolt"])).json()
    body = dict(product_id=scanned["product"]["id"], warehouse_id=shop["main"]["id"], quantity="5", reason="Scanned delivery")
    first = api.change("in", key="scan-op-key-0001", **body)
    again = api.change("in", key="scan-op-key-0001", **body)  # double tap / retry
    assert (first.status_code, again.status_code, again.json()["replayed"]) == (201, 200, True)
    assert resolve(api, "BOLT-1").json()["stock"]["total_quantity"] == "55.0000"  # applied once
    latest = api.movements(product_id=shop["bolt"]["id"])["items"][0]
    assert (latest["reason"], latest["created_by_email"], latest["movement_type"]) == ("Scanned delivery", "admin-alpha@example.org", "in")


def test_the_scan_result_enforces_the_quantity_rules_on_the_next_step(api, shop):
    scanned = resolve(api, "BOLT-1").json()["product"]
    fraction = api.change("in", product_id=scanned["id"], warehouse_id=shop["main"]["id"], quantity="1.5")
    too_much = api.change("out", product_id=scanned["id"], warehouse_id=shop["main"]["id"], quantity="41")
    assert (fraction.status_code, too_much.status_code) == (422, 409)
    assert resolve(api, "BOLT-1").json()["stock"]["total_quantity"] == "50.0000"


# --- two organizations ---------------------------------------------------------------------------------------------
@pytest.fixture
def world(two_orgs):
    """Both organizations use the SAME sku and the SAME manufacturer barcode for different products."""
    data = {}
    for who in ("alpha", "beta"):
        org = two_orgs[who]
        product = org.product(sku="SHARED-SKU", name=f"{who} gadget", category=f"{who}-cat")
        other = org.product(sku=f"{who.upper()}-ONLY", name=f"{who} exclusive")
        warehouse = org.warehouse("MAIN", f"{who} depot")
        org.add(product, warehouse, 7 if who == "alpha" else 99)
        register(org, product, "SHARED-EAN-13")
        data[who] = {"product": product, "other": other, "warehouse": warehouse, "label": generate(org, product), "other_label": generate(org, other)}
    return data


def test_the_same_sku_and_barcode_resolve_to_each_organizations_own_product(two_orgs, world):
    for who, other in (("alpha", "beta"), ("beta", "alpha")):
        org = two_orgs[who]
        for code in ("SHARED-SKU", "SHARED-EAN-13", world[who]["label"]):
            body = resolve(org, code).json()
            assert body["product"]["id"] == world[who]["product"]["id"], (who, code)
            assert body["stock"]["total_quantity"] == ("7.0000" if who == "alpha" else "99.0000")
            assert other not in str(body).lower()


def test_one_organization_cannot_resolve_the_others_codes_or_skus(two_orgs, world):
    alpha = two_orgs["alpha"]
    for code in (world["beta"]["label"], world["beta"]["other_label"], "BETA-ONLY"):
        response = resolve(alpha, code)
        assert response.status_code == 404 and response.json() == {"detail": "No product in your catalog matches this code."}, code
    unknown = resolve(alpha, "ZZZ-UNKNOWN")
    assert resolve(alpha, world["beta"]["label"]).json() == unknown.json()  # indistinguishable from a code that does not exist


def test_labels_and_code_lists_of_another_organization_are_404(two_orgs, world):
    alpha, theirs = two_orgs["alpha"], world["beta"]
    pid = theirs["product"]["id"]
    ident = two_orgs["beta"].client.get(f"{PRODUCTS_URL}/{pid}/identifiers", headers=two_orgs["beta"].headers).json()["items"][0]
    attempts = [
        alpha.client.get(f"{PRODUCTS_URL}/{pid}/identifiers", headers=alpha.headers),
        alpha.client.get(f"{PRODUCTS_URL}/{pid}/label", headers=alpha.headers),
        alpha.client.post(f"{PRODUCTS_URL}/{pid}/identifiers/generate", headers=alpha.headers),
        alpha.client.post(f"{PRODUCTS_URL}/{pid}/identifiers", json={"kind": "supplier", "value": "STOLEN-1"}, headers=alpha.headers),
        alpha.client.post(f"{PRODUCTS_URL}/{pid}/identifiers/{ident['id']}/retire", headers=alpha.headers),
        alpha.client.get(f"{PRODUCTS_URL}/{world['alpha']['product']['id']}/label", params={"identifier_id": ident["id"]}, headers=alpha.headers),
    ]
    assert [a.status_code for a in attempts] == [404] * 6
    assert all("beta" not in a.text.lower() for a in attempts)
    assert two_orgs["beta"].client.get(f"{PRODUCTS_URL}/{pid}/identifiers", headers=two_orgs["beta"].headers).json()["items"][0]["is_active"] is True


def test_nothing_of_the_other_organization_changes_or_leaks_through_codes(two_orgs, world, session_factory):
    before = counts(session_factory)
    alpha = two_orgs["alpha"]
    for code in ("SHARED-SKU", "SHARED-EAN-13", world["beta"]["label"], "BETA-ONLY"):
        resolve(alpha, code)
    assert counts(session_factory) == before


# --- who may use the scan endpoints ---------------------------------------------------------------------------------
PID = str(uuid.uuid4())
ENDPOINTS = [
    ("get", f"{RESOLVE}?code=ABC", None),
    ("get", f"{PRODUCTS_URL}/{PID}/identifiers", None),
    ("post", f"{PRODUCTS_URL}/{PID}/identifiers/generate", None),
    ("post", f"{PRODUCTS_URL}/{PID}/identifiers", {"kind": "supplier", "value": "ABC-1"}),
    ("get", f"{PRODUCTS_URL}/{PID}/label", None),
]


def call(client, method, url, body, headers):
    return getattr(client, method)(url, headers=headers, **({"json": body} if body else {}))


@pytest.mark.parametrize("method,url,body", ENDPOINTS)
def test_anonymous_and_invalid_tokens_are_rejected(client, method, url, body):
    assert call(client, method, url, body, {}).status_code == 401
    assert call(client, method, url, body, bearer("nonsense")).status_code == 401


@pytest.mark.parametrize("method,url,body", ENDPOINTS)
def test_super_admins_orphans_and_disabled_users_are_refused(client, directory, method, url, body):
    org = directory.add_organization("Alpha")
    directory.add_user("super", "super-admin")
    directory.add_user("orphan", "organization-admin", None)
    directory.add_user("disabled", "organization-admin", org, is_active=False)
    for token in ("super", "orphan", "disabled"):
        assert call(client, method, url, body, bearer(token)).status_code == 403, token


@pytest.mark.parametrize("method,url,body", ENDPOINTS)
def test_an_inactive_organization_is_refused_and_an_outage_fails_closed(client, directory, method, url, body):
    org = directory.add_organization("Dormant", active=False)
    directory.add_user("dormant", "organization-admin", org)
    assert call(client, method, url, body, bearer("dormant")).status_code == 403
    live = directory.add_organization("Live")
    directory.add_user("live", "organization-admin", live)
    directory.org_mode = "down"
    assert call(client, method, url, body, bearer("live")).status_code == 503
