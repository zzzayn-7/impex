"""Support ticket business rules.

Every write is one short database transaction. A ticket, its first message, its audit event, its email notification record and its
idempotency record are saved TOGETHER or not at all; the email itself is sent later by the outbox worker (app/outbox.py), so an SMTP
outage can never lose a request.

Tenant functions take the caller's `Caller` (organization from the verified token); a ticket of another organization is a plain 404,
indistinguishable from one that does not exist. Platform functions are reached only through `require_super_admin`.
"""
import hashlib
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, exists, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

from app.auth import Caller, SUPER_ADMIN_ROLE, TENANT_ADMIN_ROLE
from app.mailer import support_recipient
from app.models import (
    SupportCounter, SupportEmailOutbox, SupportMessage, SupportRequest, SupportTicket, SupportTicketEvent, CATEGORIES, PRIORITIES, STATUSES,
)
from app.schemas import (
    CATEGORY_LABELS, STATUS_LABELS, EventResponse, MessageResponse, OutboxResponse, TicketCreate, TicketDetail, TicketPage, TicketSummary,
)

# The permitted status moves. The database trigger enforces the same table (alembic/versions/0001_support_tickets.py).
TRANSITIONS: Dict[str, Tuple[str, ...]] = {
    "open": ("in_progress", "waiting_for_customer", "resolved", "closed"),
    "in_progress": ("open", "waiting_for_customer", "resolved", "closed"),
    "waiting_for_customer": ("open", "in_progress", "resolved", "closed"),
    "resolved": ("open", "in_progress", "closed"),
    "closed": ("open",),
}
ACTIVE = ("open", "in_progress", "waiting_for_customer")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


def conflict(message: str, code: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, {"code": code, "message": message})


def _refusal(exc: DBAPIError) -> HTTPException:
    text = str(exc.orig)
    return conflict(f"That change is not allowed: {text.splitlines()[0] if text else 'refused by the database'}.", "refused")


# --- idempotency and rate limits ----------------------------------------------------------------------------------------
def request_hash(*parts) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


def claim_request(db: Session, scope_id: uuid.UUID, key: str, digest: str) -> Optional[SupportRequest]:
    """Record the key. Returns None when this call owns it; the EXISTING record when the key was already used (same request =
    a retry, different request = 409). A concurrent identical request waits on the unique index, then sees the winner's record."""
    inserted = db.execute(
        pg_insert(SupportRequest).values(scope_id=scope_id, idempotency_key=key, request_hash=digest)
        .on_conflict_do_nothing(index_elements=["scope_id", "idempotency_key"]).returning(SupportRequest.id)
    ).first()
    if inserted is not None:
        return None
    previous = db.scalar(select(SupportRequest).where(SupportRequest.scope_id == scope_id, SupportRequest.idempotency_key == key))
    if previous is None:
        raise conflict("The request was being processed. Please retry.", "busy")
    if previous.request_hash != digest:
        raise conflict("This Idempotency-Key was already used for a different request. Use a new key for a new request.", "idempotency_conflict")
    return previous


def enforce_rate_limit(db: Session, caller: Caller, kind: str) -> None:
    """Counted in the database (so it holds across restarts and several instances). 429 with Retry-After."""
    if kind == "ticket":
        limit, window = _int_env("SUPPORT_TICKETS_PER_HOUR", 10), timedelta(hours=1)
        count = db.scalar(select(func.count()).select_from(SupportTicket).where(SupportTicket.created_by_user_id == caller.user_id, SupportTicket.created_at > _now() - window))
    else:
        limit, window = _int_env("SUPPORT_MESSAGES_PER_10_MIN", 30), timedelta(minutes=10)
        count = db.scalar(select(func.count()).select_from(SupportMessage).where(SupportMessage.sender_user_id == caller.user_id, SupportMessage.created_at > _now() - window))
    if (count or 0) >= limit:
        what = "tickets" if kind == "ticket" else "messages"
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, {"code": "rate_limited", "message": f"You are sending {what} too quickly. Please wait a few minutes and try again."},
            headers={"Retry-After": str(int(window.total_seconds() // 6))},
        )


def next_ticket_number(db: Session) -> str:
    row = db.execute(
        pg_insert(SupportCounter).values(name="ticket", last_number=1)
        .on_conflict_do_update(index_elements=["name"], set_={"last_number": SupportCounter.last_number + 1}).returning(SupportCounter.last_number)
    ).one()
    return f"SUP-{row[0]:06d}"


# --- building answers ----------------------------------------------------------------------------------------------------
def _unread_expr(viewer_role: str):
    """The viewer has not opened a message written by the OTHER side."""
    other = SUPER_ADMIN_ROLE if viewer_role == TENANT_ADMIN_ROLE else TENANT_ADMIN_ROLE
    return exists().where(SupportMessage.ticket_id == SupportTicket.id, SupportMessage.sender_role == other, SupportMessage.read_at.is_(None))


def _count_expr():
    return select(func.count()).select_from(SupportMessage).where(SupportMessage.ticket_id == SupportTicket.id).correlate(SupportTicket).scalar_subquery()


def summarize(row, platform: bool) -> TicketSummary:
    ticket, unread, count = row
    return TicketSummary(
        id=ticket.id, ticket_number=ticket.ticket_number, organization_id=ticket.organization_id if platform else None, organization_name=ticket.organization_name,
        requester_name=ticket.requester_name, requester_email=ticket.requester_email if platform else None, subject=ticket.subject, category=ticket.category,
        category_label=CATEGORY_LABELS[ticket.category], priority=ticket.priority, status=ticket.status, status_label=STATUS_LABELS[ticket.status],
        created_at=ticket.created_at, updated_at=ticket.updated_at, last_reply_at=ticket.last_reply_at, last_message_role=ticket.last_message_role,
        resolved_at=ticket.resolved_at, message_count=int(count or 0), unread=bool(unread),
        awaiting_staff=(ticket.last_message_role == TENANT_ADMIN_ROLE and ticket.status in ACTIVE) if platform else None,
    )


def _like(value: str) -> str:
    return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _rows(db: Session, caller_role: str, *filters):
    query = select(SupportTicket, _unread_expr(caller_role).label("unread"), _count_expr().label("n")).where(*filters)
    return query


def list_tickets(
    db: Session, caller: Caller, *, status_filter: Optional[str], category: Optional[str], priority: Optional[str], q: Optional[str],
    unread: Optional[bool], organization_id: Optional[uuid.UUID], limit: int, offset: int,
) -> TicketPage:
    platform = caller.role == SUPER_ADMIN_ROLE
    scope = [] if platform else [SupportTicket.organization_id == caller.organization_id]
    filters = list(scope)
    if platform and organization_id:
        filters.append(SupportTicket.organization_id == organization_id)
    if status_filter:
        filters.append(SupportTicket.status == status_filter)
    if category:
        filters.append(SupportTicket.category == category)
    if priority:
        filters.append(SupportTicket.priority == priority)
    if unread is not None:
        filters.append(_unread_expr(caller.role) if unread else ~_unread_expr(caller.role))
    if q and q.strip():
        pattern = _like(q.strip())
        searchable = [SupportTicket.ticket_number.ilike(pattern, escape="\\"), SupportTicket.subject.ilike(pattern, escape="\\")]
        if platform:
            searchable += [SupportTicket.organization_name.ilike(pattern, escape="\\"), SupportTicket.requester_name.ilike(pattern, escape="\\"), SupportTicket.requester_email.ilike(pattern, escape="\\")]
        filters.append(or_(*searchable))
    total = db.scalar(select(func.count()).select_from(SupportTicket).where(*filters)) or 0
    rows = db.execute(_rows(db, caller.role, *filters).order_by(SupportTicket.last_reply_at.desc(), SupportTicket.id.desc()).limit(limit).offset(offset)).all()
    counts = {s: 0 for s in STATUSES}
    for state, n in db.execute(select(SupportTicket.status, func.count()).where(*scope).group_by(SupportTicket.status)).all():
        counts[state] = n
    unread_total = db.scalar(select(func.count()).select_from(SupportTicket).where(*scope, _unread_expr(caller.role))) or 0
    return TicketPage(items=[summarize(r, platform) for r in rows], total=total, limit=limit, offset=offset, counts=counts, unread=unread_total)


def summary(db: Session, caller: Caller) -> dict:
    platform = caller.role == SUPER_ADMIN_ROLE
    scope = [] if platform else [SupportTicket.organization_id == caller.organization_id]
    unread = db.scalar(select(func.count()).select_from(SupportTicket).where(*scope, _unread_expr(caller.role))) or 0
    open_ = db.scalar(select(func.count()).select_from(SupportTicket).where(*scope, SupportTicket.status.in_(ACTIVE))) or 0
    total = db.scalar(select(func.count()).select_from(SupportTicket).where(*scope)) or 0
    return {"unread": unread, "open": open_, "total": total}


def _get(db: Session, caller: Caller, ticket_id: uuid.UUID, *, lock: bool = False) -> SupportTicket:
    query = select(SupportTicket).where(SupportTicket.id == ticket_id)
    if caller.role != SUPER_ADMIN_ROLE:
        query = query.where(SupportTicket.organization_id == caller.organization_id)  # another tenant's ticket is a plain 404
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    found = db.scalar(query)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ticket not found.")
    return found


def detail(db: Session, caller: Caller, ticket: SupportTicket) -> TicketDetail:
    platform = caller.role == SUPER_ADMIN_ROLE
    row = db.execute(_rows(db, caller.role, SupportTicket.id == ticket.id)).one()
    messages = db.scalars(select(SupportMessage).where(SupportMessage.ticket_id == ticket.id).order_by(SupportMessage.created_at, SupportMessage.id)).all()
    body = summarize(row, platform).model_dump()
    events = notifications = None
    if platform:
        events = [EventResponse(id=e.id, actor_role=e.actor_role, event_type=e.event_type, old_value=e.old_value, new_value=e.new_value, created_at=e.created_at)
                  for e in db.scalars(select(SupportTicketEvent).where(SupportTicketEvent.ticket_id == ticket.id).order_by(SupportTicketEvent.seq))]
        notifications = [
            OutboxResponse(id=o.id, notification_type=o.notification_type, recipient=o.recipient, delivery_status=o.delivery_status, attempts=o.attempts,
                           last_error=o.last_error, next_retry_at=o.next_retry_at, sent_at=o.sent_at, created_at=o.created_at)
            for o in db.scalars(select(SupportEmailOutbox).where(SupportEmailOutbox.ticket_id == ticket.id).order_by(SupportEmailOutbox.created_at, SupportEmailOutbox.id))
        ]
    return TicketDetail(
        **body, messages=[MessageResponse(id=m.id, sender_role=m.sender_role, sender_name=m.sender_name, body=m.message_body, created_at=m.created_at, read=m.read_at is not None) for m in messages],
        can_reply=ticket.status != "closed", events=events, notifications=notifications,
    )


def open_ticket(db: Session, caller: Caller, ticket_id: uuid.UUID) -> TicketDetail:
    """Read a ticket AND mark what the other side wrote as read (the unread indicator clears when you open it)."""
    ticket = _get(db, caller, ticket_id)
    other = SUPER_ADMIN_ROLE if caller.role == TENANT_ADMIN_ROLE else TENANT_ADMIN_ROLE
    result = db.execute(update(SupportMessage).where(SupportMessage.ticket_id == ticket.id, SupportMessage.sender_role == other, SupportMessage.read_at.is_(None)).values(read_at=_now()))
    if result.rowcount:
        db.commit()
    return detail(db, caller, ticket)


# --- writing ------------------------------------------------------------------------------------------------------------
def _event(db: Session, ticket: SupportTicket, caller: Caller, kind: str, old: Optional[str] = None, new: Optional[str] = None) -> None:
    db.add(SupportTicketEvent(ticket_id=ticket.id, actor_user_id=caller.user_id, actor_role=caller.role, event_type=kind, old_value=old, new_value=new))


def _notify(db: Session, ticket: SupportTicket, message: Optional[SupportMessage], kind: str) -> None:
    """The durable email notification record, saved in the SAME transaction as what it announces. Recipients are fixed by the
    server: the configured support address, or this ticket's verified requester address. Never anything a browser sent."""
    recipient = ticket.requester_email if kind == "staff_reply" else support_recipient()
    db.add(SupportEmailOutbox(ticket_id=ticket.id, message_id=message.id if message else None, recipient=recipient, notification_type=kind))


def _set_status(ticket: SupportTicket, new: str) -> None:
    ticket.status = new
    ticket.resolved_at = _now() if new == "resolved" else (None if new in ("open", "in_progress") else ticket.resolved_at)


def create_ticket(db: Session, caller: Caller, payload: TicketCreate, key: str) -> Tuple[TicketDetail, bool]:
    digest = request_hash("create", payload.model_dump())
    try:
        previous = claim_request(db, caller.organization_id, key, digest)  # type: ignore[arg-type]
        if previous is not None:
            db.rollback()
            return detail(db, caller, _get(db, caller, previous.ticket_id)), True  # type: ignore[arg-type]
        enforce_rate_limit(db, caller, "ticket")
        now = _now()
        ticket = SupportTicket(
            organization_id=caller.organization_id, ticket_number=next_ticket_number(db), created_by_user_id=caller.user_id, requester_name=caller.full_name or caller.email,
            requester_email=caller.email, organization_name=caller.organization_name, subject=payload.subject, category=payload.category, priority=payload.priority,
            status="open", created_at=now, updated_at=now, last_reply_at=now, last_message_role=TENANT_ADMIN_ROLE,
        )
        db.add(ticket)
        db.flush()
        message = SupportMessage(ticket_id=ticket.id, sender_user_id=caller.user_id, sender_role=TENANT_ADMIN_ROLE, sender_name=caller.full_name or caller.email, message_body=payload.message, created_at=now)
        db.add(message)
        db.flush()
        _event(db, ticket, caller, "created", None, "open")
        _notify(db, ticket, message, "new_ticket")
        db.execute(update(SupportRequest).where(SupportRequest.scope_id == caller.organization_id, SupportRequest.idempotency_key == key).values(ticket_id=ticket.id, message_id=message.id))
        db.commit()
    except IntegrityError:
        db.rollback()
        raise conflict("That request could not be saved. Please try again.", "conflict")
    except DBAPIError as exc:
        db.rollback()
        raise _refusal(exc)
    except Exception:
        db.rollback()
        raise
    return detail(db, caller, ticket), False


def customer_reply(db: Session, caller: Caller, ticket_id: uuid.UUID, body: str, key: str) -> Tuple[TicketDetail, bool]:
    digest = request_hash("customer_reply", str(ticket_id), body)
    try:
        ticket = _get(db, caller, ticket_id, lock=True)
        previous = claim_request(db, caller.organization_id, key, digest)  # type: ignore[arg-type]
        if previous is not None:
            db.rollback()
            return detail(db, caller, _get(db, caller, ticket_id)), True
        if ticket.status == "closed":
            raise conflict("This ticket is closed. Please open a new ticket for a new request.", "ticket_closed")
        enforce_rate_limit(db, caller, "message")
        now = _now()
        message = SupportMessage(ticket_id=ticket.id, sender_user_id=caller.user_id, sender_role=TENANT_ADMIN_ROLE, sender_name=caller.full_name or caller.email, message_body=body, created_at=now)
        db.add(message)
        db.flush()
        ticket.last_reply_at, ticket.last_message_role, ticket.updated_at = now, TENANT_ADMIN_ROLE, now
        _event(db, ticket, caller, "replied")
        if ticket.status in ("waiting_for_customer", "resolved"):  # the customer answered: the ticket needs the Super Admin's attention again
            old = ticket.status
            _set_status(ticket, "open")
            _event(db, ticket, caller, "status_changed", old, "open")
        _notify(db, ticket, message, "customer_followup")
        db.execute(update(SupportRequest).where(SupportRequest.scope_id == caller.organization_id, SupportRequest.idempotency_key == key).values(ticket_id=ticket.id, message_id=message.id))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError:
        db.rollback()
        raise conflict("That request could not be saved. Please try again.", "conflict")
    except DBAPIError as exc:
        db.rollback()
        raise _refusal(exc)
    return detail(db, caller, ticket), False


def staff_reply(db: Session, caller: Caller, ticket_id: uuid.UUID, body: str, new_status: Optional[str], key: str) -> Tuple[TicketDetail, bool]:
    digest = request_hash("staff_reply", str(ticket_id), body, new_status)
    try:
        ticket = _get(db, caller, ticket_id, lock=True)
        previous = claim_request(db, caller.user_id, key, digest)
        if previous is not None:
            db.rollback()
            return detail(db, caller, _get(db, caller, ticket_id)), True
        if ticket.status == "closed":
            raise conflict("This ticket is closed. Reopen it before replying.", "ticket_closed")
        target = new_status or ("waiting_for_customer" if ticket.status in ACTIVE else ticket.status)
        if target != ticket.status and target not in TRANSITIONS[ticket.status]:
            raise conflict(f"A ticket cannot go from {STATUS_LABELS[ticket.status]} to {STATUS_LABELS[target]}.", "invalid_transition")
        enforce_rate_limit(db, caller, "message")
        now = _now()
        message = SupportMessage(ticket_id=ticket.id, sender_user_id=caller.user_id, sender_role=SUPER_ADMIN_ROLE, sender_name=caller.full_name or "Impex Support", message_body=body, created_at=now)
        db.add(message)
        db.flush()
        ticket.last_reply_at, ticket.last_message_role, ticket.updated_at = now, SUPER_ADMIN_ROLE, now
        _event(db, ticket, caller, "replied")
        if target != ticket.status:
            old = ticket.status
            _set_status(ticket, target)
            _event(db, ticket, caller, "status_changed", old, target)
        _notify(db, ticket, message, "staff_reply")
        db.execute(update(SupportRequest).where(SupportRequest.scope_id == caller.user_id, SupportRequest.idempotency_key == key).values(ticket_id=ticket.id, message_id=message.id))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError:
        db.rollback()
        raise conflict("That request could not be saved. Please try again.", "conflict")
    except DBAPIError as exc:
        db.rollback()
        raise _refusal(exc)
    return detail(db, caller, ticket), False


def update_ticket(db: Session, caller: Caller, ticket_id: uuid.UUID, new_status: Optional[str], new_priority: Optional[str]) -> TicketDetail:
    if new_status is None and new_priority is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Provide a status or a priority to change.")
    try:
        ticket = _get(db, caller, ticket_id, lock=True)
        changed = False
        if new_priority is not None and new_priority != ticket.priority:
            _event(db, ticket, caller, "priority_changed", ticket.priority, new_priority)
            ticket.priority = new_priority
            changed = True
        if new_status is not None and new_status != ticket.status:
            if new_status not in TRANSITIONS[ticket.status]:
                raise conflict(f"A ticket cannot go from {STATUS_LABELS[ticket.status]} to {STATUS_LABELS[new_status]}.", "invalid_transition")
            _event(db, ticket, caller, "status_changed", ticket.status, new_status)
            _set_status(ticket, new_status)
            changed = True
        if changed:
            ticket.updated_at = _now()
            db.commit()
        else:
            db.rollback()
    except HTTPException:
        db.rollback()
        raise
    except DBAPIError as exc:
        db.rollback()
        raise _refusal(exc)
    return detail(db, caller, ticket)


def retry_notification(db: Session, outbox_id: uuid.UUID) -> OutboxResponse:
    """The Super Admin asks for another delivery attempt of a failed (or stuck) notification."""
    row = db.scalar(select(SupportEmailOutbox).where(SupportEmailOutbox.id == outbox_id).with_for_update())
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification not found.")
    if row.delivery_status == "sent":
        db.rollback()
        raise conflict("That notification was already sent.", "already_sent")
    row.delivery_status, row.attempts, row.next_retry_at, row.locked_until = "pending", 0, _now(), None
    db.commit()
    return OutboxResponse(id=row.id, notification_type=row.notification_type, recipient=row.recipient, delivery_status=row.delivery_status, attempts=row.attempts,
                          last_error=row.last_error, next_retry_at=row.next_retry_at, sent_at=row.sent_at, created_at=row.created_at)


def notification_overview(db: Session) -> dict:
    pending = db.scalar(select(func.count()).select_from(SupportEmailOutbox).where(SupportEmailOutbox.delivery_status.in_(("pending", "sending")))) or 0
    failed = db.scalar(select(func.count()).select_from(SupportEmailOutbox).where(SupportEmailOutbox.delivery_status == "failed")) or 0
    return {"support_email_configured": bool(support_recipient()), "pending": pending, "failed": failed}


assert set(TRANSITIONS) == set(STATUSES) and CATEGORIES and PRIORITIES and and_ and List
