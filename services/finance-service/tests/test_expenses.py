"""Expenses: record, categorize, post, reverse. Recording an expense never moves money."""
import threading

from sqlalchemy import text

from conftest import ACCOUNTS, ENTRIES, EXPENSES, PREFIX


def test_a_draft_expense_is_numbered_categorized_and_not_in_the_books(api, session_factory):
    expense = api.expense(reference="RCPT-9", vendor="Paper Co", description="  Printer   paper ")
    assert (expense["number"], expense["status"], expense["description"], expense["account_code"], expense["currency_code"]) == ("EXP-000001", "draft", "Printer paper", "5000", "USD")
    assert (expense["amount"], expense["reference"], expense["vendor"], expense["journal_entry_id"]) == ("25.5000", "RCPT-9", "Paper Co", None)
    assert expense["created_by_email"] == "admin-alpha@example.org" and [h["action"] for h in expense["history"]] == ["created"]
    assert api.entries()["total"] == 0  # a draft is not in the books
    assert api.expense()["number"] == "EXP-000002"


def test_posting_an_expense_debits_the_expense_account_and_credits_accrued_expenses_never_a_bank(api):
    expense = api.expense(post=True, amount="80.40", currency_code="EUR", vendor="Courier Ltd")
    assert expense["status"] == "posted" and expense["journal_entry_id"] and expense["posted_by_email"] == "admin-alpha@example.org" and expense["posted_at"]
    entry = api.client.get(f"{ENTRIES}/{expense['journal_entry_id']}", headers=api.headers).json()
    assert entry["source_type"] == "expense" and entry["currency_code"] == "EUR" and entry["source_summary"] == f"Expense {expense['number']}" and entry["reference"] == expense["number"]
    assert [(l["account_code"], l["debit"], l["credit"]) for l in entry["lines"]] == [("5000", "80.4000", "0.0000"), ("2300", "0.0000", "80.4000")]
    assert not any(l["account_code"] in ("1050",) for l in entry["lines"])  # no payments-received / bank-like account is touched
    assert [h["action"] for h in expense["history"]] == ["created", "posted"]
    assert api.get(f"{PREFIX}/overview").json()["totals_by_currency"][0]["liabilities"] == "80.4000"


def test_a_draft_can_be_edited_posted_and_deleted_a_posted_expense_cannot(api):
    draft = api.expense()
    body = {"expense_date": "2026-11-06", "description": "Corrected", "account_id": api.acct("5300"), "amount": "30", "currency_code": "gbp", "reference": None, "vendor": "V"}
    edited = api.client.put(f"{EXPENSES}/{draft['id']}", json=body, headers=api.headers)
    assert edited.status_code == 200 and (edited.json()["amount"], edited.json()["currency_code"], edited.json()["account_code"]) == ("30.0000", "GBP", "5300")
    posted = api.client.post(f"{EXPENSES}/{draft['id']}/post", headers=api.headers)
    assert posted.status_code == 200 and posted.json()["status"] == "posted"
    assert api.client.put(f"{EXPENSES}/{draft['id']}", json=body, headers=api.headers).json()["detail"]["code"] == "not_editable"
    assert api.client.delete(f"{EXPENSES}/{draft['id']}", headers=api.headers).status_code == 409
    again = api.client.post(f"{EXPENSES}/{draft['id']}/post", headers=api.headers)
    assert again.status_code == 409 and again.json()["detail"]["code"] == "already_posted"
    other = api.expense()
    assert api.client.delete(f"{EXPENSES}/{other['id']}", headers=api.headers).status_code == 204
    assert api.client.get(f"{EXPENSES}/{other['id']}", headers=api.headers).status_code == 404


def test_reversing_a_posted_expense_posts_a_mirror_entry_and_keeps_everything(api, session_factory):
    expense = api.expense(post=True, amount="12.00")
    reversed_ = api.client.post(f"{EXPENSES}/{expense['id']}/reverse", json={"reason": "Duplicate receipt"}, headers=api.headers)
    assert reversed_.status_code == 200
    body = reversed_.json()
    assert body["status"] == "reversed" and body["reversal_reason"] == "Duplicate receipt" and body["reversed_by_email"] == "admin-alpha@example.org" and body["reversal_entry_id"]
    assert body["journal_entry_id"] == expense["journal_entry_id"] and body["amount"] == "12.0000"
    assert [h["action"] for h in body["history"]] == ["created", "posted", "reversed"]
    reversal = api.client.get(f"{ENTRIES}/{body['reversal_entry_id']}", headers=api.headers).json()
    assert reversal["source_type"] == "reversal" and reversal["reverses_entry_id"] == expense["journal_entry_id"]
    assert api.get(f"{PREFIX}/overview").json()["totals_by_currency"][0]["expenses"] == "0.0000"
    twice = api.client.post(f"{EXPENSES}/{expense['id']}/reverse", json={"reason": "Once more"}, headers=api.headers)
    assert twice.status_code == 409 and twice.json()["detail"]["code"] == "already_reversed"
    assert api.client.post(f"{EXPENSES}/{api.expense()['id']}/reverse", json={"reason": "A draft"}, headers=api.headers).json()["detail"]["code"] == "not_posted"
    with session_factory() as db:
        assert db.execute(text("SELECT status FROM journal_entries WHERE id = :i"), {"i": expense["journal_entry_id"]}).scalar() == "posted"  # the original entry still stands


def test_an_expenses_entry_can_only_be_reversed_through_the_expense(api):
    expense = api.expense(post=True)
    refused = api.client.post(f"{ENTRIES}/{expense['journal_entry_id']}/reverse", json={"reason": "Sneaky reversal"}, headers=api.headers)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "reverse_via_expense"
    assert api.client.get(f"{ENTRIES}/{expense['journal_entry_id']}", headers=api.headers).json()["can_reverse"] is False


def test_only_an_active_expense_account_of_this_organization_can_categorize_an_expense(api, two_orgs):
    for code in ("1100", "2300", "4000", "3000"):
        refused = api.client.post(EXPENSES, json={"expense_date": "2026-11-05", "description": "x", "account_id": api.acct(code), "amount": "1"}, headers={**api.headers, "Idempotency-Key": f"cat-key-{code}"})
        assert refused.status_code == 422 and refused.json()["detail"]["code"] == "not_an_expense_account", code
    two_orgs["beta"].accounts()
    foreign = api.client.post(EXPENSES, json={"expense_date": "2026-11-05", "description": "x", "account_id": two_orgs["beta"].acct("5000"), "amount": "1"}, headers={**api.headers, "Idempotency-Key": "cat-key-foreign"})
    assert foreign.status_code == 422 and foreign.json()["detail"]["code"] == "unknown_account"


def test_amounts_dates_and_unknown_fields_are_validated(api):
    base = {"expense_date": "2026-11-05", "description": "x", "account_id": api.acct("5000"), "amount": "1"}
    for change in ({"amount": "0"}, {"amount": "-5"}, {"amount": "1.23456"}, {"amount": "abc"}, {"description": ""}, {"expense_date": "yesterday"}, {"currency_code": "ZZZ"},
                   {"status": "posted"}, {"number": "EXP-1"}, {"organization_id": "00000000-0000-0000-0000-000000000000"}, {"journal_entry_id": "00000000-0000-0000-0000-000000000000"}):
        assert api.client.post(EXPENSES, json={**base, **change}, headers={**api.headers, "Idempotency-Key": "validate-key-1"}).status_code == 422, change


def test_expense_creation_is_idempotent(api):
    first = api.expense(post=True, key="expense-key-0001")
    again = api.expense(post=True, key="expense-key-0001", expect=200)
    assert again["id"] == first["id"] and again["number"] == first["number"] and again["journal_entry_id"] == first["journal_entry_id"]
    assert api.get(EXPENSES).json()["total"] == 1 and api.entries()["total"] == 1
    refused = api.client.post(EXPENSES, json={"expense_date": "2026-11-05", "description": "different", "account_id": api.acct("5000"), "amount": "9"}, headers={**api.headers, "Idempotency-Key": "expense-key-0001"})
    assert refused.status_code == 409


def test_concurrent_posting_of_one_expense_posts_it_once(api, session_factory):
    expense = api.expense()
    results = []
    threads = [threading.Thread(target=lambda: results.append(api.client.post(f"{EXPENSES}/{expense['id']}/post", headers=api.headers))) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(r.status_code for r in results) == [200] + [409] * 7
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM journal_entries")).scalar() == 1


def test_a_posting_that_fails_leaves_the_expense_a_draft_and_no_entry(api, session_factory, monkeypatch):
    from app import ledger

    expense = api.expense()

    def broken(*args, **kwargs):
        raise RuntimeError("database went away")

    monkeypatch.setattr(ledger, "post_locked", broken)
    try:
        api.client.post(f"{EXPENSES}/{expense['id']}/post", headers=api.headers)
    except RuntimeError:
        pass
    monkeypatch.undo()
    assert api.client.get(f"{EXPENSES}/{expense['id']}", headers=api.headers).json()["status"] == "draft"
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM journal_entries")).scalar() == 0
        assert db.execute(text("SELECT last_number FROM finance_counters WHERE name = 'journal'")).scalar_one_or_none() in (None, 0)
    assert api.client.post(f"{EXPENSES}/{expense['id']}/post", headers=api.headers).status_code == 200  # and it can still be posted


def test_listing_filters_and_search(api):
    a = api.expense(description="Taxi to port", vendor="CityCab", account="5300", expense_date="2026-10-02")
    b = api.expense(description="Office chairs", account="5400", amount="300", currency_code="EUR", post=True, expense_date="2026-11-09")
    listing = lambda **p: api.client.get(EXPENSES, params=p, headers=api.headers).json()  # noqa: E731
    assert listing()["total"] == 2
    assert [e["id"] for e in listing(q="taxi")["items"]] == [a["id"]] and [e["id"] for e in listing(q="citycab")["items"]] == [a["id"]]
    assert [e["id"] for e in listing(status="posted")["items"]] == [b["id"]]
    assert [e["id"] for e in listing(currency="eur")["items"]] == [b["id"]]
    assert [e["id"] for e in listing(account_id=api.acct("5300"))["items"]] == [a["id"]]
    assert [e["id"] for e in listing(date_from="2026-11-01")["items"]] == [b["id"]]
    assert listing(q="%")["total"] == 0 and listing(limit=1)["total"] == 2 and len(listing(limit=1)["items"]) == 1
    assert [x["number"] for x in listing()["items"]] == ["EXP-000002", "EXP-000001"]  # newest first
