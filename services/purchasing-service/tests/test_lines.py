"""Product lines: validation against the Inventory Service, exact money, editing."""
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.models import PurchaseOrderLine

from conftest import ORDERS


@pytest.fixture
def draft(api, shop):
    return api.order(api.supplier("Acme Supplies")["id"], currency="USD")


def line_url(draft, line_id):
    return f"{ORDERS}/{draft['id']}/lines/{line_id}"


def test_adding_a_product_takes_its_details_from_the_inventory_service(api, shop, draft, session_factory):
    response = api.add(draft["id"], shop["bolt"], 50, "1.25")
    assert response.status_code == 201
    body = response.json()
    line = body["line"]
    assert (line["product_id"], line["product_sku"], line["product_name"], line["unit"]) == (shop["bolt"], "BOLT-1", "Steel bolt", "pcs")
    assert (line["quantity"], line["unit_price"], line["line_total"]) == ("50.0000", "1.2500", "62.5000")
    assert (body["line_count"], body["total_amount"], body["currency_code"]) == (1, "62.5000", "USD")
    with session_factory() as db:
        (row,) = db.scalars(select(PurchaseOrderLine)).all()
    assert str(row.organization_id) == api.org_id and (row.product_sku, row.product_name, row.unit) == ("BOLT-1", "Steel bolt", "pcs")


def test_several_products_and_the_order_total(api, shop, draft):
    api.add(draft["id"], shop["bolt"], 50, "1.25")
    api.add(draft["id"], shop["flour"], "2.5", "3.10")
    detail = api.detail(draft["id"])
    assert [(l["product_sku"], l["line_total"]) for l in detail["lines"]] == [("BOLT-1", "62.5000"), ("FLOUR", "7.7500")]
    assert (detail["line_count"], detail["total_amount"], detail["frozen"]) == (2, "70.2500", False)
    assert "does not change your stock" in detail["stock_notice"]


@pytest.mark.parametrize("quantity,price,total", [
    ("3", "0.3333", "0.9999"),            # exact: no 0.9998999999999999
    ("0.1", "0.2", "0.0200"),
    ("7", "0.1", "0.7000"),
    ("1.5", "0.33335", None),             # 5 decimals in the price: refused
    ("3", "0.00005", None),
    ("99999999999999", "0", "0.0000"),
    ("2", "49999999999999.9999", "99999999999999.9998"),
])
def test_line_totals_are_exact_decimals(api, shop, draft, quantity, price, total):
    flour = shop["flour"]  # kg: fractions allowed
    response = api.add(draft["id"], flour, quantity, price)
    if total is None:
        assert response.status_code == 422
    else:
        assert response.status_code == 201 and response.json()["line"]["line_total"] == total


@pytest.mark.parametrize("quantity,price,expected", [("0.3333", "0.0001", "0.0000"), ("0.5", "0.0001", "0.0001"), ("0.4999", "0.0001", "0.0000"), ("1.5", "0.0003", "0.0005")])
def test_rounding_is_half_up_to_four_decimals(api, shop, draft, quantity, price, expected):
    # quantity x price has up to 8 decimals; the stored total is rounded half-up to 4 (and the database re-checks it)
    assert api.add(draft["id"], shop["flour"], quantity, price).json()["line"]["line_total"] == expected


def test_a_total_too_large_for_the_column_is_refused_cleanly(api, shop, draft):
    response = api.add(draft["id"], shop["flour"], "99999999999999.9999", "99999999999999.9999")
    assert response.status_code == 422 and "too large" in response.json()["detail"]
    assert api.detail(draft["id"])["line_count"] == 0


def test_the_browser_cannot_dictate_product_details_totals_or_ownership(api, shop, draft):
    base = {"product_id": shop["bolt"], "quantity": "1", "unit_price": "1"}
    for extra in ({"product_name": "Hacked"}, {"product_sku": "X"}, {"unit": "kg"}, {"line_total": "0.01"}, {"total_amount": "0"}, {"organization_id": str(uuid.uuid4())},
                  {"purchase_order_id": str(uuid.uuid4())}, {"planned_warehouse_code": "NOPE"}, {"selling_price": "0.01"}, {"cost_price": "0.01"}):
        assert api.client.post(f"{ORDERS}/{draft['id']}/lines", json={**base, **extra}, headers=api.headers).status_code == 422
    assert api.detail(draft["id"])["line_count"] == 0


@pytest.mark.parametrize("quantity", ["0", "-1", "-0.5", "abc", "", None, "1.00001", "NaN", "Infinity", "1" + "0" * 15])
def test_invalid_quantities_are_rejected(api, shop, draft, quantity):
    response = api.client.post(f"{ORDERS}/{draft['id']}/lines", json={"product_id": shop["bolt"], "quantity": quantity, "unit_price": "1"}, headers=api.headers)
    assert response.status_code == 422 and api.detail(draft["id"])["line_count"] == 0


@pytest.mark.parametrize("price", ["-1", "-0.0001", "abc", "", None, "1.00001", "NaN", "Infinity", "1" + "0" * 15])
def test_invalid_prices_are_rejected(api, shop, draft, price):
    response = api.client.post(f"{ORDERS}/{draft['id']}/lines", json={"product_id": shop["bolt"], "quantity": "1", "unit_price": price}, headers=api.headers)
    assert response.status_code == 422 and api.detail(draft["id"])["line_count"] == 0


def test_quantity_and_price_are_never_assumed(api, shop, draft):
    for body in ({"product_id": shop["bolt"], "unit_price": "1"}, {"product_id": shop["bolt"], "quantity": "1"}):
        assert api.client.post(f"{ORDERS}/{draft['id']}/lines", json=body, headers=api.headers).status_code == 422


def test_a_zero_price_is_allowed(api, shop, draft):
    response = api.add(draft["id"], shop["bolt"], 5, "0")
    assert response.status_code == 201 and response.json()["line"]["line_total"] == "0.0000"  # e.g. a free sample


def test_whole_numbers_only_for_indivisible_units(api, shop, draft):
    refused = api.add(draft["id"], shop["bolt"], "1.5", "1")
    assert refused.status_code == 422 and "whole number" in refused.json()["detail"] and "'pcs'" in refused.json()["detail"]
    assert api.add(draft["id"], shop["bolt"], "2.0000", "1").status_code == 201
    assert api.add(draft["id"], shop["flour"], "0.25", "1").status_code == 201


def test_one_line_per_product(api, shop, draft):
    first = api.add(draft["id"], shop["bolt"], 5, "1").json()["line"]
    again = api.add(draft["id"], shop["bolt"], 3, "9")
    assert again.status_code == 409
    detail = again.json()["detail"]
    assert detail["code"] == "duplicate_line" and detail["line"]["id"] == first["id"] and detail["line"]["quantity"] == "5.0000" and detail["line"]["unit_price"] == "1.0000"
    lines = api.detail(draft["id"])["lines"]
    assert len(lines) == 1 and lines[0]["quantity"] == "5.0000" and lines[0]["unit_price"] == "1.0000"  # nothing was merged or changed


def test_the_same_product_may_be_on_different_orders(api, shop):
    acme = api.supplier("Acme")
    one, two = api.order(acme["id"]), api.order(acme["id"])
    assert api.add(one["id"], shop["bolt"], 5, "1").status_code == 201 and api.add(two["id"], shop["bolt"], 7, "2").status_code == 201


def test_simultaneous_adds_of_the_same_product_make_one_line(api, shop, draft, client):
    import threading

    codes = []

    def add():
        codes.append(client.post(f"{ORDERS}/{draft['id']}/lines", json={"product_id": shop["bolt"], "quantity": "1", "unit_price": "1"}, headers=api.headers).status_code)

    threads = [threading.Thread(target=add) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(codes) == [201] + [409] * 5 and api.detail(draft["id"])["line_count"] == 1


def test_an_unknown_product_is_404(api, shop, draft):
    response = api.add(draft["id"], str(uuid.uuid4()), 1, "1")
    assert response.status_code == 404 and response.json()["detail"] == "Product not found."


def test_an_archived_product_cannot_be_ordered(api, shop, draft):
    response = api.add(draft["id"], shop["old"], 1, "1")
    assert response.status_code == 409 and "archived" in response.json()["detail"] and "Old widget" in response.json()["detail"]
    assert api.detail(draft["id"])["line_count"] == 0


def test_a_planned_warehouse_is_validated_and_snapshotted(api, shop, draft):
    ok = api.add(draft["id"], shop["bolt"], 5, "1", planned_warehouse_id=shop["main"]).json()["line"]
    assert (ok["planned_warehouse_id"], ok["planned_warehouse_code"]) == (shop["main"], "MAIN")
    assert api.add(draft["id"], shop["flour"], 1, "1", planned_warehouse_id=str(uuid.uuid4())).status_code == 404
    archived = api.add(draft["id"], shop["flour"], 1, "1", planned_warehouse_id=shop["annex"])
    assert archived.status_code == 409 and "archived" in archived.json()["detail"]
    cleared = api.client.patch(line_url(draft, ok["id"]), json={"planned_warehouse_id": None}, headers=api.headers)
    assert cleared.status_code == 200 and cleared.json()["line"]["planned_warehouse_id"] is None


def test_line_notes(api, shop, draft):
    line = api.add(draft["id"], shop["bolt"], 5, "1", notes="  Pallet of 50  ").json()["line"]
    assert line["notes"] == "Pallet of 50"
    assert api.add(draft["id"], shop["flour"], 5, "1", notes="x" * 501).status_code == 422


# --- editing -------------------------------------------------------------------------------------------------------------------------------
def test_editing_quantity_and_price_recalculates_the_total_on_the_backend(api, shop, draft):
    line = api.add(draft["id"], shop["bolt"], 50, "1.25").json()["line"]
    api.add(draft["id"], shop["flour"], 2, "10")
    edited = api.client.patch(line_url(draft, line["id"]), json={"quantity": "60", "unit_price": "1.1"}, headers=api.headers)
    assert edited.status_code == 200
    assert (edited.json()["line"]["line_total"], edited.json()["total_amount"]) == ("66.0000", "86.0000")
    only_price = api.client.patch(line_url(draft, line["id"]), json={"unit_price": "2"}, headers=api.headers).json()
    assert (only_price["line"]["quantity"], only_price["line"]["line_total"], only_price["total_amount"]) == ("60.0000", "120.0000", "140.0000")
    only_quantity = api.client.patch(line_url(draft, line["id"]), json={"quantity": "1"}, headers=api.headers).json()
    assert (only_quantity["line"]["line_total"], only_quantity["total_amount"]) == ("2.0000", "22.0000")


@pytest.mark.parametrize("body", [{}, {"quantity": None}, {"unit_price": None}, {"quantity": "0"}, {"quantity": "-2"}, {"quantity": "1.5"}, {"unit_price": "-1"},
                                   {"unit_price": "1.00001"}, {"product_id": str(uuid.uuid4())}, {"product_name": "x"}, {"unit": "kg"}, {"line_total": "1"}, {"quantity": "2", "product_sku": "Z"}])
def test_invalid_line_edits_are_rejected_and_change_nothing(api, shop, draft, body):
    line = api.add(draft["id"], shop["bolt"], 5, "2").json()["line"]
    assert api.client.patch(line_url(draft, line["id"]), json=body, headers=api.headers).status_code == 422
    after = api.detail(draft["id"])["lines"][0]
    assert (after["quantity"], after["unit_price"], after["line_total"]) == ("5.0000", "2.0000", "10.0000")


def test_removing_a_line_recalculates_the_total(api, shop, draft):
    first, second = api.add(draft["id"], shop["bolt"], 5, "2").json()["line"], api.add(draft["id"], shop["flour"], 1, "4").json()["line"]
    removed = api.client.delete(line_url(draft, first["id"]), headers=api.headers)
    assert removed.status_code == 200 and (removed.json()["line_count"], removed.json()["total_amount"]) == (1, "4.0000")
    assert [l["id"] for l in api.detail(draft["id"])["lines"]] == [second["id"]]
    assert api.client.delete(line_url(draft, first["id"]), headers=api.headers).status_code == 404
    assert api.add(draft["id"], shop["bolt"], 2, "2").status_code == 201  # it can be added again afterwards


def test_a_line_of_another_order_is_not_reachable_through_this_one(api, shop):
    acme = api.supplier("Acme")
    one, two = api.order(acme["id"]), api.order(acme["id"])
    line = api.add(one["id"], shop["bolt"], 5, "2").json()["line"]
    for method, body in (("patch", {"quantity": "9"}), ("delete", None)):
        response = getattr(api.client, method)(f"{ORDERS}/{two['id']}/lines/{line['id']}", headers=api.headers, **({"json": body} if body else {}))
        assert response.status_code == 404
    assert api.detail(one["id"])["lines"][0]["quantity"] == "5.0000"


def test_an_archived_product_cannot_have_its_quantity_raised_but_the_line_can_go(api, shop, draft, inventory):
    line = api.add(draft["id"], shop["bolt"], 5, "2").json()["line"]
    inventory.products[shop["org"]][shop["bolt"]]["is_active"] = False
    assert api.client.patch(line_url(draft, line["id"]), json={"quantity": "6"}, headers=api.headers).status_code == 409
    assert api.client.patch(line_url(draft, line["id"]), json={"unit_price": "3"}, headers=api.headers).status_code == 200  # a price correction needs no stock lookup
    assert api.client.delete(line_url(draft, line["id"]), headers=api.headers).status_code == 200


def test_an_inactive_supplier_blocks_adding_but_not_removing(api, shop, draft):
    line = api.add(draft["id"], shop["bolt"], 5, "2").json()["line"]
    api.client.post(f"/api/v1/purchasing/suppliers/{draft['supplier']['id']}/deactivate", headers=api.headers)
    refused = api.add(draft["id"], shop["flour"], 1, "1")
    assert refused.status_code == 409 and "inactive" in refused.json()["detail"]
    assert api.client.delete(line_url(draft, line["id"]), headers=api.headers).status_code == 200


@pytest.mark.parametrize("mode", ["down", "500"])
def test_adding_needs_the_inventory_service(api, shop, draft, inventory, mode):
    inventory.mode = mode
    response = api.add(draft["id"], shop["bolt"], 1, "1")
    assert response.status_code == 503 and "inventory service" in response.json()["detail"].lower()
    inventory.mode = None
    assert api.detail(draft["id"])["line_count"] == 0


def test_the_order_can_still_be_read_when_the_inventory_service_is_down(api, shop, draft, inventory):
    api.add(draft["id"], shop["bolt"], 5, "2")
    inventory.mode = "down"
    detail = api.detail(draft["id"])  # purchase orders keep their own snapshots: reading needs no other service
    assert detail["lines"][0]["product_name"] == "Steel bolt" and detail["total_amount"] == "10.0000"


def test_a_rejected_token_at_the_inventory_service_is_reported(api, shop, draft, inventory):
    inventory.mode = "401"
    assert api.add(draft["id"], shop["bolt"], 1, "1").status_code == 401
    inventory.mode = "403"
    assert api.add(draft["id"], shop["bolt"], 1, "1").status_code == 403


# --- the database checks the arithmetic too ---------------------------------------------------------------------------------------
def test_the_database_refuses_a_wrong_line_total(api, shop, draft, session_factory):
    api.add(draft["id"], shop["bolt"], 5, "2")
    with session_factory() as db:
        with pytest.raises(IntegrityError):
            db.execute(text("UPDATE purchase_order_lines SET line_total = 11"))
            db.commit()
    with session_factory() as db:
        with pytest.raises(IntegrityError):
            db.execute(text("UPDATE purchase_order_lines SET quantity = 6"))  # total no longer equals quantity x price
            db.commit()
    assert api.detail(draft["id"])["lines"][0]["line_total"] == "10.0000"


@pytest.mark.parametrize("sql", ["UPDATE purchase_order_lines SET quantity = 0, line_total = 0", "UPDATE purchase_order_lines SET unit_price = -1, line_total = -5"])
def test_the_database_refuses_non_positive_quantities_and_negative_prices(api, shop, draft, session_factory, sql):
    api.add(draft["id"], shop["bolt"], 5, "2")
    with session_factory() as db:
        with pytest.raises(IntegrityError):
            db.execute(text(sql))
            db.commit()


def test_the_database_rounds_exactly_like_the_service(api, shop, draft, session_factory):
    """Python's half-up quantize and PostgreSQL's round() must agree on every case, or the CHECK would reject valid lines."""
    from app.orders import line_total

    for quantity, price in [("0.5", "0.0001"), ("1.5", "0.0003"), ("0.3333", "0.0001"), ("2.5", "0.00002"), ("7", "0.12345")][:3]:
        draft_order = api.order(api.supplier(f"S-{quantity}-{price}")["id"])
        stored = api.add(draft_order["id"], shop["flour"], quantity, price).json()["line"]["line_total"]
        with session_factory() as db:
            assert Decimal(stored) == db.scalar(text("SELECT round(CAST(:q AS numeric) * CAST(:p AS numeric), 4)"), {"q": quantity, "p": price})
            assert Decimal(stored) == line_total(Decimal(quantity), Decimal(price))
