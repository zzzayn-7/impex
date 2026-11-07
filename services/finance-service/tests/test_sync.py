"""Posting Sales and Purchasing facts: exactly once, in the event's own currency, with outages and retries survived, and nothing back-filled."""
import threading
import uuid
from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal

import pytest
from sqlalchemy import text

from conftest import ACTIVATED, ENTRIES, PREFIX, now

SYNC = f"{PREFIX}/sync"


@pytest.fixture
def org(api, two_orgs):
    api.accounts()  # the first request sets Finance up for the organization (starter chart, activation)
    return two_orgs["alpha_id"]


def entries_of(session_factory, org):
    with session_factory() as db:
        return db.execute(text("SELECT id, entry_number, source_type, source_key, currency_code, status, total, entry_date, created_by FROM journal_entries WHERE organization_id = :o ORDER BY entry_number"), {"o": org}).all()


def line_view(api, entry_id):
    shown = api.client.get(f"{ENTRIES}/{entry_id}", headers=api.headers).json()
    return [(l["account_code"], l["debit"], l["credit"]) for l in shown["lines"]], shown


def events(session_factory, org, status=None):
    with session_factory() as db:
        query = "SELECT event_key, event_type, status, attempts, last_error, journal_entry_id FROM sync_events WHERE organization_id = :o" + (" AND status = :s" if status else "") + " ORDER BY event_time, event_key"
        return db.execute(text(query), {"o": org, "s": status}).all()


# ------------------------------------------------------------------------------------------------------------------ the recognition policy
def test_an_issued_invoice_becomes_one_entry_receivable_against_net_revenue_and_tax(api, org, feeds, run_sync, session_factory):
    feeds.invoice_issued(org, number="INV-000007", subtotal="200.00", discount="20.00", tax="13.50", client="Acme Ltd", currency="EUR")
    assert run_sync(org)["posted"] == 1
    (entry,) = entries_of(session_factory, org)
    lines, shown = line_view(api, entry.id)
    assert sorted(lines) == [("1100", "193.5000", "0.0000"), ("2100", "0.0000", "13.5000"), ("4000", "0.0000", "180.0000")]
    assert (shown["status"], shown["source_type"], shown["currency_code"], shown["total"], shown["is_balanced"]) == ("posted", "sales", "EUR", "193.5000", True)
    assert shown["source_summary"] == "Invoice INV-000007 issued to Acme Ltd" and shown["reference"] == "INV-000007" and shown["source_key"].startswith("invoice-issued:")
    assert shown["created_by_email"] is None and shown["posted_by_email"] is None  # no person: the synchronisation posted it
    assert [(h["action"], h["source"], h["actor_email"]) for h in shown["history"]] == [("created", "sync", None), ("posted", "sync", None)]


def test_an_invoice_without_tax_or_with_only_tax_and_a_zero_invoice(api, org, feeds, run_sync, session_factory):
    feeds.invoice_issued(org, number="INV-1", subtotal="50", tax="0")
    feeds.invoice_issued(org, number="INV-2", subtotal="0", tax="0", total="0")
    run_sync(org)
    posted = entries_of(session_factory, org)
    assert len(posted) == 1 and posted[0].total == Decimal("50")
    assert [e.status for e in events(session_factory, org)] == ["posted", "skipped"]


def test_a_payment_is_cash_received_against_the_receivable_and_its_reversal_mirrors_it(api, org, feeds, run_sync, session_factory):
    invoice = feeds.invoice_issued(org, subtotal="100", currency="USD", when=now() - timedelta(minutes=5))
    payment = feeds.payment(org, invoice, "40.00", when=now() - timedelta(minutes=3))
    feeds.payment(org, invoice, "40.00", reversal_of=payment["data"]["payment_id"], when=now() - timedelta(minutes=2))
    assert run_sync(org)["posted"] == 3
    by_key = {e.source_key: e for e in entries_of(session_factory, org)}
    paid = by_key[payment["key"]]
    assert line_view(api, paid.id)[0] == [("1050", "40.0000", "0.0000"), ("1100", "0.0000", "40.0000")]
    reversed_key = next(k for k in by_key if k.startswith("payment-reversed:"))
    assert line_view(api, by_key[reversed_key].id)[0] == [("1100", "40.0000", "0.0000"), ("1050", "0.0000", "40.0000")]
    totals = api.get(f"{PREFIX}/overview").json()["totals_by_currency"][0]
    assert (totals["assets"], totals["currency_code"]) == ("100.0000", "USD")  # receivable 100 - 40 + 40, and nothing left in "payments received" after the reversal


def test_a_voided_invoice_is_reversed_by_a_mirror_entry_and_the_original_stays(api, org, feeds, run_sync, session_factory):
    invoice = feeds.invoice_issued(org, subtotal="80", tax="8", when=now() - timedelta(minutes=5))
    feeds.invoice_voided(org, invoice, when=now() - timedelta(minutes=1))
    run_sync(org)
    issued = next(e for e in entries_of(session_factory, org) if e.source_type == "sales" and e.source_key == invoice["key"])
    voided = next(e for e in entries_of(session_factory, org) if e.source_type == "reversal")
    assert voided.source_key == f"invoice-voided:{invoice['data']['invoice_id']}"
    shown = api.client.get(f"{ENTRIES}/{issued.id}", headers=api.headers).json()
    assert shown["status"] == "posted" and shown["reversed_by_entry_id"] == str(voided.id)
    assert api.get(f"{PREFIX}/overview").json()["totals_by_currency"][0]["assets"] == "0.0000"


def test_a_goods_receipt_is_inventory_against_goods_received_not_invoiced_valued_once(api, org, feeds, run_sync, session_factory):
    lines = (("1.5000", "0.3333"), ("1.0001", "0.3333"), ("3", "2.10"))
    feeds.receipt(org, lines=lines, currency="GBP")
    run_sync(org)
    expected = sum((Decimal(q) * Decimal(p) for q, p in lines), Decimal(0)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)  # rounded once, on the whole receipt
    (entry,) = entries_of(session_factory, org)
    view, shown = line_view(api, entry.id)
    assert view == [("1200", format(expected, "f"), "0.0000"), ("2200", "0.0000", format(expected, "f"))] and shown["currency_code"] == "GBP" and shown["source_type"] == "purchasing"
    assert shown["source_summary"] == "Goods receipt GR-000001 for PO-000001 from Acme Supplies"
    assert not any(code == "2300" for code, *_ in view)  # no supplier payable is invented


def test_a_receipt_with_nothing_accepted_posts_nothing(api, org, feeds, run_sync, session_factory):
    feeds.receipt(org, lines=())
    feeds.receipt(org, lines=(("5", "0"),), number="GR-2")
    run_sync(org)
    assert entries_of(session_factory, org) == [] and [e.status for e in events(session_factory, org)] == ["skipped", "skipped"]


def test_each_currency_is_posted_as_itself_and_never_converted_or_summed(api, org, feeds, run_sync):
    feeds.invoice_issued(org, subtotal="100", currency="USD", number="A")
    feeds.invoice_issued(org, subtotal="100", currency="EUR", number="B")
    feeds.receipt(org, lines=(("10", "3"),), currency="JPY")
    run_sync(org)
    totals = {t["currency_code"]: t for t in api.get(f"{PREFIX}/overview").json()["totals_by_currency"]}
    assert set(totals) == {"EUR", "JPY", "USD"} and totals["EUR"]["assets"] == totals["USD"]["assets"] == "100.0000" and totals["JPY"]["assets"] == "30.0000"


# ------------------------------------------------------------------------------------------------------------------ exactly once
def test_reading_the_same_events_again_never_posts_twice(api, org, feeds, run_sync, session_factory):
    invoice = feeds.invoice_issued(org, subtotal="100")
    feeds.payment(org, invoice, "10")
    feeds.receipt(org)
    for _ in range(4):
        run_sync(org)
    assert len(entries_of(session_factory, org)) == 3 and len(events(session_factory, org)) == 3
    assert {e.status for e in events(session_factory, org)} == {"posted"}
    assert [e.entry_number for e in entries_of(session_factory, org)] == ["JE-000001", "JE-000002", "JE-000003"]  # no number was burnt by the repeats


def test_a_feed_that_repeats_an_event_inside_one_page_still_posts_it_once(api, org, feeds, run_sync, session_factory):
    event = feeds.invoice_issued(org)
    feeds.events[("sales", org)].append(dict(event))
    run_sync(org)
    assert len(entries_of(session_factory, org)) == 1


def test_the_overlap_is_re_read_and_the_position_advances(api, org, feeds, run_sync, session_factory):
    feeds.invoice_issued(org, when=now() - timedelta(minutes=30))
    run_sync(org)
    feeds.calls.clear()
    feeds.invoice_issued(org, number="INV-2", when=now() - timedelta(minutes=1))
    run_sync(org)
    sales_call = next(c for c in feeds.calls if c[0] == "sales")
    assert sales_call[2] is not None and now() - sales_call[2] > timedelta(minutes=30)  # asked from a little BEFORE the newest event it had
    assert len(entries_of(session_factory, org)) == 2


def test_a_late_committing_event_older_than_the_position_but_inside_the_overlap_is_still_caught(api, org, feeds, run_sync, session_factory):
    feeds.invoice_issued(org, number="NEW", when=now() - timedelta(minutes=1))
    run_sync(org)
    feeds.invoice_issued(org, number="LATE", when=now() - timedelta(minutes=4))  # appeared only now, though dated before one we already have
    run_sync(org)
    assert len(entries_of(session_factory, org)) == 2


def test_paging_through_a_large_backlog(api, org, feeds, run_sync, session_factory, monkeypatch):
    from app import sync

    monkeypatch.setattr(sync, "PAGE_SIZE", 5)
    for n in range(23):
        feeds.invoice_issued(org, number=f"INV-{n}", subtotal="1", when=now() - timedelta(minutes=60 - n))
    run_sync(org)
    assert len(entries_of(session_factory, org)) == 23


def test_two_workers_at_once_post_each_event_exactly_once(api, org, feeds, session_factory):
    from app import sync

    for n in range(20):
        feeds.invoice_issued(org, number=f"INV-{n}", subtotal=str(n + 1), when=now() - timedelta(minutes=30 - n))
    for source in ("sales", "purchasing"):
        sync.pull_source(session_factory, feeds, uuid.UUID(org), source)
    errors = []

    def work():
        try:
            sync.process_due(session_factory, uuid.UUID(org))
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(4)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert not errors
    rows = entries_of(session_factory, org)
    assert len(rows) == 20 and len({r.entry_number for r in rows}) == 20 and {e.status for e in events(session_factory, org)} == {"posted"}


def test_a_posting_that_fails_halfway_leaves_no_entry_and_the_event_is_retried(api, org, feeds, run_sync, session_factory, monkeypatch):
    from app import sync

    feeds.invoice_issued(org, subtotal="100")
    real = sync._post

    def crash_after_posting(*args, **kwargs):
        real(*args, **kwargs)
        raise RuntimeError("the process died")

    monkeypatch.setattr(sync, "_post", crash_after_posting)
    monkeypatch.setenv("FINANCE_SYNC_RETRY_BASE_SECONDS", "0")
    run_sync(org)
    assert entries_of(session_factory, org) == []  # the entry vanished with the failed transaction
    (event,) = events(session_factory, org)
    assert (event.status, event.attempts) == ("pending", 1) and "RuntimeError" in event.last_error
    monkeypatch.setattr(sync, "_post", real)
    run_sync(org)
    assert len(entries_of(session_factory, org)) == 1 and events(session_factory, org)[0].status == "posted"
    with session_factory() as db:
        assert db.execute(text("SELECT last_number FROM finance_counters WHERE name = 'journal'")).scalar() == 1  # the failed attempt's number was rolled back


def test_an_existing_entry_for_the_event_is_adopted_not_duplicated(api, org, feeds, run_sync, session_factory):
    event = feeds.invoice_issued(org, subtotal="100")
    run_sync(org)
    with session_factory() as db:  # simulate: the entry exists, the event row says pending (e.g. restored from a partial backup)
        db.execute(text("SELECT set_config('app.allow_ledger_maintenance', 'on', true)"))
        db.execute(text("DELETE FROM sync_events"))
        db.commit()
    run_sync(org)
    assert len(entries_of(session_factory, org)) == 1
    (row,) = events(session_factory, org)
    assert row.status == "posted" and row.journal_entry_id is not None and row.event_key == event["key"]


# ------------------------------------------------------------------------------------------------------------------ outages and recovery
def test_an_unavailable_source_is_recorded_and_everything_posts_once_it_is_back(api, org, feeds, run_sync, session_factory):
    feeds.down = {"sales"}
    invoice = feeds.invoice_issued(org, subtotal="100")
    feeds.receipt(org)
    result = run_sync(org)
    assert result["posted"] == 1  # purchasing is unaffected by sales being down
    summary = api.get(f"{PREFIX}/overview").json()["sync"]
    sources = {s["source"]: s for s in summary["sources"]}
    assert sources["sales"]["status"] == "error" and sources["sales"]["consecutive_failures"] == 1 and "Sales Service" in sources["sales"]["last_error"]
    assert sources["purchasing"]["status"] == "ok" and sources["purchasing"]["consecutive_failures"] == 0
    run_sync(org)
    assert {s["source"]: s["consecutive_failures"] for s in api.get(f"{PREFIX}/overview").json()["sync"]["sources"]}["sales"] == 2
    feeds.down = set()
    feeds.payment(org, invoice, "30")
    run_sync(org)
    assert len(entries_of(session_factory, org)) == 3  # the invoice, the payment and the receipt - each exactly once
    sources = {s["source"]: s for s in api.get(f"{PREFIX}/overview").json()["sync"]["sources"]}
    assert sources["sales"]["status"] == "ok" and sources["sales"]["consecutive_failures"] == 0 and sources["sales"]["last_error"] is None


def test_the_error_never_leaks_the_secret_or_internals(api, org, feeds, run_sync):
    feeds.down = {"sales"}
    run_sync(org)
    error = {s["source"]: s for s in api.get(f"{PREFIX}/overview").json()["sync"]["sources"]}["sales"]["last_error"]
    assert error == "Sales Service: ConnectError"


def test_an_unreadable_response_is_an_error_not_a_crash(api, org, feeds, run_sync):
    feeds.feed = lambda *args, **kwargs: "not a feed"
    run_sync(org)
    sources = {s["source"]: s for s in api.get(f"{PREFIX}/overview").json()["sync"]["sources"]}
    assert sources["sales"]["status"] == "error" and "unreadable" in sources["sales"]["last_error"]


def test_a_malformed_event_is_ignored_and_does_not_block_the_good_ones(api, org, feeds, run_sync, session_factory):
    feeds.events[("sales", org)] = [{"key": "", "type": "invoice.issued", "time": "nonsense", "data": {}}, {"type": "invoice.issued"}, {"key": "k", "type": "invoice.issued", "time": now().isoformat(), "data": "x"}]
    feeds.invoice_issued(org, subtotal="10")
    run_sync(org)
    assert len(entries_of(session_factory, org)) == 1


def test_the_organization_list_being_down_is_survived(api, org, feeds, run_sync):
    feeds.down = {"organizations"}
    assert run_sync() == 0
    feeds.down = set()
    assert run_sync() == 2  # both organizations have Finance


def test_a_failing_event_backs_off_and_finally_waits_as_failed_for_a_person(api, org, feeds, run_sync, session_factory, monkeypatch):
    from app import sync

    feeds.invoice_issued(org)
    monkeypatch.setenv("FINANCE_SYNC_MAX_ATTEMPTS", "3")
    monkeypatch.setattr(sync, "handle", lambda db, event: (_ for _ in ()).throw(RuntimeError("boom")))
    run_sync(org)
    (event,) = events(session_factory, org)
    assert (event.status, event.attempts) == ("pending", 1)
    with session_factory() as db:
        assert db.execute(text("SELECT next_retry_at > now() + interval '20 seconds' FROM sync_events")).scalar() is True  # backed off
    assert run_sync(org)["posted"] == 0 and events(session_factory, org)[0].attempts == 1  # not due yet: not retried in a tight loop
    for _ in range(2):
        with session_factory() as db:
            db.execute(text("UPDATE sync_events SET next_retry_at = now()"))
            db.commit()
        run_sync(org)
    (event,) = events(session_factory, org)
    assert (event.status, event.attempts) == ("failed", 3)
    summary = api.get(f"{PREFIX}/overview").json()["sync"]
    assert summary["failed"] == 1
    monkeypatch.undo()
    retried = api.client.post(f"{SYNC}/events/{api.client.get(f'{SYNC}/events', headers=api.headers).json()['items'][0]['id']}/retry", headers=api.headers)
    assert retried.status_code == 200 and retried.json()["status"] == "pending" and retried.json()["attempts"] == 0
    run_sync(org)
    assert len(entries_of(session_factory, org)) == 1 and events(session_factory, org)[0].status == "posted"
    assert api.client.post(f"{SYNC}/events/{retried.json()['id']}/retry", headers=api.headers).status_code == 409  # only a failed event can be retried


# ------------------------------------------------------------------------------------------------------------------ untrusted data is never guessed
@pytest.mark.parametrize("change,reason", [
    ({"total": "999.00"}, "total is not"),
    ({"currency": "usd"}, "unknown currency"),
    ({"currency": "ZZZ"}, "unknown currency"),
    ({"subtotal": "10.00001", "total": "10.00001"}, "more than 4 decimal places"),
    ({"subtotal": "-5", "total": "-5"}, "must not be negative"),
])
def test_inconsistent_invoice_data_is_held_as_failed_never_corrected(api, org, feeds, run_sync, session_factory, change, reason):
    feeds.invoice_issued(org, **change)
    run_sync(org)
    (event,) = events(session_factory, org)
    assert event.status == "failed" and reason in event.last_error and event.attempts == 1 and event.journal_entry_id is None
    assert entries_of(session_factory, org) == []
    assert api.get(f"{SYNC}/events", params={"status": "failed"}).json()["total"] == 1


def test_unknown_event_types_are_kept_but_skipped(api, org, feeds, run_sync, session_factory):
    feeds.add("sales", org, "future-thing:1", "invoice.teleported", now(), {"x": 1})
    feeds.add("purchasing", org, "invoice-issued:wrong-source", "invoice.issued", now(), {"x": 1})
    run_sync(org)
    assert [(e.status, e.last_error) for e in events(session_factory, org)] == [("skipped", "Unsupported event type")] * 2


# ------------------------------------------------------------------------------------------------------------------ cut-over and ordering
def test_events_before_activation_are_not_backfilled(api, org, feeds, run_sync, session_factory):
    feeds.invoice_issued(org, number="OLD", when=ACTIVATED - timedelta(days=3))
    feeds.invoice_issued(org, number="NEW", when=ACTIVATED + timedelta(days=3))
    run_sync(org)
    assert [e.event_key for e in events(session_factory, org)] and len(events(session_factory, org)) == 1
    (entry,) = entries_of(session_factory, org)
    assert api.client.get(f"{ENTRIES}/{entry.id}", headers=api.headers).json()["reference"] == "NEW"
    assert api.get(f"{PREFIX}/overview").json()["activated_at"].startswith("2026-11-01")


def test_voiding_an_invoice_issued_before_activation_is_skipped_not_reversed(api, org, feeds, run_sync, session_factory):
    old = feeds.invoice_issued(org, when=ACTIVATED - timedelta(days=3))
    feeds.invoice_voided(org, old, when=ACTIVATED + timedelta(days=1))
    run_sync(org)
    assert entries_of(session_factory, org) == [] and [(e.event_type, e.status) for e in events(session_factory, org)] == [("invoice.voided", "skipped")]


def test_a_void_that_arrives_before_its_invoice_waits_and_then_reverses_it(api, org, feeds, run_sync, session_factory, monkeypatch):
    monkeypatch.setenv("FINANCE_SYNC_RETRY_BASE_SECONDS", "0")
    invoice = feeds.invoice_issued(org, subtotal="100", when=now() - timedelta(minutes=10))
    feeds.invoice_voided(org, invoice, when=now() - timedelta(minutes=1))
    held = feeds.events[("sales", org)].pop(0)  # the issued event has not reached us yet
    run_sync(org)
    (event,) = events(session_factory, org)
    assert event.event_type == "invoice.voided" and event.status == "pending" and event.attempts == 1 and "waiting" in event.last_error
    feeds.events[("sales", org)].insert(0, held)
    run_sync(org)
    run_sync(org)
    assert [e.status for e in events(session_factory, org)] == ["posted", "posted"]
    assert sorted(e.source_type for e in entries_of(session_factory, org)) == ["reversal", "sales"]


def test_a_void_of_an_invoice_whose_entry_was_already_reversed_by_hand_is_skipped(api, org, feeds, run_sync, session_factory):
    invoice = feeds.invoice_issued(org, subtotal="100", when=now() - timedelta(minutes=10))
    run_sync(org)
    (entry,) = entries_of(session_factory, org)
    api.reverse(str(entry.id), "Corrected by hand")
    feeds.invoice_voided(org, invoice, when=now() - timedelta(minutes=1))
    run_sync(org)
    assert [(e.event_type, e.status) for e in events(session_factory, org)] == [("invoice.issued", "posted"), ("invoice.voided", "skipped")]
    assert len(entries_of(session_factory, org)) == 2


# ------------------------------------------------------------------------------------------------------------------ who is synchronised
def test_only_organizations_with_finance_are_synchronised_and_a_disabled_one_stops(directory, two_orgs, api, feeds, run_sync, session_factory):
    alpha, beta = two_orgs["alpha_id"], two_orgs["beta_id"]
    directory.organizations[beta]["modules"] = []
    api.accounts()
    feeds.invoice_issued(alpha, subtotal="10")
    feeds.invoice_issued(beta, subtotal="20")
    assert run_sync() == 1
    assert len(entries_of(session_factory, alpha)) == 1 and entries_of(session_factory, beta) == []
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM finance_organizations WHERE organization_id = :b"), {"b": beta}).scalar() == 0
    directory.organizations[alpha]["modules"] = []  # the Super Admin switches Finance off
    feeds.invoice_issued(alpha, number="WHILE-OFF", subtotal="5")
    run_sync()
    assert len(entries_of(session_factory, alpha)) == 1
    directory.organizations[alpha]["modules"] = ["finance"]  # ... and on again: what happened meanwhile is caught up, once
    run_sync()
    run_sync()
    assert len(entries_of(session_factory, alpha)) == 2


def test_the_worker_sets_up_finance_for_an_organization_nobody_has_opened_yet(directory, two_orgs, feeds, run_sync, session_factory):
    alpha = two_orgs["alpha_id"]
    feeds.invoice_issued(alpha, subtotal="10")
    run_sync()  # no request has been made by an administrator yet
    assert len(entries_of(session_factory, alpha)) == 1
    with session_factory() as db:
        assert db.execute(text("SELECT count(*) FROM accounts WHERE organization_id = :o AND is_system"), {"o": alpha}).scalar() == 8
        assert db.execute(text("SELECT activated_at FROM finance_organizations WHERE organization_id = :o"), {"o": alpha}).scalar() == ACTIVATED


def test_the_first_request_uses_the_time_finance_was_switched_on_as_the_cut_over(directory, two_orgs, api, feeds):
    feeds.enabled_at[two_orgs["alpha_id"]] = now() - timedelta(days=2)
    overview = api.get(f"{PREFIX}/overview").json()
    assert overview["activated_at"][:10] == (now() - timedelta(days=2)).date().isoformat()


# ------------------------------------------------------------------------------------------------------------------ the API
def test_sync_now_posts_for_the_callers_organization_only(two_orgs, feeds, session_factory):
    alpha, beta = two_orgs["alpha"], two_orgs["beta"]
    alpha.accounts(), beta.accounts()
    feeds.invoice_issued(two_orgs["alpha_id"], subtotal="10")
    feeds.invoice_issued(two_orgs["beta_id"], subtotal="20")
    assert alpha.sync()["posted"] == 1
    assert len(entries_of(session_factory, two_orgs["alpha_id"])) == 1 and entries_of(session_factory, two_orgs["beta_id"]) == []
    assert beta.sync()["posted"] == 1


def test_sync_now_is_unavailable_without_a_configured_secret(api, client):
    client.app.state.feed_client = None
    assert api.client.post(f"{SYNC}/run", headers=api.headers).status_code == 503


def test_the_event_list_shows_only_this_organizations_events_with_filters(two_orgs, api, org, feeds, run_sync):
    feeds.invoice_issued(org, subtotal="10")
    feeds.invoice_issued(org, total="5", subtotal="9")  # inconsistent: failed
    feeds.invoice_issued(two_orgs["beta_id"], subtotal="20")
    two_orgs["beta"].accounts()
    run_sync(org), run_sync(two_orgs["beta_id"])
    listing = api.get(f"{SYNC}/events").json()
    assert listing["total"] == 2 and {e["status"] for e in listing["items"]} == {"posted", "failed"}
    assert api.get(f"{SYNC}/events", params={"status": "failed"}).json()["total"] == 1
    foreign = two_orgs["beta"].get(f"{SYNC}/events").json()["items"][0]["id"]
    assert api.client.post(f"{SYNC}/events/{foreign}/retry", headers=api.headers).status_code == 404
    assert api.client.post(f"{SYNC}/events/{uuid.uuid4()}/retry", headers=api.headers).status_code == 404


def test_the_overview_reports_synchronisation_health(api, org, feeds, run_sync):
    feeds.invoice_issued(org, subtotal="10")
    feeds.invoice_issued(org, subtotal="9", total="1")
    feeds.add("sales", org, "x:1", "other.type", now(), {})
    run_sync(org)
    summary = api.get(f"{PREFIX}/overview").json()["sync"]
    assert (summary["posted"], summary["failed"], summary["skipped"], summary["pending"]) == (1, 1, 1, 0)
    assert {s["source"] for s in summary["sources"]} == {"sales", "purchasing"} and all(s["status"] == "ok" for s in summary["sources"])
