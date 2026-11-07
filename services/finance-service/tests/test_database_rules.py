"""The accounting rules the DATABASE enforces by itself, however the data is reached (a bug, a script, a direct SQL session)."""
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

ORG = uuid.uuid4()
OTHER = uuid.uuid4()


def sql(db, statement, **params):
    return db.execute(text(statement), params)


@pytest.fixture
def books(session_factory):
    """Two organizations' accounts plus a POSTED entry (100 debit 1100, 100 credit 4000) and a DRAFT, created by plain SQL."""
    from app.chart import ensure_setup

    with session_factory() as db:
        ensure_setup(db, ORG)
        ensure_setup(db, OTHER)
        acct = lambda org, code: sql(db, "SELECT id FROM accounts WHERE organization_id = :o AND code = :c", o=org, c=code).scalar()  # noqa: E731
        ids = {"ar": acct(ORG, "1100"), "rev": acct(ORG, "4000"), "tax": acct(ORG, "2100"), "other_rev": acct(OTHER, "4000"), "expense": acct(ORG, "5000")}

        def entry(status_after="posted", lines=(("ar", 100, 0), ("rev", 0, 100)), **extra):
            entry_id = uuid.uuid4()
            sql(db, "INSERT INTO journal_entries (id, organization_id, entry_date, description, currency_code, status, source_type) VALUES (:i, :o, '2026-11-05', 'Test', 'USD', 'draft', 'manual')", i=entry_id, o=ORG)
            for n, (acc, debit, credit) in enumerate(lines, start=1):
                sql(db, "INSERT INTO journal_lines (organization_id, entry_id, line_no, account_id, debit, credit) VALUES (:o, :e, :n, :a, :d, :c)", o=ORG, e=entry_id, n=n, a=ids[acc], d=debit, c=credit)
            if status_after == "posted":
                sql(db, "UPDATE journal_entries SET status = 'posted', entry_number = :n, total = :t, posted_at = now() WHERE id = :i", i=entry_id, n=f"JE-{uuid.uuid4().hex[:6]}", t=sum(l[1] for l in lines))
            db.commit()
            return entry_id

        yield {"db": db, "ids": ids, "entry": entry}


def refused(db, statement, match=None, **params):
    with pytest.raises(DBAPIError) as caught:
        db.execute(text(statement), params)
        db.commit()
    db.rollback()
    if match:
        assert match in str(caught.value.orig), str(caught.value.orig)


def test_a_posted_entry_cannot_be_updated_or_deleted(books):
    db, posted = books["db"], books["entry"]()
    refused(db, "UPDATE journal_entries SET description = 'tampered' WHERE id = :i", "can never be changed", i=posted)
    refused(db, "UPDATE journal_entries SET status = 'draft' WHERE id = :i", "can never be changed", i=posted)
    refused(db, "UPDATE journal_entries SET total = 1 WHERE id = :i", "can never be changed", i=posted)
    refused(db, "DELETE FROM journal_entries WHERE id = :i", "can never be deleted", i=posted)


def test_the_lines_of_a_posted_entry_cannot_be_added_changed_or_removed(books):
    db, posted = books["db"], books["entry"]()
    refused(db, "UPDATE journal_lines SET debit = 999 WHERE entry_id = :i AND line_no = 1", "posted journal entry", i=posted)
    refused(db, "DELETE FROM journal_lines WHERE entry_id = :i", "posted journal entry", i=posted)
    refused(db, "INSERT INTO journal_lines (organization_id, entry_id, line_no, account_id, debit, credit) VALUES (:o, :i, 3, :a, 1, 0)", "posted journal entry", o=ORG, i=posted, a=books["ids"]["ar"])
    refused(db, "UPDATE journal_lines SET entry_id = :other WHERE entry_id = :i", i=posted, other=books["entry"]("draft"))


def test_an_entry_can_only_be_created_as_a_draft(books):
    refused(books["db"], "INSERT INTO journal_entries (organization_id, entry_date, description, currency_code, status, entry_number, total, posted_at) VALUES (:o, '2026-11-05', 'x', 'USD', 'posted', 'JE-1', 1, now())", "created as a draft", o=ORG)


def test_an_unbalanced_or_too_small_entry_cannot_be_posted_even_by_direct_sql(books):
    db = books["db"]
    unbalanced = books["entry"]("draft", lines=(("ar", 100, 0), ("rev", 0, 99)))
    refused(db, "UPDATE journal_entries SET status = 'posted', entry_number = 'JE-X1', total = 100, posted_at = now() WHERE id = :i", "must be equal to post", i=unbalanced)
    single = books["entry"]("draft", lines=(("ar", 100, 0),))
    refused(db, "UPDATE journal_entries SET status = 'posted', entry_number = 'JE-X2', total = 100, posted_at = now() WHERE id = :i", "at least two lines", i=single)
    empty = books["entry"]("draft", lines=())
    refused(db, "UPDATE journal_entries SET status = 'posted', entry_number = 'JE-X3', total = 0, posted_at = now() WHERE id = :i", "at least two lines", i=empty)
    wrong_total = books["entry"]("draft")
    refused(db, "UPDATE journal_entries SET status = 'posted', entry_number = 'JE-X4', total = 5, posted_at = now() WHERE id = :i", "total must equal", i=wrong_total)
    assert sql(db, "SELECT count(*) FROM journal_entries WHERE status = 'posted'").scalar() == 0


def test_a_line_is_exactly_one_non_negative_side(books):
    db, draft = books["db"], books["entry"]("draft")
    for debit, credit in ((0, 0), (5, 5), (-1, 0), (0, -2)):
        refused(db, "INSERT INTO journal_lines (organization_id, entry_id, line_no, account_id, debit, credit) VALUES (:o, :e, 9, :a, :d, :c)", o=ORG, e=draft, a=books["ids"]["ar"], d=debit, c=credit)


def test_a_line_cannot_use_another_organizations_account(books):
    db, draft = books["db"], books["entry"]("draft")
    refused(db, "INSERT INTO journal_lines (organization_id, entry_id, line_no, account_id, debit, credit) VALUES (:o, :e, 9, :a, 1, 0)", "fk_journal_lines_organization_id_accounts", o=ORG, e=draft, a=books["ids"]["other_rev"])


def test_a_posting_to_an_inactive_account_is_refused(books):
    db = books["db"]
    draft = books["entry"]("draft")
    sql(db, "UPDATE accounts SET is_active = false WHERE id = :a", a=books["ids"]["expense"])  # (a custom account: system accounts cannot be deactivated)
    sql(db, "INSERT INTO journal_lines (organization_id, entry_id, line_no, account_id, debit, credit) VALUES (:o, :e, 3, :a, 5, 0), (:o, :e, 4, :r, 0, 5)", o=ORG, e=draft, a=books["ids"]["expense"], r=books["ids"]["rev"])
    db.commit()
    refused(db, "UPDATE journal_entries SET status = 'posted', entry_number = 'JE-X5', total = 105, posted_at = now() WHERE id = :i", "inactive account", i=draft)


def test_system_accounts_are_protected_and_used_accounts_keep_their_code_and_type(books):
    db = books["db"]
    refused(db, "DELETE FROM accounts WHERE id = :a", "system account cannot be deleted", a=books["ids"]["ar"])
    refused(db, "UPDATE accounts SET is_active = false WHERE id = :a", "system account", a=books["ids"]["ar"])
    refused(db, "UPDATE accounts SET code = '1199' WHERE id = :a", "system account", a=books["ids"]["ar"])
    refused(db, "UPDATE accounts SET account_type = 'liability' WHERE id = :a", "system account", a=books["ids"]["ar"])
    refused(db, "UPDATE accounts SET is_system = false, system_key = NULL WHERE id = :a", "stop being a system account", a=books["ids"]["ar"])
    refused(db, "UPDATE accounts SET system_key = 'something_else' WHERE id = :a", a=books["ids"]["expense"])
    books["entry"](lines=(("expense", 5, 0), ("rev", 0, 5)))
    refused(db, "UPDATE accounts SET code = '5001' WHERE id = :a", "keeps its code and type", a=books["ids"]["expense"])
    refused(db, "DELETE FROM accounts WHERE id = :a", "fk_journal_lines_organization_id_accounts", a=books["ids"]["expense"])
    sql(db, "UPDATE accounts SET name = 'Renamed' WHERE id = :a", a=books["ids"]["ar"])  # a harmless change is allowed
    db.commit()


def test_account_codes_and_system_keys_are_unique_per_organization(books):
    db = books["db"]
    refused(db, "INSERT INTO accounts (organization_id, code, name, account_type) VALUES (:o, '1100', 'Dup', 'asset')", "uq_accounts_organization_id_code", o=ORG)
    refused(db, "INSERT INTO accounts (organization_id, code, name, account_type, is_system, system_key) VALUES (:o, '9999', 'Dup', 'asset', true, 'accounts_receivable')", "system_key", o=ORG)
    refused(db, "INSERT INTO accounts (organization_id, code, name, account_type) VALUES (:o, '9998', 'Bad', 'income')", "account_type_valid", o=ORG)
    refused(db, "INSERT INTO accounts (organization_id, code, name, account_type, is_system) VALUES (:o, '9997', 'Bad', 'asset', true)", "system_has_key", o=ORG)


def test_the_audit_trail_is_append_only(books):
    db = books["db"]
    sql(db, "INSERT INTO finance_events (organization_id, entity_type, action) VALUES (:o, 'account', 'probe')", o=ORG)
    db.commit()
    refused(db, "UPDATE finance_events SET action = 'rewritten'", "append-only")
    refused(db, "DELETE FROM finance_events", "append-only")


def test_a_reversal_must_mirror_a_posted_entry_exactly_and_only_once(books):
    db = books["db"]

    def draft_reversal(reverses, lines, currency="USD"):
        """A reversal DRAFT of `reverses`, and the statement that would post it (each original gets one reversal row, drafts included)."""
        rid = uuid.uuid4()
        sql(db, "INSERT INTO journal_entries (id, organization_id, entry_date, description, currency_code, status, source_type, reverses_entry_id) VALUES (:i, :o, '2026-11-06', 'Rev', :cur, 'draft', 'reversal', :r)", i=rid, o=ORG, r=reverses, cur=currency)
        for n, (acc, debit, credit) in enumerate(lines, start=1):
            sql(db, "INSERT INTO journal_lines (organization_id, entry_id, line_no, account_id, debit, credit) VALUES (:o, :e, :n, :a, :d, :c)", o=ORG, e=rid, n=n, a=books["ids"][acc], d=debit, c=credit)
        db.commit()
        return rid, f"UPDATE journal_entries SET status = 'posted', entry_number = 'JE-{uuid.uuid4().hex[:6]}', total = 100, posted_at = now() WHERE id = '{rid}'"

    mirror = [("rev", 100, 0), ("ar", 0, 100)]
    refused(db, draft_reversal(books["entry"](), [("ar", 100, 0), ("rev", 0, 100)])[1], "exact mirror image")  # same direction is not a reversal
    refused(db, draft_reversal(books["entry"](), [("tax", 100, 0), ("rev", 0, 100)])[1], "exact mirror image")  # other accounts
    refused(db, draft_reversal(books["entry"](), mirror, currency="EUR")[1], "must match the entry")  # other currency
    refused(db, draft_reversal(books["entry"]("draft"), mirror)[1], "Only a posted entry")  # of a draft
    original = books["entry"]()
    good, post_good = draft_reversal(original, mirror)
    sql(db, post_good)
    db.commit()
    assert sql(db, "SELECT status FROM journal_entries WHERE id = :i", i=good).scalar() == "posted"
    refused(db, "INSERT INTO journal_entries (organization_id, entry_date, description, currency_code, status, source_type, reverses_entry_id) VALUES (:o, '2026-11-06', 'Second', 'USD', 'draft', 'reversal', :r)", "reverses_entry_id", o=ORG, r=original)
    _, post_nested = draft_reversal(good, [("ar", 100, 0), ("rev", 0, 100)])
    refused(db, post_nested, "cannot itself be reversed")


def test_a_source_event_can_only_be_posted_once_per_organization(books):
    db = books["db"]
    for org in (ORG, OTHER):  # the same key in another organization is a different fact
        sql(db, "INSERT INTO journal_entries (organization_id, entry_date, description, currency_code, source_type, source_key) VALUES (:o, '2026-11-05', 'x', 'USD', 'sales', 'invoice-issued:1')", o=org)
        db.commit()
    refused(db, "INSERT INTO journal_entries (organization_id, entry_date, description, currency_code, source_type, source_key) VALUES (:o, '2026-11-05', 'x', 'USD', 'sales', 'invoice-issued:1')", "uq_journal_entries_organization_id_source_key", o=ORG)


def test_entry_and_expense_shape_constraints(books):
    db = books["db"]
    refused(db, "INSERT INTO journal_entries (organization_id, entry_date, description, currency_code) VALUES (:o, '2026-11-05', 'x', 'usd')", "currency_code_valid", o=ORG)
    refused(db, "INSERT INTO journal_entries (organization_id, entry_date, description, currency_code) VALUES (:o, '2026-11-05', '   ', 'USD')", "description_not_blank", o=ORG)
    refused(db, "INSERT INTO journal_entries (organization_id, entry_date, description, currency_code, source_type) VALUES (:o, '2026-11-05', 'x', 'USD', 'reversal')", "reversal_names_its_original", o=ORG)
    refused(db, "INSERT INTO expenses (organization_id, number, expense_date, description, account_id, amount, currency_code, created_by, created_by_email) VALUES (:o, 'EXP-1', '2026-11-05', 'x', :a, 0, 'USD', :u, 'a@b.c')", "amount_positive", o=ORG, a=books["ids"]["expense"], u=uuid.uuid4())
    refused(db, "INSERT INTO expenses (organization_id, number, expense_date, description, account_id, amount, currency_code, created_by, created_by_email) VALUES (:o, 'EXP-2', '2026-11-05', 'x', :a, 5, 'USD', :u, 'a@b.c')", "fk_expenses_organization_id_accounts", o=ORG, a=books["ids"]["other_rev"], u=uuid.uuid4())


def test_a_posted_expense_cannot_be_changed_or_deleted(books):
    db = books["db"]
    expense_id, entry = uuid.uuid4(), books["entry"](lines=(("expense", 5, 0), ("rev", 0, 5)))
    sql(db, "INSERT INTO expenses (id, organization_id, number, expense_date, description, account_id, amount, currency_code, created_by, created_by_email) VALUES (:i, :o, 'EXP-9', '2026-11-05', 'x', :a, 5, 'USD', :u, 'a@b.c')", i=expense_id, o=ORG, a=books["ids"]["expense"], u=uuid.uuid4())
    sql(db, "UPDATE expenses SET amount = 6 WHERE id = :i", i=expense_id)  # a draft may change
    sql(db, "UPDATE expenses SET status = 'posted', journal_entry_id = :e WHERE id = :i", i=expense_id, e=entry)
    db.commit()
    refused(db, "UPDATE expenses SET amount = 7 WHERE id = :i", "can never be changed", i=expense_id)
    refused(db, "UPDATE expenses SET account_id = :a WHERE id = :i", "can never be changed", i=expense_id, a=books["ids"]["ar"])
    refused(db, "UPDATE expenses SET status = 'draft' WHERE id = :i", "only be reversed", i=expense_id)
    refused(db, "DELETE FROM expenses WHERE id = :i", "can never be deleted", i=expense_id)
    refused(db, "UPDATE expenses SET status = 'reversed' WHERE id = :i", "ck_expenses_reversed_has_entry", i=expense_id)


def test_received_events_cannot_be_rewritten_or_reprocessed(books):
    db, event = books["db"], uuid.uuid4()
    sql(db, "INSERT INTO sync_events (id, organization_id, source, event_key, event_type, event_time, payload) VALUES (:i, :o, 'sales', 'k1', 'invoice.issued', now(), '{\"total\": \"5\"}')", i=event, o=ORG)
    db.commit()
    refused(db, "UPDATE sync_events SET payload = '{\"total\": \"500\"}' WHERE id = :i", "cannot be rewritten", i=event)
    refused(db, "UPDATE sync_events SET event_key = 'k2' WHERE id = :i", "cannot be rewritten", i=event)
    refused(db, "DELETE FROM sync_events WHERE id = :i", "kept", i=event)
    sql(db, "UPDATE sync_events SET status = 'skipped' WHERE id = :i", i=event)
    db.commit()
    refused(db, "UPDATE sync_events SET status = 'pending' WHERE id = :i", "processed again", i=event)
    refused(db, "INSERT INTO sync_events (organization_id, source, event_key, event_type, event_time, payload) VALUES (:o, 'sales', 'k1', 'invoice.issued', now(), '{}')", "uq_sync_events_organization_id_event_key", o=ORG)


def test_the_maintenance_switch_is_the_only_way_to_remove_ledger_rows(books):
    db, posted = books["db"], books["entry"]()
    sql(db, "SELECT set_config('app.allow_ledger_maintenance', 'on', true)")
    sql(db, "DELETE FROM journal_entries WHERE id = :i", i=posted)  # lines go with it (cascade)
    db.commit()
    assert sql(db, "SELECT count(*) FROM journal_lines WHERE entry_id = :i", i=posted).scalar() == 0
    refused(db, "DELETE FROM accounts WHERE id = :a", "system account", a=books["ids"]["ar"])  # the switch ended with its transaction
    sql(db, "SELECT set_config('app.allow_ledger_maintenance', 'on', true)")
    sql(db, "DELETE FROM finance_events")
    sql(db, "DELETE FROM accounts WHERE organization_id = :o", o=OTHER)
    db.commit()


def test_a_draft_entry_with_its_lines_can_be_deleted_normally(books):
    db, draft = books["db"], books["entry"]("draft")
    sql(db, "DELETE FROM journal_entries WHERE id = :i", i=draft)
    db.commit()
    assert sql(db, "SELECT count(*) FROM journal_lines WHERE entry_id = :i", i=draft).scalar() == 0
