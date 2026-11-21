"""The PNL calculator's store: the expenses an organization notes against one sales order. A calculator, not the books: nothing is posted, nothing else changes."""
import uuid

import pytest
from sqlalchemy import text

from conftest import bearer

URL = "/api/v1/finance/order-expenses"


def put(api, order_id, **body):
    payload = {"currency_code": "USD", "goods_cost": "300", "delivery_charges": "25", "other_expenses": [{"label": "Packing", "amount": "10.5"}], **body}
    return api.client.put(f"{URL}/{order_id}", json=payload, headers=api.headers)


def test_saving_stores_the_expenses_as_exact_decimals_and_reading_gives_them_back(api):
    order = str(uuid.uuid4())
    response = put(api, order)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["order_id"] == order and saved["currency_code"] == "USD" and saved["goods_cost"] == "300.0000" and saved["delivery_charges"] == "25.0000"
    assert saved["other_expenses"] == [{"label": "Packing", "amount": "10.5000"}]
    assert api.client.get(f"{URL}/{order}", headers=api.headers).json() == saved
    assert api.client.get(URL, params={"order_ids": f"{order},{uuid.uuid4()}"}, headers=api.headers).json() == {"items": [saved]}


def test_saving_again_overwrites_one_row_and_a_repeat_changes_nothing(api, session_factory):
    order = str(uuid.uuid4())
    first = put(api, order).json()
    assert put(api, order).json()["goods_cost"] == first["goods_cost"]
    changed = put(api, order, goods_cost="310.25", delivery_charges="0", other_expenses=[]).json()
    assert (changed["goods_cost"], changed["delivery_charges"], changed["other_expenses"]) == ("310.2500", "0.0000", [])
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM order_expenses")).scalar() == 1


def test_nothing_is_posted_to_the_books(api, session_factory):
    before = api.entries()["total"]
    put(api, str(uuid.uuid4()))
    assert api.entries()["total"] == before
    with session_factory() as db:
        for table in ("journal_entries", "expenses", "capital_records", "trade_deliveries", "cost_entries"):
            assert db.execute(text(f"SELECT count(*) FROM {table} WHERE organization_id = :o"), {"o": api.org_id}).scalar() == 0 or table == "journal_entries", table


def test_an_order_with_nothing_saved_is_a_404_and_absent_from_the_list(api):
    assert api.client.get(f"{URL}/{uuid.uuid4()}", headers=api.headers).status_code == 404
    assert api.client.get(URL, params={"order_ids": str(uuid.uuid4())}, headers=api.headers).json() == {"items": []}
    assert api.client.get(URL, headers=api.headers).json() == {"items": []}
    assert api.client.get(URL, params={"order_ids": "nope"}, headers=api.headers).status_code == 422


@pytest.mark.parametrize("change", [
    {"currency_code": "US"}, {"currency_code": "ZZZ"}, {"goods_cost": "-1"}, {"delivery_charges": "-0.01"}, {"goods_cost": "1.23456"}, {"goods_cost": "123456789012345"}, {"goods_cost": "abc"},
    {"other_expenses": [{"label": "", "amount": "1"}]}, {"other_expenses": [{"label": "   ", "amount": "1"}]}, {"other_expenses": [{"label": "x" * 61, "amount": "1"}]},
    {"other_expenses": [{"label": "Fuel", "amount": "-5"}]}, {"other_expenses": [{"label": "Fuel"}]}, {"other_expenses": [{"label": "Fuel", "amount": "1", "tax": "1"}]},
    {"other_expenses": [{"label": f"E{i}", "amount": "1"} for i in range(21)]}, {"profit": "1"}, {"organization_id": str(uuid.uuid4())}, {"selling_price": "5"},
])
def test_bad_input_is_refused_and_saves_nothing(api, session_factory, change):
    assert put(api, str(uuid.uuid4()), **change).status_code == 422
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM order_expenses")).scalar() == 0


def test_twenty_other_expenses_are_the_most_and_the_names_are_tidied(api):
    order = str(uuid.uuid4())
    ok = put(api, order, other_expenses=[{"label": f"  Item   {i}  ", "amount": "1"} for i in range(20)])
    assert ok.status_code == 200 and ok.json()["other_expenses"][0]["label"] == "Item 0" and len(ok.json()["other_expenses"]) == 20


def test_another_organization_sees_and_changes_nothing(two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    order = str(uuid.uuid4())
    put(alpha, order)
    assert beta.client.get(f"{URL}/{order}", headers=beta.headers).status_code == 404
    assert beta.client.get(URL, params={"order_ids": order}, headers=beta.headers).json() == {"items": []}
    put(beta, order, goods_cost="1")  # beta's own row for the same order id: alpha's is untouched
    assert alpha.client.get(f"{URL}/{order}", headers=alpha.headers).json()["goods_cost"] == "300.0000"


def test_every_route_needs_a_signed_in_organization_administrator(api, client):
    order = uuid.uuid4()
    for method, url in (("get", URL), ("get", f"{URL}/{order}"), ("put", f"{URL}/{order}")):
        kwargs = {"json": {"currency_code": "USD"}} if method == "put" else {}
        assert getattr(client, method)(url, **kwargs).status_code == 401, url
        assert getattr(client, method)(url, headers=bearer("nobody"), **kwargs).status_code == 401, url


def test_all_returns_every_saved_order_of_the_organization_only(two_orgs):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    a1, a2, b1 = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    put(alpha, a1)
    put(alpha, a2, goods_cost="5")
    put(beta, b1)
    got = alpha.client.get(URL, params={"all": "true"}, headers=alpha.headers).json()["items"]
    assert [i["order_id"] for i in got] == [a2, a1]  # the newest save first
    assert [i["order_id"] for i in beta.client.get(URL, params={"all": "true"}, headers=beta.headers).json()["items"]] == [b1]
    assert api_empty(alpha, str(uuid.uuid4())) == []  # naming ids still works the old way


def api_empty(api, order_id):
    return api.client.get(URL, params={"order_ids": order_id}, headers=api.headers).json()["items"]


def test_deleting_removes_only_the_saved_expenses_and_the_order_goes_back_to_not_calculated(two_orgs, session_factory):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    order = str(uuid.uuid4())
    put(alpha, order)
    put(beta, order, goods_cost="1")
    assert beta.client.delete(f"{URL}/{order}", headers=beta.headers).status_code == 204  # beta's own row only
    assert alpha.client.get(f"{URL}/{order}", headers=alpha.headers).status_code == 200
    assert alpha.client.delete(f"{URL}/{order}", headers=alpha.headers).status_code == 204
    assert alpha.client.get(f"{URL}/{order}", headers=alpha.headers).status_code == 404
    assert alpha.client.delete(f"{URL}/{order}", headers=alpha.headers).status_code == 404  # nothing left to delete
    assert alpha.client.get(URL, params={"all": "true"}, headers=alpha.headers).json() == {"items": []}
    put(alpha, order, goods_cost="7")  # and it can be saved again
    assert alpha.client.get(f"{URL}/{order}", headers=alpha.headers).json()["goods_cost"] == "7.0000"
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM journal_entries")).scalar() == 0  # nothing in the books was touched


def test_delete_needs_a_signed_in_administrator_and_a_real_id(api, client):
    assert client.delete(f"{URL}/{uuid.uuid4()}").status_code == 401
    assert client.delete(f"{URL}/{uuid.uuid4()}", headers=bearer("nobody")).status_code == 401
    assert api.client.delete(f"{URL}/not-a-uuid", headers=api.headers).status_code == 422
