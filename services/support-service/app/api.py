"""Support API. Two routers that cannot be mixed up:

  /api/v1/support/...        organization administrators (their own organization's tickets only)
  /api/v1/support/admin/...  Super Admins (every organization's tickets)

No route accepts an organization id, a user id, a sender role, a recipient or a ticket number as input.
"""
import re
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app import tickets
from app.auth import Caller, require_super_admin, require_tenant
from app.database import get_db
from app.schemas import MessageCreate, NotificationSettings, OutboxResponse, StaffReply, Summary, TicketCreate, TicketDetail, TicketPage, TicketUpdate

router = APIRouter(prefix="/api/v1/support", tags=["Support"])
admin = APIRouter(prefix="/api/v1/support/admin", tags=["Support (Super Admin)"])

IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,100}$")
StatusFilter = Literal["open", "in_progress", "waiting_for_customer", "resolved", "closed"]
CategoryFilter = Literal["technical_issue", "change_request", "account_organization", "billing_subscription", "general_inquiry"]
PriorityFilter = Literal["low", "normal", "high", "urgent"]


def idempotency_key(key: Optional[str] = Header(default=None, alias="Idempotency-Key")) -> str:
    key = (key or "").strip()
    if not key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The Idempotency-Key header is required.")
    if not IDEMPOTENCY_KEY_RE.match(key):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key must be 8-100 characters: letters, digits and . _ : -")
    return key


# =====================================================================================================
# organization administrators
# =====================================================================================================
@router.post("/tickets", response_model=TicketDetail, status_code=status.HTTP_201_CREATED)
def create_ticket(payload: TicketCreate, response: Response, caller: Caller = Depends(require_tenant), key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Open a ticket. It is saved with its first message and its email notification record in ONE transaction. A retry with the same
    Idempotency-Key answers 200 with the same ticket. Nothing here changes any organization setting: a Change Request is only a request."""
    result, replayed = tickets.create_ticket(db, caller, payload, key)
    response.status_code = status.HTTP_200_OK if replayed else status.HTTP_201_CREATED
    return result


@router.get("/tickets", response_model=TicketPage)
def list_my_tickets(
    status_filter: Optional[StatusFilter] = Query(default=None, alias="status"), category: Optional[CategoryFilter] = None, q: Optional[str] = Query(default=None, max_length=100),
    unread: Optional[bool] = None, limit: int = Query(default=25, ge=1, le=100), offset: int = Query(default=0, ge=0),
    caller: Caller = Depends(require_tenant), db: Session = Depends(get_db),
):
    return tickets.list_tickets(db, caller, status_filter=status_filter, category=category, priority=None, q=q, unread=unread, organization_id=None, limit=limit, offset=offset)


@router.get("/summary", response_model=Summary)
def my_summary(caller: Caller = Depends(require_tenant), db: Session = Depends(get_db)):
    return tickets.summary(db, caller)


@router.get("/tickets/{ticket_id}", response_model=TicketDetail)
def open_my_ticket(ticket_id: uuid.UUID, caller: Caller = Depends(require_tenant), db: Session = Depends(get_db)):
    """The conversation. Opening it marks the Super Admin's replies as read."""
    return tickets.open_ticket(db, caller, ticket_id)


@router.post("/tickets/{ticket_id}/hide", status_code=status.HTTP_204_NO_CONTENT)
def delete_from_my_side(ticket_id: uuid.UUID, caller: Caller = Depends(require_tenant), db: Session = Depends(get_db)):
    """Delete a ticket from YOUR list. It is not unsent: the Super Admin still has it, and nothing is erased."""
    tickets.hide_ticket(db, caller, ticket_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/tickets/{ticket_id}/messages", response_model=TicketDetail, status_code=status.HTTP_201_CREATED)
def follow_up(ticket_id: uuid.UUID, payload: MessageCreate, response: Response, caller: Caller = Depends(require_tenant), key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Add a message to your ticket. A ticket waiting for you (or resolved) goes back to Open; a closed ticket takes no more messages."""
    result, replayed = tickets.customer_reply(db, caller, ticket_id, payload.body, key)
    response.status_code = status.HTTP_200_OK if replayed else status.HTTP_201_CREATED
    return result


# =====================================================================================================
# Super Admin
# =====================================================================================================
@admin.get("/tickets", response_model=TicketPage)
def inbox(
    status_filter: Optional[StatusFilter] = Query(default=None, alias="status"), category: Optional[CategoryFilter] = None, priority: Optional[PriorityFilter] = None,
    organization_id: Optional[uuid.UUID] = None, q: Optional[str] = Query(default=None, max_length=100), unread: Optional[bool] = None,
    limit: int = Query(default=25, ge=1, le=100), offset: int = Query(default=0, ge=0),
    caller: Caller = Depends(require_super_admin), db: Session = Depends(get_db),
):
    """Tickets of every organization, newest activity first."""
    return tickets.list_tickets(db, caller, status_filter=status_filter, category=category, priority=priority, q=q, unread=unread, organization_id=organization_id, limit=limit, offset=offset)


@admin.get("/summary", response_model=Summary)
def inbox_summary(caller: Caller = Depends(require_super_admin), db: Session = Depends(get_db)):
    return tickets.summary(db, caller)


@admin.get("/notifications", response_model=NotificationSettings)
def notification_overview(caller: Caller = Depends(require_super_admin), db: Session = Depends(get_db)):
    """Is the support address configured, and how many notification emails are waiting or have failed."""
    return tickets.notification_overview(db)


@admin.get("/tickets/{ticket_id}", response_model=TicketDetail)
def open_ticket(ticket_id: uuid.UUID, caller: Caller = Depends(require_super_admin), db: Session = Depends(get_db)):
    """The conversation, the audit trail and the email notification records. Opening it marks the customer's messages as read."""
    return tickets.open_ticket(db, caller, ticket_id)


@admin.post("/tickets/{ticket_id}/messages", response_model=TicketDetail, status_code=status.HTTP_201_CREATED)
def reply(ticket_id: uuid.UUID, payload: StaffReply, response: Response, caller: Caller = Depends(require_super_admin), key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Reply from the portal. Saved first; the requester's email notification is recorded in the same transaction and sent afterwards."""
    result, replayed = tickets.staff_reply(db, caller, ticket_id, payload.body, payload.status, key)
    response.status_code = status.HTTP_200_OK if replayed else status.HTTP_201_CREATED
    return result


@admin.patch("/tickets/{ticket_id}", response_model=TicketDetail)
def update_ticket(ticket_id: uuid.UUID, payload: TicketUpdate, caller: Caller = Depends(require_super_admin), db: Session = Depends(get_db)):
    """Change the status and/or the priority. Only the documented status moves are allowed; every change is recorded."""
    return tickets.update_ticket(db, caller, ticket_id, payload.status, payload.priority)


@admin.post("/notifications/{outbox_id}/retry", response_model=OutboxResponse)
def retry_notification(outbox_id: uuid.UUID, caller: Caller = Depends(require_super_admin), db: Session = Depends(get_db)):
    """Another delivery attempt for a failed notification (the worker picks it up within seconds)."""
    return tickets.retry_notification(db, outbox_id)
