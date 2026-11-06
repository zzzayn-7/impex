"""The email outbox worker.

Notification records are written in the same transaction as the ticket or message they announce (app/tickets.py). This worker sends
them AFTERWARDS:

  claim   a short transaction picks due rows with FOR UPDATE SKIP LOCKED, marks them `sending`, counts the attempt and sets a lease
          (`locked_until`), so several workers never take the same row and a worker that dies mid-send does not strand it: when the lease
          expires the row is picked up again;
  send    over SMTP, with NO database transaction open;
  settle  `sent` on success; on a failure the row goes back to `pending` with an exponentially growing `next_retry_at`
          (SUPPORT_OUTBOX_RETRY_BASE_SECONDS, default 30 s, capped at 1 h) until SUPPORT_OUTBOX_MAX_ATTEMPTS (default 8), then `failed`.
          A failed row stays visible to the Super Admin with its (credential-free) reason and can be retried from the portal.

Exactly-once delivery is NOT promised: if the process dies after SMTP accepted a message but before `sent` is recorded, the row is sent
again. That is the deliberate trade-off: a notification may repeat, a request is never lost.
"""
import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Callable, Optional

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session, sessionmaker

from app.mailer import EmailDeliveryError, build_message, load_smtp_settings, sanitize_error, send, support_recipient
from app.models import SupportEmailOutbox, SupportMessage, SupportTicket

logger = logging.getLogger("impex.support.outbox")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


def max_attempts() -> int:
    return _int_env("SUPPORT_OUTBOX_MAX_ATTEMPTS", 8)


def backoff(attempts: int) -> timedelta:
    base = _int_env("SUPPORT_OUTBOX_RETRY_BASE_SECONDS", 30)
    return timedelta(seconds=min(base * (2 ** max(attempts - 1, 0)), 3600))


def claim_due(db: Session, limit: int = 10) -> list:
    now = _now()
    rows = db.scalars(
        select(SupportEmailOutbox)
        .where(or_(
            and_(SupportEmailOutbox.delivery_status == "pending", SupportEmailOutbox.next_retry_at <= now),
            and_(SupportEmailOutbox.delivery_status == "sending", SupportEmailOutbox.locked_until < now),  # a worker died holding it
        ))
        .order_by(SupportEmailOutbox.next_retry_at, SupportEmailOutbox.created_at).limit(limit).with_for_update(skip_locked=True)
    ).all()
    lease = timedelta(seconds=_int_env("SUPPORT_OUTBOX_LEASE_SECONDS", 120))
    for row in rows:
        row.delivery_status, row.attempts, row.locked_until = "sending", row.attempts + 1, now + lease
    db.commit()
    return [row.id for row in rows]


def _settle(db: Session, outbox_id, *, error: Optional[str], retryable: bool = True) -> None:
    row = db.get(SupportEmailOutbox, outbox_id, with_for_update=True)
    if row is None:
        return
    row.locked_until = None
    if error is None:
        row.delivery_status, row.sent_at, row.last_error = "sent", _now(), None
    elif not retryable or row.attempts >= max_attempts():
        row.delivery_status, row.last_error = "failed", error
        logger.error("support notification %s FAILED after %s attempt(s): %s", row.id, row.attempts, error)
    else:
        row.delivery_status, row.last_error, row.next_retry_at = "pending", error, _now() + backoff(row.attempts)
        logger.warning("support notification %s will be retried (attempt %s): %s", row.id, row.attempts, error)
    db.commit()


def deliver_one(db: Session, outbox_id) -> str:
    """Send one claimed notification. Returns 'sent', 'retry' or 'failed'."""
    row = db.get(SupportEmailOutbox, outbox_id)
    ticket = db.get(SupportTicket, row.ticket_id)
    message = db.get(SupportMessage, row.message_id) if row.message_id else None
    kind = row.notification_type
    recipient = row.recipient or (support_recipient() if kind != "staff_reply" else "")
    # Copy what the email needs, THEN end the transaction: no database transaction is open while talking to the mail server.
    about = SimpleNamespace(id=ticket.id, ticket_number=ticket.ticket_number, organization_name=ticket.organization_name, subject=ticket.subject, category=ticket.category)
    body = message.message_body if message else None
    db.rollback()
    try:
        if not recipient:
            raise EmailDeliveryError("SUPPORT_NOTIFICATION_EMAIL is not configured", retryable=True)
        send(build_message(load_smtp_settings(), kind=kind, recipient=recipient, ticket=about, message_body=body))
    except EmailDeliveryError as exc:
        _settle(db, outbox_id, error=str(exc), retryable=exc.retryable)
    except Exception as exc:  # anything unexpected is a delivery failure, never a crash of the worker
        _settle(db, outbox_id, error=sanitize_error(exc))
    else:
        _settle(db, outbox_id, error=None)
    state = db.get(SupportEmailOutbox, outbox_id).delivery_status
    return "sent" if state == "sent" else ("failed" if state == "failed" else "retry")


def process_batch(session_factory: Callable[[], Session], limit: int = 10) -> dict:
    """One pass: claim what is due and send it. Safe to call from several workers at once."""
    counts = {"sent": 0, "retry": 0, "failed": 0}
    with session_factory() as db:
        ids = claim_due(db, limit)
    for outbox_id in ids:
        with session_factory() as db:
            counts[deliver_one(db, outbox_id)] += 1
    return counts


async def run_worker(session_factory: sessionmaker, stop: asyncio.Event) -> None:
    interval = float(os.getenv("SUPPORT_OUTBOX_INTERVAL_SECONDS", "5"))
    logger.info("support email worker started (every %.1fs)", interval)
    while not stop.is_set():
        try:
            await asyncio.to_thread(process_batch, session_factory)
        except Exception:  # the database may be briefly unavailable: log and keep going
            logger.exception("support email worker pass failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass
    logger.info("support email worker stopped")
