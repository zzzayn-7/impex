"""The chart of accounts: the starter chart, management, and protection of the accounts Finance itself posts to."""
import pytest
from sqlalchemy import text

from conftest import ACCOUNTS, PREFIX


def test_the_first_request_creates_the_starter_chart_with_all_five_types(api):
    accounts = api.accounts()
    assert {a["account_type"] for a in accounts} == {"asset", "liability", "equity", "revenue", "expense"}
    system = {a["system_key"]: a for a in accounts if a["is_system"]}
    assert set(system) == {"payments_received", "accounts_receivable", "inventory", "sales_tax_payable", "goods_received_not_invoiced", "accrued_expenses", "opening_balance_equity", "sales_revenue"}
    assert all(a["is_active"] and not a["has_postings"] for a in accounts)
    assert [a["code"] for a in accounts] == sorted(a["code"] for a in accounts)


def test_the_chart_is_created_once_and_never_duplicated(api):
    first = api.accounts()
    assert [a["id"] for a in api.accounts()] == [a["id"] for a in first]
    assert len({a["code"] for a in first}) == len(first)


def test_create_update_deactivate_and_reactivate_an_account(api):
    account = api.new_account("5600", "  Marketing   and ads ", description="Campaigns")
    assert (account["code"], account["name"], account["account_type"], account["is_system"], account["is_active"]) == ("5600", "Marketing and ads", "expense", False, True)
    changed = api.client.patch(f"{ACCOUNTS}/{account['id']}", json={"name": "Marketing", "description": ""}, headers=api.headers)
    assert changed.status_code == 200 and changed.json()["name"] == "Marketing"
    off = api.client.patch(f"{ACCOUNTS}/{account['id']}", json={"is_active": False}, headers=api.headers).json()
    assert off["is_active"] is False
    assert account["id"] not in [a["id"] for a in api.accounts(active="true")]
    assert api.client.patch(f"{ACCOUNTS}/{account['id']}", json={"is_active": True}, headers=api.headers).json()["is_active"] is True


def test_codes_are_unique_per_organization_and_validated(api, two_orgs):
    api.new_account("7000", "First")
    duplicate = api.client.post(ACCOUNTS, json={"code": "7000", "name": "Second", "account_type": "expense"}, headers=api.headers)
    assert duplicate.status_code == 409 and duplicate.json()["detail"]["code"] == "duplicate_code"
    two_orgs["beta"].accounts()  # another organization may use the same code
    assert two_orgs["beta"].new_account("7000", "Beta's own")["code"] == "7000"
    for bad in ({"code": "bad code"}, {"code": ""}, {"code": "x" * 21}, {"account_type": "income"}, {"name": ""}, {"organization_id": "00000000-0000-0000-0000-000000000000"}, {"is_system": True}):
        body = {"code": "8000", "name": "N", "account_type": "asset", **bad}
        assert api.client.post(ACCOUNTS, json=body, headers=api.headers).status_code == 422, bad


def test_a_system_account_cannot_be_deleted_deactivated_or_changed_in_code_or_type(api):
    receivable = next(a for a in api.accounts() if a["system_key"] == "accounts_receivable")
    url = f"{ACCOUNTS}/{receivable['id']}"
    assert api.client.delete(url, headers=api.headers).json()["detail"]["code"] == "account_protected"
    for change in ({"is_active": False}, {"code": "1199"}, {"account_type": "liability"}):
        refused = api.client.patch(url, json=change, headers=api.headers)
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "account_protected", change
    renamed = api.client.patch(url, json={"name": "Trade Debtors", "description": "Money customers owe"}, headers=api.headers)
    assert renamed.status_code == 200 and renamed.json()["name"] == "Trade Debtors" and renamed.json()["system_key"] == "accounts_receivable"
    assert api.client.patch(url, json={"code": receivable["code"], "is_active": True}, headers=api.headers).status_code == 200  # saying what is already true is fine


def test_an_account_with_postings_keeps_its_code_and_type_and_cannot_be_deleted(api):
    account = api.new_account("5700", "Insurance")
    unused = api.client.patch(f"{ACCOUNTS}/{account['id']}", json={"code": "5701"}, headers=api.headers)
    assert unused.status_code == 200 and unused.json()["code"] == "5701"
    api.entry([(account["id"], "10", "0"), (api.acct("2300"), "0", "10")], post=True)
    used = api.client.get(f"{ACCOUNTS}/{account['id']}", headers=api.headers).json()
    assert used["has_postings"] is True
    for change in ({"code": "5702"}, {"account_type": "asset"}):
        refused = api.client.patch(f"{ACCOUNTS}/{account['id']}", json=change, headers=api.headers)
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "account_in_use"
    assert api.client.patch(f"{ACCOUNTS}/{account['id']}", json={"name": "Insurance premiums"}, headers=api.headers).status_code == 200
    assert api.client.delete(f"{ACCOUNTS}/{account['id']}", headers=api.headers).json()["detail"]["code"] == "account_in_use"


def test_an_unused_account_can_be_deleted(api):
    account = api.new_account("5800", "Temporary")
    assert api.client.delete(f"{ACCOUNTS}/{account['id']}", headers=api.headers).status_code == 204
    assert api.client.get(f"{ACCOUNTS}/{account['id']}", headers=api.headers).status_code == 404


def test_an_inactive_account_cannot_be_used_on_an_entry_or_expense(api):
    account = api.new_account("5900", "Dormant")
    api.client.patch(f"{ACCOUNTS}/{account['id']}", json={"is_active": False}, headers=api.headers)
    refused = api.client.post(f"{PREFIX}/journal-entries", json={"entry_date": "2026-11-05", "description": "x", "lines": [{"account_id": account["id"], "debit": "1"}, {"account_id": api.acct("2300"), "credit": "1"}]}, headers={**api.headers, "Idempotency-Key": "inactive-key-1"})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "inactive_account"
    expense = api.client.post(f"{PREFIX}/expenses", json={"expense_date": "2026-11-05", "description": "x", "account_id": account["id"], "amount": "1"}, headers={**api.headers, "Idempotency-Key": "inactive-key-2"})
    assert expense.status_code == 422 and expense.json()["detail"]["code"] == "inactive_account"


def test_a_draft_that_later_meets_an_inactive_account_cannot_be_posted(api):
    account = api.new_account("5950", "Soon dormant")
    draft = api.entry([(account["id"], "5", "0"), (api.acct("2300"), "0", "5")])
    api.client.patch(f"{ACCOUNTS}/{account['id']}", json={"is_active": False}, headers=api.headers)
    refused = api.client.post(f"{PREFIX}/journal-entries/{draft['id']}/post", headers=api.headers)
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "inactive_account"
    assert api.client.get(f"{PREFIX}/journal-entries/{draft['id']}", headers=api.headers).json()["status"] == "draft"


def test_filters_and_search_treat_wildcards_literally(api):
    api.new_account("6001", "Fifty% discount", "expense")
    assert [a["code"] for a in api.accounts(q="50%")] == []
    assert [a["code"] for a in api.accounts(q="ty% disc")] == ["6001"]
    assert {a["account_type"] for a in api.accounts(type="liability")} == {"liability"}
    assert api.client.get(ACCOUNTS, params={"type": "bogus"}, headers=api.headers).status_code == 422


def test_every_account_change_is_audited_with_who_did_it(api, session_factory):
    account = api.new_account("6100", "Audited")
    api.client.patch(f"{ACCOUNTS}/{account['id']}", json={"name": "Audited 2"}, headers=api.headers)
    api.client.patch(f"{ACCOUNTS}/{account['id']}", json={"is_active": False}, headers=api.headers)
    api.client.delete(f"{ACCOUNTS}/{account['id']}", headers=api.headers)
    with session_factory() as db:
        rows = db.execute(text("SELECT action, actor_email, source, detail FROM finance_events WHERE entity_id = :i ORDER BY seq"), {"i": account["id"]}).all()
    assert [r.action for r in rows] == ["created", "updated", "deactivated", "deleted"]
    assert {r.actor_email for r in rows} == {"admin-alpha@example.org"} and {r.source for r in rows} == {"user"}
    assert "name: 'Audited' -> 'Audited 2'" in rows[1].detail
