"""GET /stock/summary: product details and stock for specific ids (used by the Sales Service, read-only)."""
import uuid

import pytest

from conftest import STOCK_URL, bearer

URL = f"{STOCK_URL}/summary"


def summary(api, *ids, headers=None):
    return api.client.get(URL, params=[("product_id", i) for i in ids], headers=headers or api.headers)


def test_returns_details_and_stock_for_the_requested_products_only(api):
    bolt, flour, other = api.product(sku="BOLT", name="Bolt", unit="pcs"), api.product(sku="FLOUR", name="Flour", unit="kg"), api.product(sku="OTHER", name="Other")
    main, annex = api.warehouse("MAIN"), api.warehouse("ANNEX")
    api.add(bolt, main, 40)
    api.add(bolt, annex, 10)
    api.add(flour, main, "2.5")
    api.client.post(f"/api/v1/inventory/warehouses/{annex['id']}/archive", headers=api.headers)

    response = summary(api, bolt["id"], flour["id"])
    assert response.status_code == 200
    items = {i["sku"]: i for i in response.json()["items"]}
    assert set(items) == {"BOLT", "FLOUR"}
    assert (items["BOLT"]["total_quantity"], items["BOLT"]["available_quantity"], items["BOLT"]["unit"]) == ("50.0000", "40.0000", "pcs")
    assert items["BOLT"]["unit_allows_fractions"] is False and items["FLOUR"]["unit_allows_fractions"] is True
    assert items["BOLT"]["is_active"] is True and "organization_id" not in response.text


def test_archived_products_are_reported_as_inactive(api):
    product = api.product(sku="OLD")
    api.client.post(f"/api/v1/inventory/products/{product['id']}/archive", headers=api.headers)
    assert summary(api, product["id"]).json()["items"][0]["is_active"] is False


def test_unknown_and_other_organizations_products_are_simply_missing(two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    mine, theirs = alpha.product(sku="MINE"), beta.product(sku="THEIRS")
    body = summary(alpha, mine["id"], theirs["id"], str(uuid.uuid4())).json()
    assert [i["sku"] for i in body["items"]] == ["MINE"]
    assert "THEIRS" not in str(body) and "Beta" not in str(body)
    assert summary(alpha, theirs["id"]).json() == {"items": []}


def test_no_ids_gives_an_empty_answer_and_bad_ids_are_rejected(api):
    assert summary(api).json() == {"items": []}
    assert summary(api, "not-a-uuid").status_code == 422
    assert summary(api, *[str(uuid.uuid4()) for _ in range(101)]).status_code == 422


def test_it_changes_nothing(api, session_factory):
    from sqlalchemy import func, select

    from app.models import StockMovement

    product, wh = api.product(sku="P"), api.warehouse("W")
    api.add(product, wh, 3)
    for _ in range(3):
        summary(api, product["id"])
    with session_factory() as db:
        assert db.scalar(select(func.count()).select_from(StockMovement)) == 1


def test_access_rules_apply(client, directory):
    org = directory.add_organization("Alpha")
    directory.add_user("super", "super-admin")
    assert client.get(URL).status_code == 401
    assert client.get(URL, headers=bearer("nonsense")).status_code == 401
    assert client.get(URL, headers=bearer("super")).status_code == 403
    dormant = directory.add_organization("Dormant", active=False)
    directory.add_user("dormant", "organization-admin", dormant)
    assert client.get(URL, headers=bearer("dormant")).status_code == 403
    live = directory.add_user("live", "organization-admin", org)
    directory.org_mode = "down"
    assert client.get(URL, headers=bearer("live")).status_code == 503
