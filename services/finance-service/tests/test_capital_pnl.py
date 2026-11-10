"""Capital, Investment and Profit & Loss: the rules of the Finance page, scenario by scenario.

The story the specification tells, in numbers: the owner puts 5,000,000 in; 50 laptops are bought at 100,000 each (an investment ACTIVITY, not a second contribution); 20 are
delivered at 120,000 (profit 400,000, recognised once, when they leave) - and nothing an invoice or a payment does can recognise it again.
"""
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal as D

import pytest
from sqlalchemy import text

from conftest import ACCOUNTS, EXPENSES, PREFIX, now, product

SUMMARY, HISTORY, INVEST, OPENING, COSTS, RECON = (f"{PREFIX}/{p}" for p in ("summary", "history", "investments", "opening-positions", "inventory-costs", "reconciliation"))
M = 1_000_000


def today(days_ago=0) -> str:
    return (now() - timedelta(days=days_ago)).date().isoformat()


def ago(**kw) -> datetime:
    return now() - timedelta(**kw)


def d(value) -> D:
    return D(str(value))


@pytest.fixture
def org(api, two_orgs):
    api.accounts()  # the first request sets Finance up for the organization
    return two_orgs["alpha_id"]


def invest(api, amount, *, kind="contribution", currency="PKR", day=None, expect=201, key=None, **extra):
    body = {"kind": kind, "amount": str(amount), "currency_code": currency, "effective_date": day or today(), **extra}
    response = api.client.post(INVEST, json=body, headers={**api.headers, "Idempotency-Key": key or api.key()})
    assert response.status_code == expect, response.text
    return response.json()


def summary(api, period="1m"):
    response = api.get(SUMMARY, params={"period": period})
    assert response.status_code == 200, response.text
    return response.json()


def block(api, currency="PKR", period="1m"):
    return summary(api, period)["by_currency"][currency]


def history(api, **params):
    response = api.get(HISTORY, params={"period": "1m", **params})
    assert response.status_code == 200, response.text
    return response.json()


def settle(run_sync, org):
    result = run_sync(org)
    assert result["failed"] == 0, result
    return result


def stocked(api, org, feeds, run_sync, *, qty="50", price="100000", currency="PKR", item=None, when=None):
    """The owner has put 5,000,000 in and a goods receipt for `qty` of a product at `price` is confirmed."""
    item = item or product("LAP-1", "Dell Latitude Laptop")
    feeds.receipt(org, lines=((qty, price),), currency=currency, product=item, when=when or ago(hours=3))
    settle(run_sync, org)
    return item


def deliver(feeds, org, item, qty, price, *, currency="PKR", when=None, client="Company A", order="SO-000001", number="DS-000001"):
    return feeds.delivery(org, lines=((item, qty, price),), currency=currency, client=client, order=order, when=when or ago(hours=1), number=number)


# ====================================================================================================== Investment and Capital
def test_an_owner_contribution_is_capital_and_investment_and_a_new_baseline(api, org):
    invest(api, 5 * M)
    pkr = block(api)
    assert (pkr["capital"]["closing"], pkr["investment"]["closing"]) == ("5000000.0000", "5000000.0000")
    assert pkr["capital"]["ready"] is True and pkr["capital"]["basis"] == "owner_records"
    assert pkr["investment"]["contributions"] == "5000000.0000" and pkr["investment"]["withdrawals"] == "0.0000"
    assert pkr["capital"]["change"] == {"absolute": "5000000.0000", "percent": None, "state": "new", "direction": "up"}  # a zero baseline is "New", never a percentage of zero


def test_buying_stock_with_the_owners_money_does_not_double_the_capital(api, org, feeds, run_sync):
    invest(api, 5 * M)
    stocked(api, org, feeds, run_sync)  # 50 laptops x 100,000 = 5,000,000 confirmed on a goods receipt
    pkr = block(api)
    assert pkr["capital"]["closing"] == "5000000.0000" and pkr["investment"]["closing"] == "5000000.0000"  # NOT 10,000,000
    assert pkr["investment"]["inventory_purchases"] == "5000000.0000" and pkr["investment"]["contributions"] == "5000000.0000"
    rows = history(api, category="investments")["items"]
    assert sorted(r["kind"] for r in rows) == ["inventory_purchase", "owner_contribution"]
    purchase = next(r for r in rows if r["kind"] == "inventory_purchase")
    assert (purchase["amount"], purchase["transaction"], purchase["affects_capital"], purchase["counterparty"], purchase["reference"]) == ("5000000.0000", "Inventory purchase", False, "Acme Supplies", "GR-000001")
    assert "PO-000001" in purchase["notes"] and purchase["source_type"] == "goods_receipt" and purchase["source_id"]


def test_a_goods_receipt_confirmed_again_is_never_a_second_investment(api, org, feeds, run_sync, session_factory):
    invest(api, 5 * M)
    receipt = feeds.receipt(org, lines=(("50", "100000"),), currency="PKR", product=product(), when=ago(hours=3))
    settle(run_sync, org)
    feeds.events[("purchasing", org)].append(dict(receipt))  # the feed hands over the same fact again (an overlapping read, a retry, a restart)
    settle(run_sync, org)
    settle(run_sync, org)
    with session_factory() as db:
        assert db.execute(text("SELECT count(*), sum(value) FROM cost_entries WHERE kind = 'receipt'")).one() == (1, D("5000000"))
        assert db.execute(text("SELECT quantity, total_value FROM inventory_costs")).one() == (D("50"), D("5000000"))
    assert block(api)["investment"]["inventory_purchases"] == "5000000.0000"


def test_an_owner_withdrawal_reduces_capital_and_a_reversal_restores_it(api, org):
    invest(api, 5 * M)
    withdrawal = invest(api, 1 * M, kind="withdrawal")
    pkr = block(api)
    assert pkr["capital"]["closing"] == "4000000.0000" and pkr["investment"]["withdrawals"] == "1000000.0000" and pkr["investment"]["net_invested"] == "4000000.0000"
    reversal = api.client.post(f"{INVEST}/{withdrawal['id']}/reverse", json={"reason": "Entered twice"}, headers=api.headers)
    assert reversal.status_code == 201 and reversal.json()["is_reversal"] and reversal.json()["effect"] == "1000000.0000" and reversal.json()["reverses_id"] == withdrawal["id"]
    assert block(api)["capital"]["closing"] == "5000000.0000"
    assert api.client.post(f"{INVEST}/{withdrawal['id']}/reverse", json={"reason": "Again"}, headers=api.headers).json()["detail"]["code"] == "already_reversed"
    assert api.client.post(f"{INVEST}/{reversal.json()['id']}/reverse", json={"reason": "Again"}, headers=api.headers).json()["detail"]["code"] == "not_reversible"
    rows = {r["id"]: r for r in history(api, category="investments")["items"]}
    assert rows[f"capital:{withdrawal['id']}"]["can_reverse"] is False and rows[f"capital:{reversal.json()['id']}"]["can_reverse"] is False


def test_a_retry_with_the_same_key_records_nothing_twice_and_a_different_body_is_refused(api, org, session_factory):
    key = api.key()
    first = invest(api, 1000, key=key)
    second = api.client.post(INVEST, json={"kind": "contribution", "amount": "1000", "currency_code": "PKR", "effective_date": today()}, headers={**api.headers, "Idempotency-Key": key})
    assert second.status_code == 200 and second.json()["id"] == first["id"]
    other = api.client.post(INVEST, json={"kind": "contribution", "amount": "2000", "currency_code": "PKR", "effective_date": today()}, headers={**api.headers, "Idempotency-Key": key})
    assert other.status_code == 409 and other.json()["detail"]["code"] == "idempotency_key_reused"
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM capital_records")).scalar() == 1


def test_in_kind_contributions_count_once_and_the_stock_cost_basis_adds_no_capital(api, org, feeds, run_sync):
    item = product("LAP-2", "Lenovo Laptop")
    invest(api, 1 * M, entry_type="inventory", description="10 laptops contributed by the owner")  # valued at 1,000,000
    cost = api.client.post(COSTS, json={"product_id": item["id"], "sku": item["sku"], "name": item["name"], "quantity": "10", "unit_cost": "100000", "currency_code": "PKR", "effective_date": today()},
                           headers={**api.headers, "Idempotency-Key": api.key()})
    assert cost.status_code == 201 and cost.json()["value"] == "1000000.0000"
    pkr = block(api)
    assert pkr["capital"]["closing"] == "1000000.0000" and pkr["investment"]["closing"] == "1000000.0000"  # the stock is the contribution, not a second 1,000,000
    deliver(feeds, org, item, "4", "150000", when=ago(hours=1))
    settle(run_sync, org)
    assert block(api)["profit_loss"]["gross_profit"] == "200000.0000" and block(api)["capital"]["closing"] == "1200000.0000"


def test_investment_input_is_validated(api, org):
    base = {"kind": "contribution", "amount": "100", "currency_code": "PKR", "effective_date": today()}
    for patch, expected in (({"amount": "0"}, 422), ({"amount": "-5"}, 422), ({"amount": "1.23456"}, 422), ({"currency_code": "ZZZ"}, 422), ({"kind": "gift"}, 422), ({"organization_id": str(uuid.uuid4())}, 422),
                            ({"effect": "999"}, 422), ({"effective_date": (now() + timedelta(days=30)).date().isoformat()}, 422), ({"effective_date": "yesterday"}, 422)):
        response = api.client.post(INVEST, json={**base, **patch}, headers={**api.headers, "Idempotency-Key": api.key()})
        assert response.status_code == expected, (patch, response.text)
    assert api.client.post(INVEST, json=base, headers=api.headers).status_code == 400  # the Idempotency-Key is required
    assert summary(api)["currencies"] == []  # nothing was recorded by the refused requests


def test_capital_is_never_invented_when_nothing_establishes_it(api, org):
    empty = summary(api)
    assert empty["currencies"] == [] and empty["setup_required"] is True and "no starting balance is assumed" in empty["setup_message"]
    api.expense(post=True, amount="500", currency_code="PKR", expense_date=today())
    only_expenses = summary(api)
    assert only_expenses["setup_required"] is True and "PKR" in only_expenses["setup_message"]
    pkr = only_expenses["by_currency"]["PKR"]
    assert pkr["capital"]["ready"] is False and "closing" not in pkr["capital"] and pkr["trend"] == []  # no capital figure, and no trend
    assert pkr["profit_loss"]["expenses"] == "500.0000"  # but what happened is still reported


# ====================================================================================================== the opening position
def test_the_opening_position_establishes_capital_as_assets_minus_liabilities(api, org):
    response = api.client.post(OPENING, json={"currency_code": "PKR", "effective_date": today(), "assets": "8000000", "liabilities": "3000000", "notes": "Balance sheet of 31 October"},
                               headers={**api.headers, "Idempotency-Key": api.key()})
    assert response.status_code == 201 and response.json()["equity"] == "5000000.0000"
    pkr = block(api)
    assert pkr["capital"]["closing"] == "5000000.0000" and pkr["capital"]["basis"] == "opening_position" and pkr["investment"]["closing"] == "5000000.0000"
    assert summary(api)["setup_required"] is False and summary(api)["has_opening_position"] is True
    again = api.client.post(OPENING, json={"currency_code": "PKR", "effective_date": today(), "assets": "1", "liabilities": "0"}, headers={**api.headers, "Idempotency-Key": api.key()})
    assert again.status_code == 409 and again.json()["detail"]["code"] == "opening_exists"
    reversed_ = api.client.post(f"{OPENING}/{response.json()['id']}/reverse", json={"reason": "Wrong balance sheet"}, headers=api.headers)
    assert reversed_.status_code == 200 and reversed_.json()["status"] == "reversed"
    assert summary(api)["setup_required"] is True  # nothing establishes capital any more, and nothing is invented
    listed = api.get(OPENING).json()["items"]
    assert [(o["status"], o["reversal_reason"]) for o in listed] == [("reversed", "Wrong balance sheet")]  # kept, with why
    fresh = api.client.post(OPENING, json={"currency_code": "PKR", "effective_date": today(), "assets": "6000000", "liabilities": "1000000"}, headers={**api.headers, "Idempotency-Key": api.key()})
    assert fresh.status_code == 201 and block(api)["capital"]["closing"] == "5000000.0000"


def test_activity_before_the_opening_position_is_part_of_it_not_added_again(api, org, feeds, run_sync):
    item = product()
    stocked(api, org, feeds, run_sync, qty="10", price="100", currency="PKR", item=item, when=ago(days=5))
    deliver(feeds, org, item, "5", "300", when=ago(days=3), currency="PKR")  # a profit of 1,000 three days ago
    settle(run_sync, org)
    api.client.post(OPENING, json={"currency_code": "PKR", "effective_date": today(1), "assets": "50000", "liabilities": "0"}, headers={**api.headers, "Idempotency-Key": api.key()})
    pkr = block(api)
    assert pkr["profit_loss"]["gross_profit"] == "1000.0000"  # the period still reports what was earned in it
    assert pkr["capital"]["closing"] == "50000.0000"  # but the opening equity already contains it


# ====================================================================================================== Profit & Loss
def test_a_delivery_recognises_profit_once_from_the_actual_cost_and_the_agreed_price(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    deliver(feeds, org, item, "20", "120000")
    settle(run_sync, org)
    pkr = block(api)
    assert pkr["profit_loss"]["revenue"] == "2400000.0000" and pkr["profit_loss"]["cost_of_goods_sold"] == "2000000.0000" and pkr["profit_loss"]["gross_profit"] == "400000.0000"
    assert pkr["profit_loss"]["net"] == "400000.0000"
    assert pkr["capital"]["closing"] == "5400000.0000" and pkr["investment"]["closing"] == "5000000.0000"  # profit lifts capital by exactly that, once
    (sale,) = history(api, category="profitable_sales")["items"]
    assert (sale["amount"], sale["profit_loss"], sale["counterparty"], sale["transaction"], sale["status"]) == ("2400000.0000", "400000.0000", "Company A", "Sale delivered", "recognized")
    assert sale["description"] == "20 x Dell Latitude Laptop - SO-000001" and sale["source_type"] == "dispatch" and sale["unit_price"] == "120000.0000"
    assert history(api, category="loss_sales")["total"] == 0


def test_an_order_saved_or_reserved_but_not_delivered_has_no_effect(api, org, feeds, run_sync):
    invest(api, 5 * M)
    stocked(api, org, feeds, run_sync)
    # (an order and its reservation are not events of the feed at all: only a CONFIRMED dispatch is)
    pkr = block(api)
    assert pkr["profit_loss"]["net"] == "0.0000" and pkr["capital"]["closing"] == "5000000.0000"


def test_a_loss_making_sale_is_a_loss_from_the_historical_cost_and_lowers_capital(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    deliver(feeds, org, item, "20", "90000")  # sold below the 100,000 it cost
    settle(run_sync, org)
    pkr = block(api)
    assert pkr["profit_loss"]["gross_profit"] == "-200000.0000" and pkr["capital"]["closing"] == "4800000.0000"
    (sale,) = history(api, category="loss_sales")["items"]
    assert sale["profit_loss"] == "-200000.0000" and history(api, category="profitable_sales")["total"] == 0
    assert pkr["capital"]["change"]["direction"] == "down" or pkr["capital"]["change"]["state"] == "new"


def test_the_cost_is_the_weighted_average_of_what_was_actually_paid_never_the_product_cost_field(api, org, feeds, run_sync):
    invest(api, 20 * M)
    item = product("LAP-1", "Dell Latitude Laptop")
    stocked(api, org, feeds, run_sync, qty="50", price="100000", item=item, when=ago(hours=5))
    stocked(api, org, feeds, run_sync, qty="50", price="120000", item=item, when=ago(hours=4))  # (a second receipt: another receipt id is generated)
    deliver(feeds, org, item, "20", "150000")
    settle(run_sync, org)
    pkr = block(api)
    assert pkr["profit_loss"]["cost_of_goods_sold"] == "2200000.0000"  # 20 x the average of 100,000 and 120,000 = 110,000
    assert pkr["profit_loss"]["gross_profit"] == "800000.0000"
    costs = api.get(COSTS).json()["items"]
    assert [(c["quantity"], c["total_value"], c["average_cost"]) for c in costs] == [("80.0000", "8800000.0000", "110000.0000")]


def test_partial_deliveries_recognise_only_what_was_delivered(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    deliver(feeds, org, item, "8", "120000", when=ago(hours=2), number="DS-000001")
    settle(run_sync, org)
    assert block(api)["profit_loss"]["gross_profit"] == "160000.0000"
    deliver(feeds, org, item, "12", "120000", when=ago(hours=1), number="DS-000002")
    settle(run_sync, org)
    pkr = block(api)
    assert pkr["profit_loss"]["revenue"] == "2400000.0000" and pkr["profit_loss"]["gross_profit"] == "400000.0000" and pkr["capital"]["closing"] == "5400000.0000"
    assert history(api, category="profitable_sales")["total"] == 2


def test_the_same_delivery_read_twice_is_recognised_once(api, org, feeds, run_sync, session_factory):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    event = deliver(feeds, org, item, "20", "120000")
    settle(run_sync, org)
    feeds.events[("sales", org)].append(dict(event))
    settle(run_sync, org)
    settle(run_sync, org)
    with session_factory() as db:
        assert db.execute(text("SELECT count(*), sum(revenue), sum(cogs) FROM trade_deliveries")).one() == (1, D("2400000"), D("2000000"))
        assert db.execute(text("SELECT count(*) FROM cost_entries WHERE kind = 'delivery'")).scalar() == 1
        assert db.execute(text("SELECT quantity FROM inventory_costs")).scalar() == D("30")


def test_an_invoice_and_its_payment_recognise_no_second_revenue_and_no_profit(api, org, feeds, run_sync, session_factory):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    delivery = deliver(feeds, org, item, "20", "120000")
    settle(run_sync, org)
    before = block(api)
    line = delivery["data"]["lines"][0]["dispatch_line_id"]
    invoice = feeds.invoice_issued(org, currency="PKR", subtotal="2400000", total="2400000", when=ago(minutes=30), allocations=[
        {"dispatch_line_id": line, "dispatch_confirmed_at": delivery["time"], "quantity": "20", "net_amount": "2400000.0000"}])
    feeds.payment(org, invoice, amount="2400000", when=ago(minutes=10))
    settle(run_sync, org)
    after = block(api)
    assert after["profit_loss"] == before["profit_loss"] and after["capital"]["closing"] == before["capital"]["closing"] == "5400000.0000"
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM trade_adjustments")).scalar() == 0  # it billed exactly what delivery recognised


def test_unpaid_delivered_orders_are_profit_not_cash_and_a_payment_changes_nothing(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    deliver(feeds, org, item, "20", "120000")
    settle(run_sync, org)
    assert block(api)["capital"]["closing"] == "5400000.0000"  # delivered and not yet paid: the profit is already earned
    invoice = feeds.invoice_issued(org, currency="PKR", subtotal="2400000", total="2400000", when=ago(minutes=30))
    feeds.payment(org, invoice, amount="1000000", when=ago(minutes=5))  # even a part payment of an invoice with no delivery link changes nothing
    settle(run_sync, org)
    assert block(api)["capital"]["closing"] == "5400000.0000" and block(api)["profit_loss"]["net"] == "400000.0000"


def test_a_later_invoice_discount_is_an_adjustment_and_voiding_the_invoice_reverses_it(api, org, feeds, run_sync, session_factory):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    delivery = deliver(feeds, org, item, "20", "120000")
    line = delivery["data"]["lines"][0]["dispatch_line_id"]
    invoice = feeds.invoice_issued(org, number="INV-000009", currency="PKR", subtotal="2400000", discount="100000", total="2300000", when=ago(minutes=30), allocations=[
        {"dispatch_line_id": line, "dispatch_confirmed_at": delivery["time"], "quantity": "20", "net_amount": "2300000.0000"}])
    settle(run_sync, org)
    pkr = block(api)
    assert pkr["profit_loss"]["adjustments"] == "-100000.0000" and pkr["profit_loss"]["gross_profit"] == "400000.0000" and pkr["profit_loss"]["net"] == "300000.0000"
    assert pkr["capital"]["closing"] == "5300000.0000"
    (adjustment,) = [r for r in history(api, category="expenses_adjustments")["items"] if r["kind"] == "invoice_adjustment"]
    assert adjustment["profit_loss"] == "-100000.0000" and adjustment["reference"] == "INV-000009" and adjustment["source_type"] == "invoice" and adjustment["counterparty"] == "Company A"
    feeds.invoice_voided(org, invoice, when=ago(minutes=5))
    settle(run_sync, org)
    pkr = block(api)
    assert pkr["profit_loss"]["adjustments"] == "0.0000" and pkr["profit_loss"]["net"] == "400000.0000" and pkr["capital"]["closing"] == "5400000.0000"
    with session_factory() as db:
        assert db.execute(text("SELECT count(*), sum(amount) FROM trade_adjustments")).one() == (2, D("0"))  # both kept: the correction is an audit trail, not an erasure


def test_an_invoice_that_arrives_before_its_delivery_waits_and_then_adjusts(api, org, feeds, run_sync, session_factory):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    line = str(uuid.uuid4())
    feeds.invoice_issued(org, currency="PKR", subtotal="100", total="100", when=ago(minutes=30), allocations=[{"dispatch_line_id": line, "dispatch_confirmed_at": ago(hours=1).isoformat(), "quantity": "1", "net_amount": "100.0000"}])
    result = run_sync(org)
    assert result["retrying"] == 1 and result["failed"] == 0  # no adjustment is guessed: it waits for the delivery to be recognised
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM trade_adjustments")).scalar() == 0


def test_goods_delivered_before_finance_began_have_nothing_to_adjust(api, org, feeds, run_sync, session_factory):
    feeds.invoice_issued(org, currency="PKR", subtotal="100", total="100", when=ago(minutes=30), allocations=[
        {"dispatch_line_id": str(uuid.uuid4()), "dispatch_confirmed_at": before_activation().isoformat(), "quantity": "1", "net_amount": "90.0000"}])
    result = settle(run_sync, org)
    assert result["posted"] == 1
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM trade_adjustments")).scalar() == 0


def before_activation() -> datetime:
    return datetime(2026, 10, 1, tzinfo=timezone.utc)


def test_expenses_reduce_the_net_result_and_capital_and_a_reversal_gives_it_back(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    deliver(feeds, org, item, "20", "120000")
    settle(run_sync, org)
    expense = api.expense(post=True, amount="50000", currency_code="PKR", expense_date=today(), description="Warehouse rent", vendor="Landlord")
    pkr = block(api)
    assert pkr["profit_loss"]["expenses"] == "50000.0000" and pkr["profit_loss"]["gross_profit"] == "400000.0000" and pkr["profit_loss"]["net"] == "350000.0000"
    assert pkr["capital"]["closing"] == "5350000.0000"
    (row,) = [r for r in history(api, category="expenses_adjustments")["items"] if r["kind"] == "expense"]
    assert (row["amount"], row["profit_loss"], row["counterparty"], row["description"], row["source_type"]) == ("50000.0000", "-50000.0000", "Landlord", "Warehouse rent", "expense")
    assert api.client.post(f"{EXPENSES}/{expense['id']}/reverse", json={"reason": "Paid by the owner personally"}, headers=api.headers).status_code == 200
    pkr = block(api)
    assert pkr["profit_loss"]["expenses"] == "0.0000" and pkr["capital"]["closing"] == "5400000.0000"
    kinds = sorted(r["kind"] for r in history(api, category="expenses_adjustments")["items"])
    assert kinds == ["expense", "expense_reversal"]  # the history keeps both


def test_a_draft_expense_is_not_yet_a_cost(api, org):
    invest(api, 1000)
    api.expense(post=False, amount="400", currency_code="PKR", expense_date=today())
    assert block(api)["profit_loss"]["expenses"] == "0.0000"


def test_existing_expense_records_still_count_in_profit(api, org):
    invest(api, 1000)
    api.expense(post=True, amount="125.50", currency_code="PKR", expense_date=today(3))
    api.expense(post=True, amount="74.50", currency_code="PKR", expense_date=today(20))
    assert block(api, period="1w")["profit_loss"]["expenses"] == "125.5000"
    assert block(api, period="1m")["profit_loss"]["expenses"] == "200.0000"


# ====================================================================================================== missing prices and costs
def test_a_delivery_with_no_reliable_cost_shows_no_profit_and_asks_for_reconciliation(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = product("OLD-1", "Stock bought before Finance")
    deliver(feeds, org, item, "10", "50000")
    settle(run_sync, org)
    pkr = block(api)
    assert pkr["profit_loss"]["gross_profit"] == "0.0000" and pkr["profit_loss"]["net"] == "0.0000" and pkr["capital"]["closing"] == "5000000.0000"  # never a profit of 500,000, never a cost of zero
    assert pkr["profit_loss"]["needs_cost_count"] == 1 and pkr["profit_loss"]["needs_cost_revenue"] == "500000.0000"
    assert summary(api)["reconciliation"] == {"needs_cost": 1, "needs_price": 0, "total": 1}
    (row,) = history(api, category="reconciliation")["items"]
    assert row["status"] == "needs_cost" and row["profit_loss"] is None and row["amount"] == "500000.0000" and "needs cost reconciliation" in row["transaction"] and row["delivery_id"]
    assert history(api, category="profitable_sales")["total"] == 0 and history(api, category="loss_sales")["total"] == 0


def test_recording_the_cost_of_stock_already_held_settles_the_waiting_deliveries(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = product("OLD-1", "Stock bought before Finance")
    deliver(feeds, org, item, "10", "50000", when=ago(hours=2))
    settle(run_sync, org)
    response = api.client.post(COSTS, json={"product_id": item["id"], "sku": item["sku"], "name": item["name"], "quantity": "40", "unit_cost": "30000", "currency_code": "PKR", "effective_date": today(2)},
                               headers={**api.headers, "Idempotency-Key": api.key()})
    assert response.status_code == 201
    pkr = block(api)
    assert pkr["profit_loss"]["gross_profit"] == "200000.0000" and pkr["profit_loss"]["needs_cost_count"] == 0  # 10 x (50,000 - 30,000)
    assert api.get(COSTS).json()["items"][0]["quantity"] == "30.0000"
    assert summary(api)["reconciliation"]["total"] == 0


def test_a_later_goods_receipt_settles_a_delivery_that_was_waiting_for_a_cost(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = product("LAP-1", "Dell Latitude Laptop")
    deliver(feeds, org, item, "10", "50000", when=ago(hours=1))
    settle(run_sync, org)
    assert summary(api)["reconciliation"]["needs_cost"] == 1
    feeds.receipt(org, lines=(("100", "30000"),), currency="PKR", product=item, when=ago(hours=2))  # confirmed BEFORE the delivery, but read after it
    settle(run_sync, org)
    assert block(api)["profit_loss"]["gross_profit"] == "200000.0000" and summary(api)["reconciliation"]["total"] == 0


def test_a_delivery_is_never_costed_from_stock_in_another_currency(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync, currency="USD", qty="50", price="1000")
    deliver(feeds, org, item, "10", "150000", currency="PKR")
    settle(run_sync, org)
    assert summary(api)["reconciliation"]["needs_cost"] == 1  # a USD cost and a PKR price are never compared: no rate exists


def test_an_older_order_without_a_price_is_marked_and_never_valued_at_zero(api, org, feeds, run_sync):
    item = stocked(api, org, feeds, run_sync)
    feeds.delivery(org, lines=((item, "5", None),), currency=None, order=None, client="Walk-in", when=ago(hours=1))
    settle(run_sync, org)
    assert summary(api)["reconciliation"] == {"needs_cost": 0, "needs_price": 1, "total": 1}
    (row,) = history(api, category="reconciliation")["items"]
    assert row["status"] == "needs_price" and row["amount"] is None and row["profit_loss"] is None and "price" in row["notes"]
    assert api.get(RECON).json()["items"][0]["status"] == "needs_price"


def test_a_person_can_reconcile_the_price_and_the_cost_once_and_it_is_final_and_audited(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = product("OLD-9", "Old stock")
    feeds.delivery(org, lines=((item, "10", None),), currency=None, order=None, client="Walk-in", when=ago(hours=1))
    settle(run_sync, org)
    (waiting,) = api.get(RECON).json()["items"]
    path = f"{PREFIX}/deliveries/{waiting['delivery_id']}/reconcile"
    assert api.client.post(path, json={"reason": "Checked the paper order"}, headers=api.headers).status_code == 422  # nothing to settle with
    assert api.client.post(path, json={"unit_cost": "10", "reason": "Checked the paper order"}, headers=api.headers).json()["detail"]["code"] == "price_required"
    assert api.client.post(path, json={"unit_price": "50", "reason": "Checked the paper order"}, headers=api.headers).json()["detail"]["code"] == "currency_required"
    settled = api.client.post(path, json={"unit_price": "50", "currency_code": "PKR", "unit_cost": "30", "reason": "Checked the paper order"}, headers=api.headers)
    assert settled.status_code == 200 and (settled.json()["status"], settled.json()["revenue"], settled.json()["cogs"], settled.json()["profit"]) == ("recognized", "500.0000", "300.0000", "200.0000")
    assert block(api)["profit_loss"]["gross_profit"] == "200.0000"
    assert api.client.post(path, json={"unit_cost": "5", "reason": "Changed my mind"}, headers=api.headers).json()["detail"]["code"] == "already_recognized"
    detail = api.get(f"{PREFIX}/deliveries/{waiting['delivery_id']}").json()
    assert [h["action"] for h in detail["history"]] == ["needs_price", "reconciled"] and detail["reconciled_by_email"] == "admin-alpha@example.org"
    assert "Checked the paper order" in detail["history"][-1]["detail"]


# ====================================================================================================== periods and percentages
def test_the_three_periods_are_balances_at_their_end_compared_with_their_start(api, org):
    invest(api, 1 * M, day=today(40))  # before every period
    invest(api, 500_000, day=today(3))  # inside the week, the month and the year
    for period in ("1w", "1m"):
        capital = block(api, period=period)["capital"]
        assert (capital["opening"], capital["closing"]) == ("1000000.0000", "1500000.0000"), period
        assert capital["change"]["percent"] == "50.0" and capital["change"]["direction"] == "up" and capital["change"]["absolute"] == "500000.0000", period
    year = block(api, period="1y")["capital"]  # a year ago the owner had put nothing in: the baseline is zero, so the change is "New" with its absolute amount
    assert (year["opening"], year["closing"], year["change"]["state"], year["change"]["percent"], year["change"]["absolute"]) == ("0.0000", "1500000.0000", "new", None, "1500000.0000")
    invest(api, 250_000, day=today(20))  # inside the month and the year, but before the week
    assert (block(api, period="1w")["capital"]["opening"], block(api, period="1w")["capital"]["closing"]) == ("1250000.0000", "1750000.0000")
    month = block(api, period="1m")
    assert (month["capital"]["opening"], month["capital"]["closing"], month["capital"]["change"]["percent"]) == ("1000000.0000", "1750000.0000", "75.0")
    assert (month["investment"]["contributions"], month["investment"]["net_invested"]) == ("750000.0000", "750000.0000")
    week = block(api, period="1w")["investment"]
    assert week["contributions"] == "500000.0000"


def test_no_change_is_zero_percent_a_decrease_is_negative_and_a_zero_baseline_is_new(api, org):
    invest(api, 1 * M, day=today(40))
    flat = block(api, period="1w")["capital"]
    assert flat["change"] == {"absolute": "0.0000", "percent": "0.0", "state": "value", "direction": "flat"}
    invest(api, 250_000, kind="withdrawal", day=today(1))
    drop = block(api, period="1w")["capital"]["change"]
    assert drop == {"absolute": "-250000.0000", "percent": "-25.0", "state": "value", "direction": "down"}


def test_the_period_is_rolling_and_measured_in_the_organizations_time_zone(api, org, directory, two_orgs):
    from app import reporting
    from zoneinfo import ZoneInfo
    karachi = ZoneInfo("Asia/Karachi")
    at = datetime(2026, 3, 31, 12, 0, tzinfo=timezone.utc)
    start, end = reporting.period_bounds("1m", at, karachi)
    assert end == at and start.astimezone(karachi).strftime("%Y-%m-%d %H:%M") == "2026-02-28 17:00"  # one calendar month back, the day clamped
    assert reporting.period_bounds("1w", at, karachi)[0] == at - timedelta(days=7)
    start, _ = reporting.period_bounds("1y", datetime(2028, 2, 29, 9, 0, tzinfo=timezone.utc), ZoneInfo("UTC"))
    assert start == datetime(2027, 2, 28, 9, 0, tzinfo=timezone.utc)
    assert summary(api)["period"]["timezone"] == "UTC"
    directory.organizations[org]["timezone"] = "Asia/Karachi"
    assert summary(api)["period"]["timezone"] == "Asia/Karachi"
    directory.organizations[org]["timezone"] = "Not/AZone"
    assert summary(api)["period"]["timezone"] == "UTC"  # a bad zone is never trusted


def test_the_trend_is_one_balance_per_step_ending_at_the_closing_capital(api, org):
    invest(api, 1 * M, day=today(40))
    invest(api, 500_000, day=today(2))
    for period, steps in (("1w", 8), ("1m", 31), ("1y", 13)):
        trend = block(api, period=period)["trend"]
        assert len(trend) == steps and trend[-1]["capital"] == "1500000.0000"
    week = block(api, period="1w")["trend"]
    assert week[0]["capital"] == "1000000.0000" and [p["capital"] for p in week].count("1500000.0000") >= 2


def test_history_filters_the_period_and_pages(api, org):
    invest(api, 1000, day=today(40))
    for n in range(5):
        invest(api, 100 + n, day=today(n + 1))
    assert history(api, period="1w")["total"] == 5 and history(api, period="1y")["total"] == 6
    page = history(api, period="1y", limit=2, offset=2)
    assert [page["total"], page["limit"], page["offset"], len(page["items"])] == [6, 2, 2, 2]
    dates = [r["occurred_at"] for r in history(api, period="1y")["items"]]
    assert dates == sorted(dates, reverse=True)  # newest first
    assert api.get(HISTORY, params={"period": "2d"}).status_code == 422 and api.get(HISTORY, params={"category": "everything"}).status_code == 422


# ====================================================================================================== currencies
def test_different_currencies_are_never_added_and_combined_capital_is_unavailable(api, org):
    invest(api, 5 * M, currency="PKR")
    invest(api, 20_000, currency="USD")
    body = summary(api)
    assert body["currencies"] == ["PKR", "USD"] or body["currencies"] == ["USD", "PKR"]
    assert body["combined_available"] is False and "no exchange rates" in body["combined_note"]
    assert (body["by_currency"]["PKR"]["capital"]["closing"], body["by_currency"]["USD"]["capital"]["closing"]) == ("5000000.0000", "20000.0000")
    assert history(api, currency="USD")["total"] == 1 and history(api)["total"] == 2
    assert summary(api)["default_currency"] == "USD" and summary(api)["currencies"][0] == "USD"  # the organization's own currency first


def test_a_currency_without_an_opening_or_a_contribution_asks_for_a_setup_while_the_other_is_ready(api, org):
    invest(api, 1000, currency="PKR")
    api.expense(post=True, amount="5", currency_code="EUR", expense_date=today())
    body = summary(api)
    assert body["by_currency"]["PKR"]["capital"]["ready"] is True and body["by_currency"]["EUR"]["capital"]["ready"] is False
    assert body["setup_required"] is True and "EUR" in body["setup_message"]


# ====================================================================================================== isolation, integrity, history
def test_each_organization_sees_and_changes_only_its_own_books(api, org, two_orgs, feeds, run_sync):
    beta = two_orgs["beta"]
    beta.accounts()
    record = invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    deliver(feeds, org, item, "10", "120000")
    settle(run_sync, org)
    assert summary(beta)["currencies"] == [] and history(beta)["total"] == 0 and beta.get(COSTS).json()["items"] == [] and beta.get(RECON).json()["items"] == []
    assert beta.client.post(f"{INVEST}/{record['id']}/reverse", json={"reason": "not mine"}, headers=beta.headers).status_code == 404
    delivery_id = next(r["delivery_id"] for r in history(api)["items"] if r["kind"] == "sale")
    assert beta.get(f"{PREFIX}/deliveries/{delivery_id}").status_code == 404
    assert beta.client.post(f"{PREFIX}/deliveries/{delivery_id}/reconcile", json={"unit_cost": "1", "reason": "not mine"}, headers=beta.headers).status_code == 404
    assert block(api)["capital"]["closing"] == "5200000.0000"  # alpha's own profit, and nobody else's


def test_the_database_itself_refuses_to_rewrite_or_erase_a_recorded_fact(api, org, feeds, run_sync, session_factory):
    invest(api, 1000)
    item = stocked(api, org, feeds, run_sync, qty="10", price="5")
    deliver(feeds, org, item, "2", "9")
    settle(run_sync, org)
    from sqlalchemy.exc import DBAPIError
    statements = (
        "UPDATE capital_records SET description = 'changed'", "DELETE FROM capital_records", "UPDATE cost_entries SET value = 1", "DELETE FROM cost_entries",
        "DELETE FROM trade_deliveries", "UPDATE trade_deliveries SET quantity = 99", "UPDATE trade_deliveries SET unit_price = 1", "UPDATE trade_deliveries SET cogs = 1",
    )
    for sql in statements:
        with session_factory() as db:
            with pytest.raises(DBAPIError):
                db.execute(text(sql))
                db.commit()
    with session_factory() as db:
        db.execute(text("INSERT INTO opening_positions (organization_id, currency_code, effective_date, assets, liabilities, equity, created_by, created_by_email) "
                        "VALUES (:o, 'PKR', current_date, 10, 4, 6, gen_random_uuid(), 'x@example.org')"), {"o": org})
        db.commit()
        for sql in ("UPDATE opening_positions SET assets = 99, equity = 95", "DELETE FROM opening_positions"):
            with pytest.raises(DBAPIError):
                db.execute(text(sql))
                db.commit()
            db.rollback()


def test_the_audit_trail_names_who_and_what(api, org, session_factory):
    record = invest(api, 1000, description="Seed money")
    api.client.post(f"{INVEST}/{record['id']}/reverse", json={"reason": "typo"}, headers=api.headers)
    with session_factory() as db:
        rows = db.execute(text("SELECT entity_type, action, actor_email, source FROM finance_events WHERE entity_type = 'capital_record' ORDER BY seq")).all()
    assert [(r.action, r.actor_email, r.source) for r in rows] == [("recorded", "admin-alpha@example.org", "user"), ("reversed", "admin-alpha@example.org", "user"), ("recorded", "admin-alpha@example.org", "user")]


def test_the_existing_ledger_is_untouched_by_the_new_model(api, org, feeds, run_sync, session_factory):
    """The journal still records what it always did; the new model only reads the same events (docs/finance.md)."""
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    delivery = deliver(feeds, org, item, "20", "120000")
    feeds.invoice_issued(org, currency="PKR", subtotal="2400000", total="2400000", when=ago(minutes=30))
    settle(run_sync, org)
    with session_factory() as db:
        entries = db.execute(text("SELECT source_type, total FROM journal_entries ORDER BY entry_number")).all()
        assert [(e.source_type, e.total) for e in entries] == [("purchasing", D("5000000")), ("sales", D("2400000"))]  # the receipt and the invoice, as before: a delivery posts no entry
        assert db.execute(text("SELECT status, journal_entry_id IS NULL FROM sync_events WHERE event_type = 'delivery.confirmed'")).one() == ("posted", True)
    assert api.get(ACCOUNTS).status_code == 200 and api.get(f"{PREFIX}/overview").status_code == 200  # the older API is still served
    assert delivery["key"].startswith("delivery-confirmed:")


def test_a_day_and_six_months_are_periods_too(api, org):
    from app import reporting
    from zoneinfo import ZoneInfo
    at = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)
    assert reporting.period_bounds("1d", at, ZoneInfo("UTC"))[0] == at - timedelta(days=1)
    assert reporting.period_bounds("6m", at, ZoneInfo("UTC"))[0] == datetime(2026, 2, 28, 12, 0, tzinfo=timezone.utc)  # six calendar months back, the day clamped
    invest(api, 1 * M, day=today(100))  # before a 6-month period... no: 100 days is INSIDE six months, before a month and a week
    invest(api, 500_000, day=today(0))
    assert summary(api, "1d")["period"]["label"] == "1 Day" and summary(api, "6m")["period"]["label"] == "6 Months"
    day, half = block(api, period="1d"), block(api, period="6m")
    assert (day["capital"]["opening"], day["capital"]["closing"]) == ("1000000.0000", "1500000.0000")
    assert (half["capital"]["opening"], half["capital"]["closing"]) == ("0.0000", "1500000.0000") and half["capital"]["change"]["state"] == "new"
    assert len(day["trend"]) == 25 and len(half["trend"]) == 27
    assert history(api, period="1d")["total"] == 1 and history(api, period="6m")["total"] == 2


# ====================================================================================================== the Profit & Loss trend (diverging bars)
TREND = f"{PREFIX}/pnl-trend"


def trend(api, period="1m"):
    response = api.get(TREND, params={"period": period})
    assert response.status_code == 200, response.text
    return response.json()


def trend_block(api, currency="PKR", period="1m"):
    return trend(api, period)["by_currency"][currency]


def test_the_example_delivers_20_laptops_and_pays_50000_of_expenses_net_350000(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    deliver(feeds, org, item, "20", "120000")
    settle(run_sync, org)
    api.expense(post=True, amount="50000", currency_code="PKR", expense_date=today())
    chart = trend_block(api, period="1w")
    assert len(chart["buckets"]) == 7 and chart["totals"]["net"] == "350000.0000"
    (hit,) = [b for b in chart["buckets"] if b["has_activity"]]
    assert (hit["revenue"], hit["cost_of_goods_sold"], hit["expenses"], hit["other_costs"], hit["net"]) == ("2400000.0000", "2000000.0000", "50000.0000", "50000.0000", "350000.0000")
    assert chart["totals"]["profitable_periods"] == 1 and chart["totals"]["loss_periods"] == 0


def test_the_buckets_add_up_to_the_summary_in_every_period(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    deliver(feeds, org, item, "20", "120000", when=ago(days=2), number="DS-000001")
    deliver(feeds, org, item, "10", "80000", when=ago(hours=2), number="DS-000002")  # a loss
    settle(run_sync, org)
    api.expense(post=True, amount="30000", currency_code="PKR", expense_date=today(4))
    api.expense(post=True, amount="5000", currency_code="PKR", expense_date=today(0))
    for period in ("1d", "1w", "1m", "6m", "1y"):
        chart = trend_block(api, period=period)
        assert chart["totals"]["net"] == block(api, period=period)["profit_loss"]["net"], period
        assert sum(D(b["net"]) for b in chart["buckets"]) == D(chart["totals"]["net"])
    week = trend_block(api, period="1w")
    nets = [D(b["net"]) for b in week["buckets"]]
    assert any(n > 0 for n in nets) and any(n < 0 for n in nets)  # a profitable day and a loss-making day
    assert week["totals"]["profitable_periods"] >= 1 and week["totals"]["loss_periods"] >= 1


def test_each_filter_groups_by_its_own_unit_and_the_buckets_are_consecutive(api, org):
    invest(api, 1000)
    expected = {"1d": ("hour", 24), "1w": ("day", 7), "6m": ("month", 6), "1y": ("month", 12)}
    for period, (unit, count) in expected.items():
        body = trend(api, period)
        chart = body["by_currency"]["PKR"]
        assert (body["granularity"], len(chart["buckets"])) == (unit, count), period
        assert chart["buckets"][0]["start"] == body["period"]["start"] and chart["buckets"][-1]["end"] == body["period"]["end"]
        assert all(a["end"] == b["start"] for a, b in zip(chart["buckets"], chart["buckets"][1:]))  # no gap, no overlap
    month = trend(api, "1m")
    buckets = month["by_currency"]["PKR"]["buckets"]
    spans = [(datetime.fromisoformat(b["end"]) - datetime.fromisoformat(b["start"])).total_seconds() / 86400 for b in buckets]
    assert month["granularity"] == "week" and all(s == 7 for s in spans[:-1]) and 0 < spans[-1] <= 7  # consecutive weeks, a shorter final one


def test_a_period_with_no_activity_is_not_a_profit_or_a_loss(api, org):
    invest(api, 1000)
    chart = trend_block(api, period="1w")
    assert chart["totals"] == {"net": "0.0000", "profitable_periods": 0, "loss_periods": 0, "has_activity": False, "needs_cost_count": 0}
    assert all(b["net"] == "0.0000" and b["has_activity"] is False for b in chart["buckets"])


def test_zero_net_is_activity_that_balances_out(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    deliver(feeds, org, item, "10", "110000")  # 10 x (110,000 - 100,000) = 100,000 profit...
    settle(run_sync, org)
    api.expense(post=True, amount="100000", currency_code="PKR", expense_date=today())  # ...fully spent
    chart = trend_block(api, period="1w")
    assert chart["totals"]["net"] == "0.0000" and chart["totals"]["has_activity"] is True
    assert chart["totals"]["profitable_periods"] == 0 and chart["totals"]["loss_periods"] == 0  # a zero net is neither


def test_orders_invoices_and_payments_do_not_move_the_chart_and_a_discount_is_an_adjustment(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    delivery = deliver(feeds, org, item, "20", "120000")
    settle(run_sync, org)
    before = trend_block(api, period="1w")["totals"]["net"]
    line = delivery["data"]["lines"][0]["dispatch_line_id"]
    invoice = feeds.invoice_issued(org, currency="PKR", subtotal="2300000", total="2300000", when=ago(minutes=30), allocations=[
        {"dispatch_line_id": line, "dispatch_confirmed_at": delivery["time"], "quantity": "20", "net_amount": "2300000.0000"}])
    feeds.payment(org, invoice, amount="2300000", when=ago(minutes=10))
    settle(run_sync, org)
    chart = trend_block(api, period="1w")
    assert before == "400000.0000" and chart["totals"]["net"] == "300000.0000"  # only the 100,000 discount adjustment changed it; the payment added nothing
    (hit,) = [b for b in chart["buckets"] if b["has_activity"]]
    assert (hit["revenue"], hit["adjustments"], hit["other_costs"]) == ("2400000.0000", "-100000.0000", "100000.0000")  # a discount is a cost to the business


def test_a_delivery_that_needs_a_cost_is_counted_but_never_valued(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = product("OLD-1", "Stock from before Finance")
    deliver(feeds, org, item, "10", "50000")
    settle(run_sync, org)
    body = trend(api, "1w")
    chart = body["by_currency"]["PKR"]
    assert chart["totals"]["net"] == "0.0000" and chart["totals"]["has_activity"] is False and chart["totals"]["needs_cost_count"] == 1
    assert body["incomplete"] == {"needs_price": 0, "needs_cost": 1}
    assert sum(b["needs_cost_count"] for b in chart["buckets"]) == 1


def test_partial_deliveries_land_in_their_own_buckets(api, org, feeds, run_sync):
    invest(api, 5 * M)
    item = stocked(api, org, feeds, run_sync)
    deliver(feeds, org, item, "8", "120000", when=ago(days=3), number="DS-000001")
    deliver(feeds, org, item, "12", "120000", when=ago(hours=1), number="DS-000002")
    settle(run_sync, org)
    chart = trend_block(api, period="1w")
    nets = [b["net"] for b in chart["buckets"] if b["has_activity"]]
    assert nets == ["160000.0000", "240000.0000"] and chart["totals"]["net"] == "400000.0000"


def test_currencies_are_charted_separately_and_isolated_per_tenant(api, org, two_orgs, feeds, run_sync):
    beta = two_orgs["beta"]
    beta.accounts()
    invest(api, 1000, currency="PKR")
    api.expense(post=True, amount="5", currency_code="USD", expense_date=today())
    body = trend(api, "1w")
    assert sorted(body["currencies"]) == ["PKR", "USD"] and body["combined_available"] is False
    assert body["by_currency"]["USD"]["totals"]["net"] == "-5.0000" and body["by_currency"]["PKR"]["totals"]["net"] == "0.0000"
    assert body["by_currency"]["USD"]["totals"]["loss_periods"] == 1
    empty = trend(beta, "1w")
    assert empty["currencies"] == [] and empty["by_currency"] == {}
