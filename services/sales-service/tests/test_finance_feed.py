"""The financial-event feed the Finance Service pulls (Step 21A): read-only, shared-secret, organization-scoped, exact."""
import uuid
from datetime import datetime, timedelta, timezone

from decimal import Decimal as D

import pytest
from sqlalchemy import text

from conftest import bill

URL = "/internal/v1/organizations/{}/finance-feed"
KEY = "feed-secret"


@pytest.fixture(autouse=True)
def secret(monkeypatch):
    monkeypatch.setenv("MODULE_INTERNAL_API_KEY", KEY)


@pytest.fixture
def depot(inventory, shop):
    return shop


@pytest.fixture
def world(api, depot):
    client = api.new_client("Acme Ltd")
    delivery_list = api.new_list(client["id"])
    api.add(delivery_list["id"], depot["bolt"], 15)
    ready = api.status(delivery_list["id"], "ready").json()
    dispatch = api.confirmed_dispatch(depot, ready, [("bolt", 10)])
    return {"client": client, "dispatch": dispatch}


def feed(client, org, **params):
    response = client.get(URL.format(org), params=params, headers={"X-Internal-Key": KEY})
    assert response.status_code == 200, response.text
    return response.json()


def keys(body):
    return [e["key"] for e in body["events"]]


def test_an_issued_invoice_is_one_exact_event_and_a_draft_is_none(client, api, two_orgs, depot, world):
    draft = api.draft_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 3, "0.3333", tax_rate="7.5", discount_amount="0.05")])
    assert feed(client, two_orgs["alpha_id"])["events"] == []  # a draft is not a financial fact
    issued = api.issue(draft["id"]).json()
    (event,) = feed(client, two_orgs["alpha_id"])["events"]
    assert event["key"] == f"invoice-issued:{draft['id']}" and event["type"] == "invoice.issued" and event["time"]
    data = event["data"]
    assert (data["number"], data["currency_code"], data["client_name"]) == (issued["number"], "USD", "Acme Ltd")
    assert (data["subtotal"], data["discount_total"], data["tax_total"], data["total"]) == (issued["subtotal"], issued["discount_total"], issued["tax_total"], issued["total"])
    assert D(data["total"]) == D(data["subtotal"]) - D(data["discount_total"]) + D(data["tax_total"])  # the identity Finance relies on


def test_payments_reversals_and_voids_are_events_with_their_own_keys(client, api, two_orgs, depot, world):
    invoice = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 10, "2")], currency="EUR")
    payment = api.pay(invoice["id"], "5.50").json()
    body = feed(client, two_orgs["alpha_id"])
    assert keys(body)[0] == f"invoice-issued:{invoice['id']}"
    pay_events = [e for e in body["events"] if e["type"] == "payment.recorded"]
    assert len(pay_events) == 1 and pay_events[0]["data"]["currency_code"] == "EUR" and pay_events[0]["data"]["amount"] == "5.5000" and pay_events[0]["data"]["invoice_number"] == invoice["number"]
    pid = pay_events[0]["data"]["payment_id"]
    assert api.reverse(invoice["id"], pid).status_code in (200, 201)
    events = feed(client, two_orgs["alpha_id"])["events"]
    assert [e["type"] for e in events] == ["invoice.issued", "payment.recorded", "payment.reversed"]
    reversed_event = events[2]
    assert reversed_event["data"]["reverses_payment_id"] == pid and reversed_event["data"]["amount"] == "5.5000" and reversed_event["key"] != events[1]["key"]
    assert api.void(invoice["id"]).status_code == 200
    events = feed(client, two_orgs["alpha_id"])["events"]
    assert events[-1]["type"] == "invoice.voided" and events[-1]["key"] == f"invoice-voided:{invoice['id']}"


def test_voiding_a_draft_is_not_a_financial_event(client, api, two_orgs, depot, world):
    draft = api.draft_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 1, "1")])
    api.void(draft["id"])
    assert feed(client, two_orgs["alpha_id"])["events"] == []


def test_the_feed_never_changes_anything(client, api, two_orgs, depot, world, session_factory):
    invoice = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 10, "2")])
    api.pay(invoice["id"], "5")
    with session_factory() as db:
        before = db.execute(text("SELECT count(*), max(updated_at)::text FROM invoices")).one(), db.execute(text("SELECT count(*), max(created_at)::text FROM invoice_payments")).one()
    for _ in range(3):
        feed(client, two_orgs["alpha_id"])
    with session_factory() as db:
        assert (db.execute(text("SELECT count(*), max(updated_at)::text FROM invoices")).one(), db.execute(text("SELECT count(*), max(created_at)::text FROM invoice_payments")).one()) == before


def test_since_limit_and_has_more(client, api, two_orgs, depot, world):
    invoice = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 10, "2")])
    api.pay(invoice["id"], "1")
    api.pay(invoice["id"], "1")
    assert len(feed(client, two_orgs["alpha_id"])["events"]) == 3
    page = feed(client, two_orgs["alpha_id"], limit=2)
    assert len(page["events"]) == 2 and page["has_more"] is True
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert feed(client, two_orgs["alpha_id"], since=future) == {"events": [], "has_more": False}
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    assert len(feed(client, two_orgs["alpha_id"], since=past)["events"]) == 3
    assert client.get(URL.format(two_orgs["alpha_id"]), params={"limit": 0}, headers={"X-Internal-Key": KEY}).status_code == 422
    assert client.get(URL.format(two_orgs["alpha_id"]), params={"limit": 1001}, headers={"X-Internal-Key": KEY}).status_code == 422


def test_each_organization_gets_only_its_own_events(client, api, two_orgs, depot, world):
    api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 10, "2")])
    assert len(feed(client, two_orgs["alpha_id"])["events"]) == 1
    assert feed(client, two_orgs["beta_id"]) == {"events": [], "has_more": False}
    assert feed(client, str(uuid.uuid4())) == {"events": [], "has_more": False}


def test_only_the_finance_service_may_ask(client, two_orgs, monkeypatch):
    url = URL.format(two_orgs["alpha_id"])
    assert client.get(url).status_code == 401
    assert client.get(url, headers={"X-Internal-Key": "wrong"}).status_code == 401
    assert client.get(url, headers=two_orgs["alpha"].headers).status_code == 401  # an administrator's token is not a service credential
    monkeypatch.delenv("MODULE_INTERNAL_API_KEY")
    assert client.get(url, headers={"X-Internal-Key": KEY}).status_code == 503  # never open when no secret is configured
    assert client.get(URL.format("not-a-uuid"), headers={"X-Internal-Key": KEY}).status_code in (401, 422, 503)
    monkeypatch.setenv("MODULE_INTERNAL_API_KEY", KEY)
    assert "finance-feed" not in client.get("/openapi.json").text  # not in the public documentation
