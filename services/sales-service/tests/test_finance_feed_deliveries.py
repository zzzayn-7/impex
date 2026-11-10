"""The delivery events of the finance feed: goods that LEFT stock for a client, with the price agreed on the order, and the allocations of an invoice."""
import uuid
from decimal import Decimal as D

import pytest
from sqlalchemy import text

from conftest import bill
from test_order_invoice import dispatch_all, generate, goods, make_it_an_older_order, make_order  # noqa: F401  (fixtures and helpers shared with the order tests)

URL = "/internal/v1/organizations/{}/finance-feed"
KEY = "feed-secret"


@pytest.fixture(autouse=True)
def secret(monkeypatch):
    monkeypatch.setenv("MODULE_INTERNAL_API_KEY", KEY)


def feed(client, org, **params):
    response = client.get(URL.format(org), params=params, headers={"X-Internal-Key": KEY})
    assert response.status_code == 200, response.text
    return response.json()


def deliveries(client, org):
    return [e for e in feed(client, org, include_deliveries="true")["events"] if e["type"] == "delivery.confirmed"]


def test_deliveries_are_only_sent_when_asked_for(client, api, two_orgs, goods):
    order = make_order(api, api.new_client("Acme Ltd"), (goods["bolt"], 10, "30"))
    dispatch_all(api, order, (goods["bolt"], 10))
    assert [e["type"] for e in feed(client, two_orgs["alpha_id"])["events"]] == []  # an older consumer sees exactly what it always saw
    assert len(deliveries(client, two_orgs["alpha_id"])) == 1


def test_a_confirmed_dispatch_is_one_event_with_the_agreed_price_of_one_unit(client, api, two_orgs, goods):
    acme = api.new_client("Acme Ltd")
    order = make_order(api, acme, (goods["bolt"], 10, "30.5"), (goods["flour"], 4, "12.5"), currency="EUR")
    dispatch = dispatch_all(api, order, (goods["bolt"], 6), (goods["flour"], 4))
    (event,) = deliveries(client, two_orgs["alpha_id"])
    assert event["key"] == f"delivery-confirmed:{dispatch['id']}" and event["time"]
    data = event["data"]
    assert (data["client_name"], data["order_number"], data["currency_code"], data["dispatch_number"]) == ("Acme Ltd", order["number"], "EUR", dispatch["number"])
    by_sku = {line["sku"]: line for line in data["lines"]}
    assert (by_sku["BOLT-1"]["quantity"], by_sku["BOLT-1"]["unit_price"], by_sku["BOLT-1"]["product_id"]) == ("6.0000", "30.5000", str(goods["bolt"]))
    assert (by_sku["FLOUR"]["quantity"], by_sku["FLOUR"]["unit_price"]) == ("4.0000", "12.5000")
    assert all(line["dispatch_line_id"] for line in data["lines"])


def test_a_partial_delivery_is_only_what_was_delivered_and_a_second_one_is_its_own_event(client, api, two_orgs, goods):
    order = make_order(api, api.new_client("Acme Ltd"), (goods["bolt"], 10, "30"))
    first = dispatch_all(api, order, (goods["bolt"], 4))
    second = dispatch_all(api, order, (goods["bolt"], 6))
    events = deliveries(client, two_orgs["alpha_id"])
    assert [e["key"] for e in events] == [f"delivery-confirmed:{first['id']}", f"delivery-confirmed:{second['id']}"]
    assert [e["data"]["lines"][0]["quantity"] for e in events] == ["4.0000", "6.0000"]


def test_a_draft_dispatch_is_not_a_delivery(client, api, two_orgs, goods):
    from conftest import sent
    order = make_order(api, api.new_client("Acme Ltd"), (goods["bolt"], 10, "30"))
    delivery_list = api.detail(order["delivery_list"]["id"])
    api.draft(delivery_list["id"], [sent(delivery_list, goods["bolt"], 3)])
    assert deliveries(client, two_orgs["alpha_id"]) == []


def test_an_older_order_has_no_price_and_no_currency_and_never_a_zero(client, api, two_orgs, goods, session_factory):
    order = make_order(api, api.new_client("Acme Ltd"), (goods["bolt"], 10, "30"))
    with session_factory() as db:
        db.execute(text("UPDATE delivery_list_items SET unit_price = NULL"))
        db.execute(text("UPDATE sales_orders SET currency_code = NULL"))
        db.commit()
    dispatch_all(api, order, (goods["bolt"], 10))
    (event,) = deliveries(client, two_orgs["alpha_id"])
    assert event["data"]["currency_code"] is None and event["data"]["lines"][0]["unit_price"] is None


def test_each_organization_gets_only_its_own_deliveries(client, api, two_orgs, goods):
    order = make_order(api, api.new_client("Acme Ltd"), (goods["bolt"], 10, "30"))
    dispatch_all(api, order, (goods["bolt"], 10))
    assert len(deliveries(client, two_orgs["alpha_id"])) == 1
    assert deliveries(client, two_orgs["beta_id"]) == [] and deliveries(client, str(uuid.uuid4())) == []


def test_an_invoice_names_the_delivered_goods_it_bills_and_what_it_bills_for_them(client, api, two_orgs, goods):
    acme = api.new_client("Acme Ltd")
    order = make_order(api, acme, (goods["bolt"], 10, "30"))
    dispatch = dispatch_all(api, order, (goods["bolt"], 10))
    invoice = api.issued_invoice(acme["id"], [bill(dispatch, goods["bolt"], 10, "28", discount_amount="5", tax_rate="10")])  # billed 280 - 5 discount = 275 net, before tax
    (event,) = [e for e in feed(client, two_orgs["alpha_id"])["events"] if e["type"] == "invoice.issued"]
    (allocation,) = event["data"]["allocations"]
    line = next(l for l in dispatch["lines"] if l["product_id"] == str(goods["bolt"]))
    assert allocation["dispatch_line_id"] == line["id"] and allocation["quantity"] == "10.0000" and allocation["net_amount"] == "275.0000"
    assert allocation["dispatch_confirmed_at"]
    assert D(event["data"]["subtotal"]) - D(event["data"]["discount_total"]) == D(allocation["net_amount"])


def test_a_part_of_a_line_is_billed_pro_rata(client, api, two_orgs, goods):
    acme = api.new_client("Acme Ltd")
    order = make_order(api, acme, (goods["bolt"], 10, "30"))
    first = dispatch_all(api, order, (goods["bolt"], 4))
    second = dispatch_all(api, order, (goods["bolt"], 6))
    api.issued_invoice(acme["id"], [bill(first, goods["bolt"], 4, "30"), bill(second, goods["bolt"], 6, "30")])
    (event,) = [e for e in feed(client, two_orgs["alpha_id"])["events"] if e["type"] == "invoice.issued"]
    assert sorted(a["net_amount"] for a in event["data"]["allocations"]) == ["120.0000", "180.0000"]
