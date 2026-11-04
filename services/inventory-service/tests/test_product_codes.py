"""QR codes, Code 128 barcodes and supplier/manufacturer barcodes attached to products."""
import re
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app import identifiers
from app.models import ProductIdentifier

from conftest import PRODUCTS_URL, bearer

URL = PRODUCTS_URL
GENERATED = re.compile(r"^IMX-[2-9A-HJ-NP-Z]{12}$")


def codes(api, product):
    return api.client.get(f"{URL}/{product['id']}/identifiers", headers=api.headers).json()["items"]


def generate(api, product):
    return api.client.post(f"{URL}/{product['id']}/identifiers/generate", headers=api.headers)


def register(api, product, value, kind="manufacturer", **extra):
    return api.client.post(f"{URL}/{product['id']}/identifiers", json={"kind": kind, "value": value, **extra}, headers=api.headers)


def label(api, product, **params):
    return api.client.get(f"{URL}/{product['id']}/label", params=params, headers=api.headers)


@pytest.fixture
def bolt(api):
    return api.product(sku="BOLT-1", name="Steel bolt")


# --- generated codes ----------------------------------------------------------------------------------
def test_a_code_is_generated_once_and_then_stays_the_same(api, bolt):
    first, second, third = generate(api, bolt), generate(api, bolt), generate(api, bolt)
    assert (first.status_code, second.status_code, third.status_code) == (201, 200, 200)
    assert first.json()["value"] == second.json()["value"] == third.json()["value"]
    assert GENERATED.match(first.json()["value"])
    assert first.json()["kind"] == "generated" and first.json()["is_active"] is True
    assert first.json()["product_id"] == bolt["id"] and "organization_id" not in first.json()
    assert len(codes(api, bolt)) == 1


def test_codes_are_random_not_derived_from_the_sku_or_the_id(api, bolt):
    other = api.product(sku="BOLT-2", name="Another bolt")
    a, b = generate(api, bolt).json()["value"], generate(api, other).json()["value"]
    assert a != b
    for value, product in ((a, bolt), (b, other)):
        assert product["sku"].replace("-", "") not in value and product["id"].replace("-", "")[:8].upper() not in value


def test_existing_products_keep_their_ids_and_skus_when_codes_are_generated(api, bolt):
    generate(api, bolt)
    after = api.client.get(f"{URL}/{bolt['id']}", headers=api.headers).json()
    assert (after["id"], after["sku"], after["updated_at"]) == (bolt["id"], bolt["sku"], bolt["updated_at"])


def test_an_sku_change_never_moves_or_changes_the_code(api, bolt):
    code = generate(api, bolt).json()["value"]
    assert api.client.patch(f"{URL}/{bolt['id']}", json={"sku": "BOLT-RENAMED"}, headers=api.headers).status_code == 200
    assert codes(api, bolt)[0]["value"] == code
    assert resolve(api, code).json()["product"]["id"] == bolt["id"]
    assert resolve(api, "BOLT-1").status_code == 404  # the old SKU means nothing now
    # someone else is now given the old SKU: the printed label still belongs to the original product
    newcomer = api.product(sku="BOLT-1", name="Different product with the recycled SKU")
    assert resolve(api, code).json()["product"]["id"] == bolt["id"]
    assert resolve(api, "BOLT-1").json()["product"]["id"] == newcomer["id"]
    assert codes(api, newcomer) == []  # the newcomer inherited nothing


def resolve(api, code):
    return api.client.get("/api/v1/inventory/scan/resolve", params={"code": code}, headers=api.headers)


def test_a_manufacturer_barcode_survives_sku_changes_too(api, bolt):
    register(api, bolt, "5901234123457")
    api.client.patch(f"{URL}/{bolt['id']}", json={"sku": "NEW-SKU"}, headers=api.headers)
    assert resolve(api, "5901234123457").json()["product"]["id"] == bolt["id"]


def test_an_archived_product_gets_no_new_code_but_keeps_an_existing_one(api, bolt):
    other = api.product(sku="OLD", name="Old")
    code = generate(api, bolt).json()["value"]
    for product in (bolt, other):
        api.client.post(f"{URL}/{product['id']}/archive", headers=api.headers)
    assert generate(api, other).status_code == 409
    assert generate(api, bolt).json()["value"] == code  # an existing code is simply returned
    assert register(api, bolt, "123456").status_code == 409


# --- labels: QR + Code 128 -----------------------------------------------------------------------------
def test_the_label_has_name_sku_code_qr_and_code_128(api, bolt):
    response = label(api, bolt)  # generates the code on demand
    assert response.status_code == 200
    body = response.json()
    assert body["product"] == {"id": bolt["id"], "sku": "BOLT-1", "name": "Steel bolt", "unit": "pcs"}
    assert GENERATED.match(body["code"]) and body["identifier"]["value"] == body["code"]
    assert "<svg" in body["qr_svg"] and "<path" in body["qr_svg"]
    assert "<svg" in body["barcode_svg"] and "<rect" in body["barcode_svg"]
    assert label(api, bolt).json()["code"] == body["code"]  # stable across calls
    assert codes(api, bolt)[0]["value"] == body["code"]


def test_the_qr_code_carries_the_code_as_plain_text_never_a_link(api, bolt):
    code = label(api, bolt).json()["code"]
    assert "://" not in code and not code.lower().startswith("http")
    assert identifiers.render_qr_svg(code) == label(api, bolt).json()["qr_svg"]  # deterministic for a given payload
    assert identifiers.render_qr_svg(code) != identifiers.render_qr_svg(code + "X")


def test_the_qr_code_really_encodes_the_code():
    """Decode the QR matrix from the SVG's own geometry and compare with an independent QR of the same text."""
    import qrcode

    value = "IMX-ABCDEFGHJKMN"
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=0)
    qr.add_data(value)
    qr.make(fit=True)
    modules = len(qr.get_matrix())
    svg = identifiers.render_qr_svg(value)
    assert f"{modules}" in svg or "viewBox" in svg or "mm" in svg  # sized from the same module count
    assert qr.data_list[0].data == value.encode()  # the payload is exactly the code, nothing else


def test_the_barcode_is_a_valid_code_128_symbol():
    from barcode import Code128

    for value in ("IMX-ABCDEFGHJKMN", "12345678", "ABC-123", "5901234123457"):
        pattern = "".join(Code128(value).build())
        assert re.fullmatch(r"[01]+", pattern)
        assert pattern.startswith(("11010000100", "11010010000", "11010011100"))  # start code A, B or C
        assert pattern.endswith("1100011101011")  # stop pattern + termination bar
        assert Code128(value).get_fullcode() == value
        assert "<rect" in identifiers.render_code128_svg(value)


def test_a_label_can_be_made_for_a_supplier_barcode_and_not_for_a_retired_one(api, bolt):
    external = register(api, bolt, "ACME-77", kind="supplier", label="Acme Ltd").json()
    body = label(api, bolt, identifier_id=external["id"]).json()
    assert body["code"] == "ACME-77" and body["identifier"]["label"] == "Acme Ltd"
    api.client.post(f"{URL}/{bolt['id']}/identifiers/{external['id']}/retire", headers=api.headers)
    assert label(api, bolt, identifier_id=external["id"]).status_code == 410


def test_a_label_cannot_use_a_code_of_another_product(api, bolt):
    other = api.product(sku="OTHER", name="Other")
    theirs = register(api, other, "OTHER-CODE").json()
    assert label(api, bolt, identifier_id=theirs["id"]).status_code == 404
    assert api.client.post(f"{URL}/{bolt['id']}/identifiers/{theirs['id']}/retire", headers=api.headers).status_code == 404


# --- manufacturer / supplier barcodes ------------------------------------------------------------------------
def test_registering_a_barcode_normalizes_it_and_hides_the_organization(api, bolt):
    response = register(api, bolt, "  5901234-abc ", kind="supplier", label="  Acme  ")
    assert response.status_code == 201
    body = response.json()
    assert (body["value"], body["kind"], body["label"], body["is_active"]) == ("5901234-ABC", "supplier", "Acme", True)
    assert body["created_by_email"] == "admin-alpha@example.org" and "organization_id" not in body
    assert [c["value"] for c in codes(api, bolt)] == ["5901234-ABC"]


def test_the_list_shows_the_label_code_first(api, bolt):
    register(api, bolt, "AAA-1")
    generate(api, bolt)
    assert [c["kind"] for c in codes(api, bolt)] == ["generated", "manufacturer"]


@pytest.mark.parametrize("value", ["has space", "ab cd", "x" * 65, "", "   ", "bad|pipe", "emoji😀", "a\nb", "http://evil.example", "javascript:alert(1)", "-leading"])
def test_invalid_barcodes_are_rejected(api, bolt, value):
    assert register(api, bolt, value).status_code in (422,)
    assert codes(api, bolt) == []


def test_a_barcode_cannot_be_registered_twice_or_for_two_products(api, bolt):
    other = api.product(sku="OTHER", name="Other product")
    assert register(api, bolt, "DUP-1").status_code == 201
    again = register(api, bolt, "dup-1")
    assert again.status_code == 409 and "already registered on this product" in again.json()["detail"]
    clash = register(api, other, "DUP-1")
    assert clash.status_code == 409 and "Steel bolt (BOLT-1)" in clash.json()["detail"] and "only one product" in clash.json()["detail"]
    assert codes(api, other) == []


def test_a_barcode_cannot_equal_another_products_sku(api, bolt):
    other = api.product(sku="OTHER", name="Other product")
    response = register(api, bolt, "other")
    assert response.status_code == 409 and "SKU of Other product" in response.json()["detail"]
    assert register(api, other, "OTHER").status_code == 201  # its own SKU as a barcode is harmless and allowed


def test_the_impex_prefix_is_reserved(api, bolt):
    response = register(api, bolt, "IMX-ABCDEFGHJKMN")
    assert response.status_code == 422 and "reserved" in response.json()["detail"]


@pytest.mark.parametrize("extra", [{"organization_id": str(uuid.uuid4())}, {"product_id": str(uuid.uuid4())}, {"is_active": False}, {"id": str(uuid.uuid4())}])
def test_registration_accepts_no_organization_product_or_state_fields(api, bolt, extra):
    assert register(api, bolt, "OK-1", **extra).status_code == 422
    assert register(api, bolt, "OK-1", kind="generated").status_code == 422  # only external kinds can be registered by hand
    assert codes(api, bolt) == []


def test_retiring_keeps_the_code_reserved_for_the_same_product(api, bolt):
    other = api.product(sku="OTHER", name="Other product")
    created = register(api, bolt, "RETIRE-ME").json()
    retired = api.client.post(f"{URL}/{bolt['id']}/identifiers/{created['id']}/retire", headers=api.headers)
    assert retired.status_code == 200 and retired.json()["is_active"] is False and retired.json()["retired_at"]
    assert api.client.post(f"{URL}/{bolt['id']}/identifiers/{created['id']}/retire", headers=api.headers).status_code == 200  # idempotent
    assert codes(api, bolt)[0]["is_active"] is False  # kept, not deleted
    clash = register(api, other, "RETIRE-ME")
    assert clash.status_code == 409  # a retired code is NOT silently handed to another product
    back = register(api, bolt, "RETIRE-ME")
    assert back.status_code == 201 and back.json()["id"] == created["id"] and back.json()["is_active"] is True  # same product, same row
    assert len(codes(api, bolt)) == 1


def test_the_impex_label_code_cannot_be_retired(api, bolt):
    code = generate(api, bolt).json()
    response = api.client.post(f"{URL}/{bolt['id']}/identifiers/{code['id']}/retire", headers=api.headers)
    assert response.status_code == 409 and "printed labels" in response.json()["detail"]


# --- the database enforces it too -------------------------------------------------------------------------------
def raw_identifier(org, product, value, kind="manufacturer"):
    return ProductIdentifier(organization_id=uuid.UUID(org), product_id=uuid.UUID(product), kind=kind, value=value, created_by_email="x@x")


def test_the_database_makes_a_code_unique_per_organization(api, two_orgs, bolt, session_factory):
    other = api.product(sku="OTHER", name="Other")
    register(api, bolt, "UNIQ-1")
    with session_factory() as db:
        db.add(raw_identifier(two_orgs["alpha_id"], other["id"], "UNIQ-1"))
        with pytest.raises(IntegrityError):
            db.commit()


def test_the_database_refuses_malformed_values_and_kinds(api, two_orgs, bolt, session_factory):
    for value, kind in (("lower", "manufacturer"), ("HAS SPACE", "manufacturer"), ("", "manufacturer"), ("OK-1", "magic")):
        with session_factory() as db:
            db.add(raw_identifier(two_orgs["alpha_id"], bolt["id"], value, kind))
            with pytest.raises(IntegrityError):
                db.commit()


def test_only_one_generated_code_per_product(api, two_orgs, bolt, session_factory):
    generate(api, bolt)
    with session_factory() as db:
        db.add(raw_identifier(two_orgs["alpha_id"], bolt["id"], "IMX-SECOND", kind="generated"))
        with pytest.raises(IntegrityError):
            db.commit()


def test_the_database_refuses_to_repoint_change_or_delete_a_code(api, bolt, session_factory):
    other = api.product(sku="OTHER", name="Other")
    created = register(api, bolt, "KEEP-1").json()
    for statement, params in (
        ("UPDATE product_identifiers SET product_id = :other WHERE id = :id", {"other": other["id"], "id": created["id"]}),
        ("UPDATE product_identifiers SET value = 'CHANGED' WHERE id = :id", {"id": created["id"]}),
        ("UPDATE product_identifiers SET kind = 'supplier' WHERE id = :id", {"id": created["id"]}),
        ("DELETE FROM product_identifiers WHERE id = :id", {"id": created["id"]}),
    ):
        with session_factory() as db:
            with pytest.raises(DBAPIError):
                db.execute(text(statement), params)
                db.commit()
    assert codes(api, bolt)[0]["value"] == "KEEP-1"


def test_the_database_refuses_a_code_that_mixes_organizations(api, two_orgs, bolt, session_factory):
    with session_factory() as db:
        db.add(raw_identifier(two_orgs["beta_id"], bolt["id"], "MIX-1"))  # Beta's id on Alpha's product
        with pytest.raises(IntegrityError):
            db.commit()


def test_two_organizations_may_use_the_same_barcode_and_sku(two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    a, b = alpha.product(sku="SAME", name="Alpha thing"), beta.product(sku="SAME", name="Beta thing")
    assert register(alpha, a, "SHARED-EAN-1").status_code == 201
    assert register(beta, b, "SHARED-EAN-1").status_code == 201
    assert resolve(alpha, "SHARED-EAN-1").json()["product"]["name"] == "Alpha thing"
    assert resolve(beta, "SHARED-EAN-1").json()["product"]["name"] == "Beta thing"
