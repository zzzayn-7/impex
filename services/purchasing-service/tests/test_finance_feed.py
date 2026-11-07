"""The financial-event feed the Finance Service pulls (Step 21A): only CONFIRMED goods receipts, read-only, shared-secret, organization-scoped, exact."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from conftest import received

URL = "/internal/v1/organizations/{}/finance-feed"
KEY = "feed-secret"


@pytest.fixture(autouse=True)
def secret(monkeypatch):
    monkeypatch.setenv("MODULE_INTERNAL_API_KEY", KEY)


def feed(client, org, **params):
    response = client.get(URL.format(org), params=params, headers={"X-Internal-Key": KEY})
    assert response.status_code == 200, response.text
    return response.json()


def test_only_a_confirmed_receipt_is_an_event_valued_at_what_was_accepted(client, api, shop, two_orgs):
    order = api.ordered(shop)  # PO-000001: 10 bolts and 5 kg flour at 2.00
    draft = api.draft(order["id"], [received(order, shop["bolt"], 8, shop["main"], rejected="2"), received(order, shop["flour"], 0, shop["main"], rejected="5")])
    assert feed(client, two_orgs["alpha_id"])["events"] == []  # an order is a plan and a draft receipt is a plan: neither is an obligation
    assert api.confirm(draft["id"]).status_code in (200, 202)
    (event,) = feed(client, two_orgs["alpha_id"])["events"]
    assert event["key"] == f"receipt-confirmed:{draft['id']}" and event["type"] == "receipt.confirmed"
    data = event["data"]
    assert (data["receipt_number"], data["purchase_order_number"], data["currency_code"], data["supplier_name"]) == (draft["number"], order["number"], order["currency_code"], "Acme Supplies")
    assert data["lines"] == [{"accepted_quantity": "8.0000", "unit_price": "2.0000"}]  # nothing accepted on the flour line: it is not in the event


def test_the_order_alone_and_an_unconfirmed_posting_receipt_create_no_event(client, api, shop, two_orgs, inventory):
    order = api.ordered(shop)
    draft = api.draft(order["id"], [received(order, shop["bolt"], 10, shop["main"])])
    inventory.post_modes = ["timeout_after"]
    inventory.lookup_mode = "500"
    assert api.confirm(draft["id"]).status_code == 202  # left `posting`: not confirmed yet
    assert feed(client, two_orgs["alpha_id"])["events"] == []
    inventory.lookup_mode = None
    assert api.confirm(draft["id"]).status_code == 200
    assert len(feed(client, two_orgs["alpha_id"])["events"]) == 1


def test_the_feed_never_changes_anything(client, api, shop, two_orgs, session_factory):
    order = api.ordered(shop)
    api.confirm(api.draft(order["id"], [received(order, shop["bolt"], 10, shop["main"])])["id"])
    sql = "SELECT (SELECT count(*) FROM purchase_orders) || '/' || (SELECT max(updated_at)::text FROM goods_receipts) || '/' || (SELECT count(*) FROM goods_receipt_lines)"
    with session_factory() as db:
        before = db.execute(text(sql)).scalar()
    for _ in range(3):
        feed(client, two_orgs["alpha_id"])
    with session_factory() as db:
        assert db.execute(text(sql)).scalar() == before


def test_since_limit_and_has_more(client, api, shop, two_orgs):
    for n in range(2):
        order = api.ordered(shop, supplier=f"Supplier {n}")
        api.confirm(api.draft(order["id"], [received(order, shop["bolt"], 1, shop["main"])])["id"])
    assert len(feed(client, two_orgs["alpha_id"])["events"]) == 2
    page = feed(client, two_orgs["alpha_id"], limit=1)
    assert len(page["events"]) == 1 and page["has_more"] is True
    assert feed(client, two_orgs["alpha_id"], since=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat())["events"] == []
    assert len(feed(client, two_orgs["alpha_id"], since=(datetime.now(timezone.utc) - timedelta(hours=1)).isoformat())["events"]) == 2


def test_each_organization_gets_only_its_own_events(client, api, shop, two_orgs):
    order = api.ordered(shop)
    api.confirm(api.draft(order["id"], [received(order, shop["bolt"], 10, shop["main"])])["id"])
    assert len(feed(client, two_orgs["alpha_id"])["events"]) == 1
    assert feed(client, two_orgs["beta_id"]) == {"events": [], "has_more": False}
    assert feed(client, str(uuid.uuid4())) == {"events": [], "has_more": False}


def test_only_the_finance_service_may_ask(client, two_orgs, monkeypatch):
    url = URL.format(two_orgs["alpha_id"])
    assert client.get(url).status_code == 401
    assert client.get(url, headers={"X-Internal-Key": "wrong"}).status_code == 401
    assert client.get(url, headers=two_orgs["alpha"].headers).status_code == 401
    monkeypatch.delenv("MODULE_INTERNAL_API_KEY")
    assert client.get(url, headers={"X-Internal-Key": KEY}).status_code == 503
    monkeypatch.setenv("MODULE_INTERNAL_API_KEY", KEY)
    assert "finance-feed" not in client.get("/openapi.json").text
