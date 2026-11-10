"""Posting Sales and Purchasing facts into the books - safely, exactly once, and without ever touching their records.

How it works (a durable, pull-based synchronisation; see docs/finance.md):

  1. PULL. For each organization that currently has Finance, the worker reads the Sales and Purchasing read-only feeds (shared secret; no user is
     logged in). It re-reads a short OVERLAP before its last position, because a row commits slightly after its own timestamp.
  2. STORE. Every event is saved in `sync_events` under its stable key (UNIQUE per organization, INSERT ... ON CONFLICT DO NOTHING). Reading the
     same fact twice - a retry, the overlap, a restart, two replicas - can therefore never create a second row.
  3. POST. Each pending event is posted in its OWN transaction under a row lock (FOR UPDATE SKIP LOCKED), as ONE journal entry whose `source_key` is the
     event key (a second UNIQUE guard). The event is marked posted in the same transaction. Either both happen or neither.
  4. RECOVER. If Sales/Purchasing/the Organization Service is down, the source is marked `error` and the next cycle simply tries again from the same
     position - nothing is lost or duplicated. A failing event is retried with exponential back-off and marked `failed` (visible, manually
     retryable) after FINANCE_SYNC_MAX_ATTEMPTS.

The recognition policy (what becomes an accounting entry):
  invoice.issued     Dr Accounts Receivable (total)      Cr Sales Revenue (subtotal - discount) [+ Cr Sales Tax Payable (tax)]
  invoice.voided     reverses the entry above (only if Finance posted it); a void of an invoice issued before Finance was activated is skipped
  payment.recorded   Dr Payments Received                Cr Accounts Receivable        (a payment RECORDED in Sales: no bank is implied)
  payment.reversed   Dr Accounts Receivable              Cr Payments Received
  receipt.confirmed  Dr Inventory                        Cr Goods Received Not Invoiced (accepted quantity x purchase order unit price)
Nothing is recognised from a purchase order alone, and no supplier payable is invented: Purchasing has no supplier invoice.

Each entry is in the event's OWN currency. Nothing is converted. Events dated before the organization's Finance activation are not back-filled.

The same events also feed the REPORTING model behind the Finance page (app/trading.py, in the SAME transaction as the entry, so both exist or neither does):
  receipt.confirmed   the stock cost of each product goes up by accepted quantity x purchase price (an investment activity - never an owner contribution)
  delivery.confirmed  (Sales) revenue and cost of goods sold are recognised ONCE, when the goods leave; no journal entry is made for it
  invoice.issued      only ADJUSTS the revenue delivery recognised (a discount); it never recognises revenue again
  invoice.voided      reverses those adjustments
"""
import logging
import os
import threading
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Callable, Dict, List, Optional

import httpx
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app import ledger, trading
from app.chart import activated_at as org_activated_at, ensure_setup, system_account
from app.common import Actor, audit
from app.currencies import is_known_currency
from app.models import FinanceOrganization, JournalEntry, SyncEvent, SyncSource

log = logging.getLogger("impex.finance.sync")

OVERLAP = timedelta(minutes=10)
MAX_PAGES = 20
PAGE_SIZE = 500
ZERO = Decimal("0")

SALES_TYPES = {"invoice.issued", "invoice.voided", "payment.recorded", "payment.reversed", "delivery.confirmed"}
PURCHASING_TYPES = {"receipt.confirmed"}
KNOWN_TYPES = {"sales": SALES_TYPES, "purchasing": PURCHASING_TYPES}


def max_attempts() -> int:
    return max(1, int(os.getenv("FINANCE_SYNC_MAX_ATTEMPTS", "8")))


def backoff(attempts: int) -> timedelta:
    return timedelta(seconds=min(3600, int(os.getenv("FINANCE_SYNC_RETRY_BASE_SECONDS", "30")) * (2 ** max(0, attempts - 1))))


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --- the services we read (replaceable in tests) -------------------------------------------------------------------------------------
class SourceUnavailable(Exception):
    """A service could not be reached or refused us. Never contains the shared secret."""


class FeedClient:
    def __init__(self, organization_url: str, sales_url: str, purchasing_url: str, key: str, timeout: float = 10.0):
        self._urls = {"sales": sales_url.rstrip("/"), "purchasing": purchasing_url.rstrip("/")}
        self._organization_url = organization_url.rstrip("/")
        self._headers = {"X-Internal-Key": key}
        self._http = httpx.Client(timeout=timeout)

    def _get(self, url: str, params: Optional[dict] = None):
        try:
            response = self._http.get(url, params=params, headers=self._headers)
        except httpx.HTTPError as exc:
            raise SourceUnavailable(f"{type(exc).__name__}") from None
        if response.status_code != 200:
            raise SourceUnavailable(f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError:
            raise SourceUnavailable("invalid response") from None

    def organizations(self) -> List[dict]:
        """The organizations that can use Finance right now (active, set up, Finance switched on)."""
        return self._get(f"{self._organization_url}/internal/v1/modules/finance/organizations")

    def feed(self, source: str, organization_id: uuid.UUID, since: Optional[datetime], limit: int) -> dict:
        params = {"limit": limit}
        if source == "sales":
            params["include_deliveries"] = "true"  # confirmed dispatches: the moment revenue is recognised
        if since is not None:
            params["since"] = since.isoformat()
        return self._get(f"{self._urls[source]}/internal/v1/organizations/{organization_id}/finance-feed", params)

    def close(self) -> None:
        self._http.close()


def create_feed_client() -> Optional[FeedClient]:
    key = os.getenv("MODULE_INTERNAL_API_KEY", "")
    if not key:
        return None
    return FeedClient(
        os.getenv("ORG_SERVICE_URL", "http://organization-service:8001"), os.getenv("SALES_SERVICE_URL", "http://sales-service:8003"),
        os.getenv("PURCHASING_SERVICE_URL", "http://purchasing-service:8004"), key,
    )


# --- 1 + 2: pull and store ---------------------------------------------------------------------------------------------------------------
def _parse_time(value) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def pull_source(session_factory: Callable[[], Session], client, organization_id: uuid.UUID, source: str) -> int:
    """Read one source's feed and store what is new. Returns the number of NEW events. Never raises for an unavailable source: it records the
    failure on the source and the next cycle retries from the same position."""
    stored = 0
    with session_factory() as db:
        cutoff = org_activated_at(db, organization_id)
        if cutoff is None:  # Finance was never set up for this organization
            return 0
        position = db.get(SyncSource, (organization_id, source))
        if position is None:
            db.execute(pg_insert(SyncSource).values(organization_id=organization_id, source=source).on_conflict_do_nothing())
            db.commit()
            position = db.get(SyncSource, (organization_id, source))
        since = max(cutoff, position.cursor_time - OVERLAP) if position.cursor_time else cutoff
        newest = position.cursor_time
        limit = PAGE_SIZE
        try:
            for _page in range(MAX_PAGES):
                body = client.feed(source, organization_id, since, limit)
                events = body.get("events") or []
                for event in events:
                    inserted, when = _store(db, organization_id, source, event, cutoff)
                    stored += inserted
                    if when and (newest is None or when > newest):
                        newest = when
                db.commit()
                if not body.get("has_more") or not events:
                    break
                last = _parse_time(events[-1]["time"])
                if last <= since:  # a full page of events all at one instant: ask for a bigger page once, then give up loudly
                    if limit >= 1000:
                        raise SourceUnavailable("the feed did not advance")
                    limit = 1000
                    continue
                since = last
            _record(db, organization_id, source, ok=True, newest=newest)
        except (SourceUnavailable, KeyError, ValueError, TypeError, AttributeError) as exc:
            db.rollback()
            _record(db, organization_id, source, ok=False, error=f"{source.title()} Service: {exc}"[:300] if isinstance(exc, SourceUnavailable) else f"{source.title()} Service sent an unreadable response"[:300])
    return stored


def _store(db: Session, organization_id: uuid.UUID, source: str, event: dict, cutoff: datetime):
    """Keep one received event. Returns (1 if it was new else 0, its time). One malformed event is logged and ignored: it must never block the others."""
    try:
        key, kind, data = event.get("key"), event.get("type"), event.get("data")
        if not isinstance(key, str) or not key or len(key) > 160 or not isinstance(kind, str) or not isinstance(data, dict):
            raise ValueError("malformed event")
        when = _parse_time(event["time"])
    except (ValueError, KeyError, TypeError, AttributeError):
        log.warning("finance sync: ignoring a malformed %s event for organization %s", source, organization_id)
        return 0, None
    if when < cutoff:
        return 0, when  # dated before Finance was activated: not back-filled
    supported = kind in KNOWN_TYPES[source]
    inserted = db.execute(
        pg_insert(SyncEvent)
        .values(
            organization_id=organization_id, source=source, event_key=key, event_type=kind[:30], event_time=when, payload=data,
            status="pending" if supported else "skipped", last_error=None if supported else "Unsupported event type", processed_at=None if supported else _now(),
        )
        .on_conflict_do_nothing(index_elements=["organization_id", "event_key"])
        .returning(SyncEvent.id)
    ).first()
    return (1 if inserted else 0), when


def _record(db: Session, organization_id: uuid.UUID, source: str, *, ok: bool, newest: Optional[datetime] = None, error: Optional[str] = None) -> None:
    row = db.get(SyncSource, (organization_id, source))
    row.last_attempt_at = _now()
    if ok:
        row.status, row.last_success_at, row.last_error, row.consecutive_failures = "ok", _now(), None, 0
        if newest is not None:
            row.cursor_time = newest
    else:
        row.status, row.last_error, row.consecutive_failures = "error", error, row.consecutive_failures + 1
    db.commit()


# --- 3: post -----------------------------------------------------------------------------------------------------------------------------
class Skip(Exception):
    """This event produces no entry (and never will)."""


class Defer(Exception):
    """Not yet - something it depends on has not arrived. Retried with back-off."""


class Reject(Exception):
    """The event's data cannot be trusted (inconsistent amounts, unknown currency): kept as `failed` for a person to look at - nothing is guessed."""


def _decimal(data: dict, field: str, *, allow_zero: bool = True) -> Decimal:
    try:
        value = Decimal(str(data[field]))
    except (KeyError, InvalidOperation):
        raise Reject(f"'{field}' is missing or not a number")
    if not value.is_finite() or value < 0 or (not allow_zero and value == 0):
        raise Reject(f"'{field}' must be a positive amount" if not allow_zero else f"'{field}' must not be negative")
    quantized = value.quantize(ledger.QUANT, rounding=ROUND_HALF_UP)
    if quantized != value:
        raise Reject(f"'{field}' has more than 4 decimal places")
    return quantized


def _currency(data: dict) -> str:
    code = str(data.get("currency_code") or "")
    if not is_known_currency(code):
        raise Reject(f"unknown currency '{code}'")  # never guessed or defaulted
    return code


def _date(value, fallback: Optional[datetime] = None) -> date:
    if value:
        try:
            return date.fromisoformat(str(value)[:10])
        except ValueError:
            raise Reject("unreadable date")
    if fallback is None:
        raise Reject("missing date")
    return fallback.astimezone(timezone.utc).date()


def _text(value, fallback: str, limit: int = 120) -> str:
    return " ".join(str(value or fallback).split())[:limit]


def _post(db: Session, event: SyncEvent, *, description: str, reference: Optional[str], currency: str, entry_date: date, lines: list, summary: str) -> JournalEntry:
    specs = [(account.id, debit, credit, None) for account, debit, credit in lines]
    return ledger.create_entry(
        db, event.organization_id, Actor.sync(), entry_date=entry_date, description=description[:500], reference=reference, currency=currency, specs=specs,
        source_type=event.source, source_key=event.event_key, source_summary=summary[:300], post=True,
    )


def _handle_invoice_issued(db: Session, event: SyncEvent) -> JournalEntry:
    data, org = event.payload, event.organization_id
    currency = _currency(data)
    subtotal, discount, tax, total = (_decimal(data, f) for f in ("subtotal", "discount_total", "tax_total", "total"))
    if total != subtotal - discount + tax:
        raise Reject("the invoice total is not subtotal - discount + tax")  # we post what Sales says, never a recomputed figure
    if total == 0:
        raise Skip("zero-value invoice")
    revenue = subtotal - discount
    receivable, sales, payable = system_account(db, org, "accounts_receivable"), system_account(db, org, "sales_revenue"), system_account(db, org, "sales_tax_payable")
    lines = [(receivable, total, ZERO)]
    if revenue > 0:
        lines.append((sales, ZERO, revenue))
    if tax > 0:
        lines.append((payable, ZERO, tax))
    number, client = _text(data.get("number"), "?", 30), _text(data.get("client_name"), "a client")
    return _post(db, event, description=f"Invoice {number} issued to {client}", reference=number, currency=currency, entry_date=_date(None, _parse_time(data.get("issued_at") or event.event_time)), lines=lines,
                 summary=f"Invoice {number} issued to {client}")


def _handle_invoice_voided(db: Session, event: SyncEvent) -> JournalEntry:
    data, org = event.payload, event.organization_id
    invoice_id = str(data.get("invoice_id") or "")
    issued_key = f"invoice-issued:{invoice_id}"
    original = db.scalar(select(JournalEntry).where(JournalEntry.organization_id == org, JournalEntry.source_key == issued_key).with_for_update())
    number = _text(data.get("number"), "?", 30)
    if original is None:
        issued_event = db.scalar(select(SyncEvent).where(SyncEvent.organization_id == org, SyncEvent.event_key == issued_key))
        if issued_event is not None and (issued_event.status == "skipped" or (issued_event.status == "posted" and issued_event.journal_entry_id is None)):
            raise Skip("the invoice produced no entry, so there is nothing to reverse")
        if issued_event is None and data.get("issued_at") and _parse_time(data["issued_at"]) < (org_activated_at(db, org) or _now()):
            raise Skip("the invoice was issued before Finance was activated")
        raise Defer("waiting for the invoice's issued event to be posted first")
    existing = ledger.reversal_of(db, org, original.id)
    if existing is not None:
        raise Skip(f"already reversed by {existing.entry_number}")
    return ledger.reverse_posted(db, original, Actor.sync(), reason=f"Invoice {number} was voided in Sales", source_key=event.event_key, source_summary=f"Invoice {number} voided")


def _handle_payment(db: Session, event: SyncEvent, *, reversed_: bool) -> JournalEntry:
    data, org = event.payload, event.organization_id
    currency, amount = _currency(data), _decimal(data, "amount", allow_zero=False)
    cash, receivable = system_account(db, org, "payments_received"), system_account(db, org, "accounts_receivable")
    number, method = _text(data.get("invoice_number"), "?", 30), _text(data.get("method"), "payment", 40)
    lines = [(receivable, amount, ZERO), (cash, ZERO, amount)] if reversed_ else [(cash, amount, ZERO), (receivable, ZERO, amount)]
    what = f"Payment reversed on invoice {number}" if reversed_ else f"Payment received on invoice {number} ({method})"
    return _post(db, event, description=what, reference=number, currency=currency, entry_date=_date(data.get("payment_date"), event.event_time), lines=lines, summary=what)


def _handle_receipt(db: Session, event: SyncEvent) -> JournalEntry:
    data, org = event.payload, event.organization_id
    currency = _currency(data)
    lines_data = data.get("lines")
    if not isinstance(lines_data, list) or not lines_data:
        raise Skip("nothing was accepted on this receipt")
    value = ZERO
    for line in lines_data:
        try:
            value += Decimal(str(line["accepted_quantity"])) * Decimal(str(line["unit_price"]))
        except (KeyError, InvalidOperation, TypeError):
            raise Reject("a receipt line has no readable quantity or price")
    if value < 0:
        raise Reject("negative receipt value")
    value = value.quantize(ledger.QUANT, rounding=ROUND_HALF_UP)  # rounded ONCE, on the whole receipt
    if value == 0:
        raise Skip("zero-value receipt")
    inventory, grni = system_account(db, org, "inventory"), system_account(db, org, "goods_received_not_invoiced")
    receipt, order, supplier = _text(data.get("receipt_number"), "?", 30), _text(data.get("purchase_order_number"), "?", 30), _text(data.get("supplier_name"), "a supplier")
    what = f"Goods receipt {receipt} for {order} from {supplier}"
    return _post(db, event, description=what, reference=receipt, currency=currency, entry_date=_date(None, _parse_time(data.get("confirmed_at") or event.event_time)), lines=[(inventory, value, ZERO), (grni, ZERO, value)], summary=what)


def handle(db: Session, event: SyncEvent) -> Optional[JournalEntry]:
    """Record one event. Returns its journal entry, or None when it only feeds the reporting model (a delivery; an invoice whose total is zero)."""
    try:
        return _handle(db, event)
    except trading.Unreadable as exc:
        raise Reject(str(exc))
    except trading.NotYet as exc:
        raise Defer(str(exc))


def _handle(db: Session, event: SyncEvent) -> Optional[JournalEntry]:
    kind, org, actor = event.event_type, event.organization_id, Actor.sync()
    if kind == "invoice.issued":
        adjusted = trading.apply_invoice_issued(db, org, event.payload, org_activated_at(db, org), actor)
        try:
            return _handle_invoice_issued(db, event)
        except Skip:
            if adjusted:
                return None  # a zero-value invoice has no entry, but its (discount) adjustment stands
            raise
    if kind == "invoice.voided":
        adjusted = trading.apply_invoice_voided(db, org, event.payload, actor)
        try:
            return _handle_invoice_voided(db, event)
        except Skip:
            if adjusted:
                return None
            raise
    if kind == "payment.recorded":
        return _handle_payment(db, event, reversed_=False)
    if kind == "payment.reversed":
        return _handle_payment(db, event, reversed_=True)
    if kind == "receipt.confirmed":
        entry = _handle_receipt(db, event)
        trading.apply_receipt(db, org, event.payload, actor)
        return entry
    if kind == "delivery.confirmed":
        trading.apply_delivery(db, org, event.payload, actor)
        return None
    raise Skip("unsupported event type")


@dataclass
class Processed:
    posted: int = 0
    skipped: int = 0
    deferred: int = 0
    failed: int = 0

    @property
    def total(self) -> int:
        return self.posted + self.skipped + self.deferred + self.failed


def process_due(session_factory: Callable[[], Session], organization_id: Optional[uuid.UUID] = None, limit: int = 200) -> Processed:
    """Post what is due, oldest first. Each event is its own transaction under its own row lock."""
    result = Processed()
    attempted: set = set()
    for _ in range(limit):
        with session_factory() as db:
            query = (
                select(SyncEvent).where(SyncEvent.status == "pending", SyncEvent.next_retry_at <= func.now())
                .order_by(SyncEvent.event_time, SyncEvent.id).limit(1).with_for_update(skip_locked=True)
            )
            if organization_id is not None:
                query = query.where(SyncEvent.organization_id == organization_id)
            if attempted:
                query = query.where(SyncEvent.id.not_in(attempted))
            event = db.scalar(query)
            if event is None:
                return result
            attempted.add(event.id)
            _process_one(db, event, result)
    return result


def _process_one(db: Session, event: SyncEvent, result: Processed) -> None:
    event_id, organization_id = event.id, event.organization_id
    try:
        entry = handle(db, event)
        event.status, event.journal_entry_id, event.processed_at, event.last_error = "posted", entry.id if entry is not None else None, _now(), None
        db.commit()  # the entry, its audit lines and the event's new status are one transaction
        result.posted += 1
        return
    except Skip as skip:
        db.rollback()
        _finish(db, event_id, "skipped", str(skip))
        result.skipped += 1
        return
    except Exception as exc:  # everything else is a failed attempt; nothing escapes the worker
        db.rollback()
        permanent = isinstance(exc, Reject)
        if isinstance(exc, (Defer, Reject)):
            message = str(exc)
        elif isinstance(exc, DBAPIError):
            detail = str(getattr(exc, "orig", exc))
            if "uq_journal_entries_organization_id_source_key" in detail and _link_existing(db, event_id, organization_id):
                result.posted += 1  # the entry already exists (a previous attempt committed it): this event is done, and nothing was posted twice
                return
            message = "a database rule refused the entry: " + detail.split("ERROR:")[-1].strip().splitlines()[0]
        else:
            message = f"unexpected {type(exc).__name__}"
        log.warning("finance sync: event %s of organization %s not posted: %s", event_id, organization_id, message)
    row = db.scalar(select(SyncEvent).where(SyncEvent.id == event_id).with_for_update())
    if row is None or row.status != "pending":
        db.rollback()
        return
    row.attempts += 1
    row.last_error = message[:300]
    if permanent or row.attempts >= max_attempts():
        row.status = "failed"
        result.failed += 1
        audit(db, organization_id, "sync", row.id, "event_failed", Actor.sync(), f"{row.event_key}: {message}")
    else:
        row.next_retry_at = _now() + backoff(row.attempts)
        result.deferred += 1
    db.commit()


def _link_existing(db: Session, event_id: uuid.UUID, organization_id: uuid.UUID) -> bool:
    row = db.scalar(select(SyncEvent).where(SyncEvent.id == event_id).with_for_update())
    entry = db.scalar(select(JournalEntry).where(JournalEntry.organization_id == organization_id, JournalEntry.source_key == row.event_key)) if row is not None else None
    if row is None or entry is None or row.status != "pending":
        db.rollback()
        return False
    row.status, row.journal_entry_id, row.processed_at, row.last_error = "posted", entry.id, _now(), None
    db.commit()
    return True


def _finish(db: Session, event_id: uuid.UUID, status: str, message: str) -> None:
    row = db.scalar(select(SyncEvent).where(SyncEvent.id == event_id).with_for_update())
    if row is not None and row.status == "pending":
        row.status, row.last_error, row.processed_at = status, message[:300], _now()
        db.commit()


# --- 4: the cycle ------------------------------------------------------------------------------------------------------------------------
def sync_organization(session_factory: Callable[[], Session], client, organization_id: uuid.UUID) -> Dict[str, int]:
    """Pull both sources and post what is due, for ONE organization (the caller has confirmed Finance is enabled for it)."""
    fetched = sum(pull_source(session_factory, client, organization_id, source) for source in ("sales", "purchasing"))
    done = process_due(session_factory, organization_id)
    return {"received": fetched, "posted": done.posted, "skipped": done.skipped, "retrying": done.deferred, "failed": done.failed}


def run_cycle(session_factory: Callable[[], Session], client) -> int:
    """One pass over every organization that has Finance. Returns how many organizations were synchronised. Never raises."""
    try:
        organizations = client.organizations()
    except SourceUnavailable as exc:
        log.warning("finance sync: cannot list organizations (%s); trying again next cycle", exc)
        return 0
    count = 0
    for item in organizations:
        try:
            organization_id = uuid.UUID(str(item["organization_id"]))
            enabled_at = _parse_time(item["enabled_at"])
        except (KeyError, ValueError, TypeError):
            continue
        try:
            with session_factory() as db:
                ensure_setup(db, organization_id, enabled_at)
            sync_organization(session_factory, client, organization_id)
            count += 1
        except Exception:  # one organization's trouble never stops the others
            log.exception("finance sync: organization %s failed this cycle", organization_id)
    return count


class Worker:
    """The background loop. FINANCE_SYNC_ENABLED=false disables it (tests drive `run_cycle` themselves)."""

    def __init__(self, session_factory: Callable[[], Session], client, interval: float):
        self._session_factory, self._client, self._interval = session_factory, client, interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="finance-sync", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                run_cycle(self._session_factory, self._client)
            except Exception:
                log.exception("finance sync cycle failed")
            self._stop.wait(self._interval)
