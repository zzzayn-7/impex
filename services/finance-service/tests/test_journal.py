"""The double-entry journal: balanced entries, exact decimals, one currency per entry, immutability, idempotency, concurrency and reversals."""
import threading
from decimal import Decimal

import pytest
from sqlalchemy import text

from conftest import ENTRIES, PREFIX


# ----------------------------------------------------------------------------------------------------------- balanced / unbalanced
def test_a_balanced_entry_posts_with_a_number_a_total_and_provenance(api):
    entry = api.balanced(amount="125.50", description="Opening sale", reference="REF-1")
    assert entry["status"] == "posted" and entry["entry_number"] == "JE-000001" and entry["total"] == "125.5000"
    assert (entry["total_debit"], entry["total_credit"], entry["is_balanced"]) == ("125.5000", "125.5000", True)
    assert entry["source_type"] == "manual" and entry["currency_code"] == "USD" and entry["reference"] == "REF-1"
    assert entry["created_by_email"] == entry["posted_by_email"] == "admin-alpha@example.org" and entry["posted_at"]
    assert [(line["account_code"], line["debit"], line["credit"]) for line in entry["lines"]] == [("1100", "125.5000", "0.0000"), ("4000", "0.0000", "125.5000")]
    assert [(h["action"], h["actor_email"], h["source"]) for h in entry["history"]] == [("created", "admin-alpha@example.org", "user"), ("posted", "admin-alpha@example.org", "user")]
    assert api.balanced()["entry_number"] == "JE-000002"


def test_an_unbalanced_entry_cannot_be_posted_and_leaves_nothing_behind(api):
    refused = api.client.post(ENTRIES, json={"entry_date": "2026-11-05", "description": "Off by a cent", "post": True, "lines": [
        {"account_id": api.acct("1100"), "debit": "100.00"}, {"account_id": api.acct("4000"), "credit": "99.99"}]}, headers={**api.headers, "Idempotency-Key": "unbalanced-1"})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "unbalanced"
    assert "0.01" in refused.json()["detail"]["message"] and refused.json()["detail"]["debits"] == "100.0000"
    assert api.entries()["total"] == 0  # not even a draft was kept
    assert api.client.post(ENTRIES, json={"entry_date": "2026-11-05", "description": "retry", "post": True, "lines": []}, headers={**api.headers, "Idempotency-Key": "unbalanced-1"}).status_code == 422  # the refused request released its key


def test_an_unbalanced_draft_can_be_saved_but_never_posted(api):
    draft = api.entry([(api.acct("1100"), "100", "0"), (api.acct("4000"), "0", "60")])
    assert draft["status"] == "draft" and draft["entry_number"] is None and draft["is_balanced"] is False
    refused = api.client.post(f"{ENTRIES}/{draft['id']}/post", headers=api.headers)
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "unbalanced"
    assert api.client.get(f"{ENTRIES}/{draft['id']}", headers=api.headers).json()["status"] == "draft"
    fixed = api.client.put(f"{ENTRIES}/{draft['id']}", json={"entry_date": "2026-11-05", "description": "Fixed", "currency_code": "USD", "lines": [
        {"account_id": api.acct("1100"), "debit": "100"}, {"account_id": api.acct("4000"), "credit": "100"}]}, headers=api.headers)
    assert fixed.status_code == 200 and fixed.json()["is_balanced"] is True
    assert api.post(draft["id"])["status"] == "posted"


@pytest.mark.parametrize("lines,code", [
    ([("1100", "100", "0")], "too_few_lines"),
    ([], "too_few_lines"),
    ([("1100", "0", "0"), ("4000", "0", "0")], "invalid_line"),
    ([("1100", "5", "5"), ("4000", "0", "0")], "invalid_line"),
])
def test_an_entry_needs_two_real_lines_each_with_one_side(api, lines, code):
    body = {"entry_date": "2026-11-05", "description": "Bad", "post": True, "lines": [{"account_id": api.acct(c), "debit": d, "credit": cr} for c, d, cr in lines]}
    refused = api.client.post(ENTRIES, json=body, headers={**api.headers, "Idempotency-Key": f"shape-{code}-{len(lines)}"})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == code


@pytest.mark.parametrize("amount", ["-1", "1.00001", "1e30", "abc", "NaN", "Infinity", "100000000000000.0001"])
def test_amounts_must_be_exact_non_negative_decimals_with_at_most_four_places(api, amount):
    body = {"entry_date": "2026-11-05", "description": "Bad", "lines": [{"account_id": api.acct("1100"), "debit": amount}, {"account_id": api.acct("4000"), "credit": "1"}]}
    assert api.client.post(ENTRIES, json=body, headers={**api.headers, "Idempotency-Key": "bad-amount-1"}).status_code == 422


def test_decimals_are_exact_not_floating_point(api):
    entry = api.entry([(api.acct("1100"), "0.3", "0"), (api.acct("4000"), "0", "0.1"), (api.acct("2100"), "0", "0.2")], post=True)  # 0.1 + 0.2 == 0.3 here, as it must
    assert entry["total"] == "0.3000"
    third = api.entry([(api.acct("1100"), "1.0000", "0"), (api.acct("4000"), "0", "0.3333"), (api.acct("2100"), "0", "0.3333"), (api.acct("2200"), "0", "0.3334")], post=True)
    assert third["total_credit"] == "1.0000"
    big = api.entry([(api.acct("1100"), "99999999999999.9999", "0"), (api.acct("4000"), "0", "99999999999999.9999")], post=True)
    assert big["total"] == "99999999999999.9999"
    assert api.client.post(ENTRIES, json={"entry_date": "2026-11-05", "description": "x", "post": True, "lines": [
        {"account_id": api.acct("1100"), "debit": "0.1"}, {"account_id": api.acct("4000"), "credit": "0.1000001"}]}, headers={**api.headers, "Idempotency-Key": "five-places"}).status_code == 422


def test_unknown_fields_and_foreign_accounts_are_refused(api, two_orgs):
    ok = {"account_id": api.acct("1100"), "debit": "1"}
    for extra in ({"organization_id": two_orgs["beta_id"]}, {"status": "posted"}, {"entry_number": "JE-9"}, {"total": "5"}, {"source_type": "sales"}):
        body = {"entry_date": "2026-11-05", "description": "x", "lines": [ok, {"account_id": api.acct("4000"), "credit": "1"}], **extra}
        assert api.client.post(ENTRIES, json=body, headers={**api.headers, "Idempotency-Key": "extra-field-1"}).status_code == 422, extra
    two_orgs["beta"].accounts()
    foreign = two_orgs["beta"].acct("4000")
    refused = api.client.post(ENTRIES, json={"entry_date": "2026-11-05", "description": "x", "lines": [ok, {"account_id": foreign, "credit": "1"}]}, headers={**api.headers, "Idempotency-Key": "foreign-acct-1"})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "unknown_account"


# ----------------------------------------------------------------------------------------------------------- currencies
def test_the_organization_default_currency_is_used_for_new_entries_and_the_original_currency_is_kept(directory, two_orgs):
    eur = directory.add_organization("Euro Co", currency="EUR")
    directory.add_user("admin-euro", "organization-admin", eur)
    from conftest import Api

    euro = Api(two_orgs["alpha"].client, "admin-euro", eur)
    assert euro.balanced()["currency_code"] == "EUR"  # the default
    assert euro.balanced(currency="usd")["currency_code"] == "USD"  # explicit, normalised
    assert euro.balanced(currency="JPY")["currency_code"] == "JPY"
    assert [e["currency_code"] for e in euro.entries()["items"]].count("EUR") == 1
    changed = directory.organizations[eur]
    changed["default_currency"] = "GBP"  # a later Settings change affects only NEW entries
    assert euro.balanced()["currency_code"] == "GBP"
    assert {e["currency_code"] for e in euro.entries()["items"]} == {"EUR", "USD", "JPY", "GBP"}


def test_an_unknown_currency_is_refused_and_never_defaulted(api):
    for code in ("XXX", "US", "dollars", "123"):
        body = {"entry_date": "2026-11-05", "description": "x", "currency_code": code, "lines": []}
        assert api.client.post(ENTRIES, json=body, headers={**api.headers, "Idempotency-Key": "currency-key-1"}).status_code == 422, code


def test_different_currencies_are_never_added_together(api):
    api.balanced(amount="100", currency="USD")
    api.balanced(amount="40", currency="EUR")
    api.balanced(amount="7", currency="EUR")
    overview = api.get(f"{PREFIX}/overview").json()
    totals = {t["currency_code"]: t for t in overview["totals_by_currency"]}
    assert set(totals) == {"EUR", "USD"}
    assert (totals["USD"]["assets"], totals["USD"]["revenue"], totals["USD"]["posted_entries"]) == ("100.0000", "100.0000", 1)
    assert (totals["EUR"]["assets"], totals["EUR"]["revenue"], totals["EUR"]["posted_entries"]) == ("47.0000", "47.0000", 2)
    assert {e["currency_code"] for e in api.entries(currency="eur")["items"]} == {"EUR"}


def test_a_draft_may_change_currency_but_a_posted_entry_never_does(api):
    draft = api.entry([(api.acct("1100"), "5", "0"), (api.acct("4000"), "0", "5")], currency_code="USD")
    moved = api.client.put(f"{ENTRIES}/{draft['id']}", json={"entry_date": "2026-11-05", "description": "x", "currency_code": "EUR", "lines": [
        {"account_id": api.acct("1100"), "debit": "5"}, {"account_id": api.acct("4000"), "credit": "5"}]}, headers=api.headers)
    assert moved.json()["currency_code"] == "EUR"
    api.post(draft["id"])
    refused = api.client.put(f"{ENTRIES}/{draft['id']}", json={"entry_date": "2026-11-05", "description": "x", "currency_code": "USD", "lines": []}, headers=api.headers)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "not_editable"


# ----------------------------------------------------------------------------------------------------------- immutability
def test_a_posted_entry_can_never_be_edited_deleted_or_posted_again(api):
    entry = api.balanced()
    before = api.client.get(f"{ENTRIES}/{entry['id']}", headers=api.headers).json()
    edit = api.client.put(f"{ENTRIES}/{entry['id']}", json={"entry_date": "2026-11-06", "description": "Changed", "currency_code": "USD", "lines": [
        {"account_id": api.acct("1100"), "debit": "1"}, {"account_id": api.acct("4000"), "credit": "1"}]}, headers=api.headers)
    assert edit.status_code == 409 and edit.json()["detail"]["code"] == "not_editable"
    assert api.client.delete(f"{ENTRIES}/{entry['id']}", headers=api.headers).status_code == 409
    again = api.client.post(f"{ENTRIES}/{entry['id']}/post", headers=api.headers)
    assert again.status_code == 409 and again.json()["detail"]["code"] == "already_posted"
    after = api.client.get(f"{ENTRIES}/{entry['id']}", headers=api.headers).json()
    assert {k: v for k, v in after.items() if k != "history"} == {k: v for k, v in before.items() if k != "history"}
    assert api.balanced()["entry_number"] == "JE-000002"  # the failed attempts consumed no number


def test_a_draft_can_be_discarded_and_leaves_an_audit_line(api, session_factory):
    draft = api.entry([(api.acct("1100"), "5", "0"), (api.acct("4000"), "0", "5")])
    assert api.client.delete(f"{ENTRIES}/{draft['id']}", headers=api.headers).status_code == 204
    assert api.client.get(f"{ENTRIES}/{draft['id']}", headers=api.headers).status_code == 404
    with session_factory() as db:
        assert db.execute(text("SELECT array_agg(action ORDER BY seq) FROM finance_events WHERE entity_id = :i"), {"i": draft["id"]}).scalar() == ["created", "draft_discarded"]
        assert db.execute(text("SELECT count(*) FROM journal_lines")).scalar() == 0


# ----------------------------------------------------------------------------------------------------------- idempotency
def test_the_same_idempotency_key_returns_the_first_entry_and_creates_nothing(api):
    lines = [(api.acct("1100"), "10", "0"), (api.acct("4000"), "0", "10")]
    first = api.entry(lines, post=True, key="idem-key-0001")
    again = api.entry(lines, post=True, key="idem-key-0001", expect=200)
    assert again["id"] == first["id"] and again["entry_number"] == first["entry_number"]
    assert api.entries()["total"] == 1
    other = api.client.post(ENTRIES, json={"entry_date": "2026-11-05", "description": "A different request", "lines": []}, headers={**api.headers, "Idempotency-Key": "idem-key-0001"})
    assert other.status_code == 409 and other.json()["detail"]["code"] == "idempotency_key_reused"
    expense = api.client.post(f"{PREFIX}/expenses", json={"expense_date": "2026-11-05", "description": "x", "account_id": api.acct("5000"), "amount": "1"}, headers={**api.headers, "Idempotency-Key": "idem-key-0001"})
    assert expense.status_code == 409  # a key belongs to one request, whatever it creates


def test_the_idempotency_key_is_required_well_formed_and_scoped_to_the_organization(api, two_orgs):
    body = {"entry_date": "2026-11-05", "description": "x", "lines": []}
    assert api.client.post(ENTRIES, json=body, headers=api.headers).status_code == 400
    for bad in ("short", "has spaces in it", "x" * 101, "bad/char/key!"):
        assert api.client.post(ENTRIES, json=body, headers={**api.headers, "Idempotency-Key": bad}).status_code == 400, bad
    api.entry([], key="shared-key-0001")
    two_orgs["beta"].entry([], key="shared-key-0001")  # another organization's key is its own
    assert api.entries()["total"] == 1 and two_orgs["beta"].entries()["total"] == 1


def test_concurrent_duplicate_requests_create_exactly_one_entry(api, session_factory):
    lines = [{"account_id": api.acct("1100"), "debit": "10"}, {"account_id": api.acct("4000"), "credit": "10"}]
    results = []

    def go():
        results.append(api.client.post(ENTRIES, json={"entry_date": "2026-11-05", "description": "Racing", "post": True, "lines": lines}, headers={**api.headers, "Idempotency-Key": "race-key-00001"}))

    threads = [threading.Thread(target=go) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(r.status_code for r in results) == [200] * 7 + [201]
    assert len({r.json()["id"] for r in results}) == 1
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM journal_entries")).scalar() == 1


# ----------------------------------------------------------------------------------------------------------- concurrency
def test_posting_the_same_draft_concurrently_posts_it_once(api, session_factory):
    draft = api.entry([(api.acct("1100"), "10", "0"), (api.acct("4000"), "0", "10")])
    results = []
    threads = [threading.Thread(target=lambda: results.append(api.client.post(f"{ENTRIES}/{draft['id']}/post", headers=api.headers))) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(r.status_code for r in results) == [200] + [409] * 7
    with session_factory() as db:
        assert db.execute(text("SELECT entry_number, status FROM journal_entries")).one() == ("JE-000001", "posted")
        assert db.execute(text("SELECT last_number FROM finance_counters WHERE name = 'journal'")).scalar() == 1


def test_posting_many_drafts_concurrently_gives_unique_gapless_numbers(api, session_factory):
    drafts = [api.entry([(api.acct("1100"), str(n), "0"), (api.acct("4000"), "0", str(n))]) for n in range(1, 13)]
    results = []
    threads = [threading.Thread(target=lambda d=d: results.append(api.client.post(f"{ENTRIES}/{d['id']}/post", headers=api.headers))) for d in drafts]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert [r.status_code for r in results] == [200] * 12
    numbers = sorted(r.json()["entry_number"] for r in results)
    assert numbers == [f"JE-{n:06d}" for n in range(1, 13)]


def test_concurrent_reversals_reverse_once(api, session_factory):
    entry = api.balanced()
    results = []
    threads = [threading.Thread(target=lambda: results.append(api.client.post(f"{ENTRIES}/{entry['id']}/reverse", json={"reason": "Racing reversal"}, headers=api.headers))) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(r.status_code for r in results) == [201] + [409] * 5
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM journal_entries WHERE source_type = 'reversal'")).scalar() == 1


# ----------------------------------------------------------------------------------------------------------- reversal
def test_a_reversal_is_the_exact_mirror_image_and_the_original_is_untouched(api, session_factory):
    original = api.entry([(api.acct("1100"), "70.25", "0"), (api.acct("4000"), "0", "60.00"), (api.acct("2100"), "0", "10.25")], post=True, currency_code="EUR")
    with session_factory() as db:
        snapshot = db.execute(text("SELECT id, entry_number, status, total, description, posted_at, updated_at FROM journal_entries WHERE id = :i"), {"i": original["id"]}).one()
        lines_before = db.execute(text("SELECT line_no, account_id, debit, credit FROM journal_lines WHERE entry_id = :i ORDER BY line_no"), {"i": original["id"]}).all()
    reversal = api.reverse(original["id"], "Customer cancelled", entry_date="2026-11-06")
    assert reversal["source_type"] == "reversal" and reversal["status"] == "posted" and reversal["reverses_entry_id"] == original["id"]
    assert reversal["entry_number"] == "JE-000002" and reversal["currency_code"] == "EUR" and reversal["reversal_reason"] == "Customer cancelled" and reversal["entry_date"] == "2026-11-06"
    assert [(l["account_id"], l["debit"], l["credit"]) for l in reversal["lines"]] == [(l.account_id and str(l.account_id), format(l.credit, "f"), format(l.debit, "f")) for l in lines_before]
    assert reversal["can_reverse"] is False
    with session_factory() as db:
        assert db.execute(text("SELECT id, entry_number, status, total, description, posted_at, updated_at FROM journal_entries WHERE id = :i"), {"i": original["id"]}).one() == snapshot
        assert db.execute(text("SELECT line_no, account_id, debit, credit FROM journal_lines WHERE entry_id = :i ORDER BY line_no"), {"i": original["id"]}).all() == lines_before
    shown = api.client.get(f"{ENTRIES}/{original['id']}", headers=api.headers).json()
    assert shown["reversed_by_entry_id"] == reversal["id"] and shown["can_reverse"] is False
    assert [h["action"] for h in shown["history"]] == ["created", "posted", "reversed"]
    assert api.entries(status="posted")["items"][0]["id"] in {original["id"], reversal["id"]}


def test_the_reversal_nets_every_balance_to_zero(api):
    original = api.balanced(amount="55", currency="USD")
    api.reverse(original["id"])
    totals = api.get(f"{PREFIX}/overview").json()["totals_by_currency"][0]
    assert (totals["assets"], totals["revenue"], totals["posted_entries"]) == ("0.0000", "0.0000", 2)


def test_an_entry_is_reversed_once_and_a_reversal_cannot_be_reversed(api):
    original = api.balanced()
    reversal = api.reverse(original["id"])
    twice = api.client.post(f"{ENTRIES}/{original['id']}/reverse", json={"reason": "Again please"}, headers=api.headers)
    assert twice.status_code == 409 and twice.json()["detail"]["code"] == "already_reversed" and twice.json()["detail"]["reversal_entry_id"] == reversal["id"]
    of_reversal = api.client.post(f"{ENTRIES}/{reversal['id']}/reverse", json={"reason": "Undo the undo"}, headers=api.headers)
    assert of_reversal.status_code == 409 and of_reversal.json()["detail"]["code"] == "not_reversible"
    draft = api.entry([(api.acct("1100"), "1", "0"), (api.acct("4000"), "0", "1")])
    assert api.client.post(f"{ENTRIES}/{draft['id']}/reverse", json={"reason": "Not posted"}, headers=api.headers).json()["detail"]["code"] == "not_posted"


def test_a_reversal_needs_a_reason(api):
    original = api.balanced()
    for body in ({}, {"reason": ""}, {"reason": "no"}, {"reason": "ok reason", "organization_id": "x"}):
        assert api.client.post(f"{ENTRIES}/{original['id']}/reverse", json=body, headers=api.headers).status_code == 422, body


def test_a_corrected_entry_after_a_reversal_is_a_new_posting(api):
    wrong = api.balanced(amount="90")
    api.reverse(wrong["id"], "Wrong amount")
    right = api.balanced(amount="99")
    assert right["entry_number"] == "JE-000003"
    assert api.entries(source="reversal")["total"] == 1 and api.entries(source="manual")["total"] == 2


# ----------------------------------------------------------------------------------------------------------- listing
def test_listing_filters_search_and_paging(api):
    a = api.balanced(amount="1", description="Alpha sale", reference="PO-77", entry_date="2026-10-01")
    b = api.balanced(amount="2", description="Beta sale", entry_date="2026-11-10")
    api.entry([(api.acct("1100"), "3", "0"), (api.acct("4000"), "0", "3")], description="A draft")
    assert api.entries()["total"] == 3
    assert [e["id"] for e in api.entries(status="draft")["items"]] != [] and api.entries(status="draft")["total"] == 1
    assert [e["id"] for e in api.entries(q="alpha")["items"]] == [a["id"]]
    assert [e["id"] for e in api.entries(q="po-77")["items"]] == [a["id"]]
    assert [e["id"] for e in api.entries(q="JE-000002")["items"]] == [b["id"]]
    assert [e["id"] for e in api.entries(date_from="2026-11-01")["items"]] != [a["id"]] and a["id"] not in [e["id"] for e in api.entries(date_from="2026-11-01")["items"]]
    assert api.entries(date_to="2026-10-31")["total"] == 1
    assert api.entries(account_id=api.acct("2100"))["total"] == 0 and api.entries(account_id=api.acct("4000"))["total"] == 3
    page = api.entries(limit=2, offset=2)
    assert page["total"] == 3 and len(page["items"]) == 1 and page["limit"] == 2 and page["offset"] == 2
    assert api.client.get(ENTRIES, params={"limit": 0}, headers=api.headers).status_code == 422
    assert api.entries(q="%")["total"] == 0  # a wildcard is searched literally


def test_exact_amounts_are_returned_as_strings_never_floats(api):
    entry = api.balanced(amount="1234.5678")
    assert isinstance(entry["total"], str) and isinstance(entry["lines"][0]["debit"], str)
    assert isinstance(api.entries()["items"][0]["total"], str)
