"""Request and response models. Every write model forbids unknown fields: an `organization_id`, `status`, `recipient`,
`sender_role` or any other value the caller must not decide is refused with 422, never silently ignored."""
import re
import unicodedata
import uuid
from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, field_validator

from app.models import CATEGORIES, PRIORITIES, STATUSES

Category = Literal["technical_issue", "change_request", "account_organization", "billing_subscription", "general_inquiry"]
Priority = Literal["low", "normal", "high", "urgent"]
Status = Literal["open", "in_progress", "waiting_for_customer", "resolved", "closed"]

CATEGORY_LABELS = {
    "technical_issue": "Technical Issue", "change_request": "Change Request", "account_organization": "Account & Organization",
    "billing_subscription": "Billing & Subscription", "general_inquiry": "General Inquiry",
}
STATUS_LABELS = {"open": "Open", "in_progress": "In Progress", "waiting_for_customer": "Waiting for Customer", "resolved": "Resolved", "closed": "Closed"}

SUBJECT_MIN, SUBJECT_MAX, BODY_MAX = 3, 150, 5000
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f  ‪-‮⁦-⁩﻿]")


def clean_subject(value: object) -> str:
    """One line, no control or bidi characters (this ends up in an email header too), 3-150 characters."""
    if not isinstance(value, str):
        raise ValueError("Enter a subject.")
    subject = " ".join(_CONTROL.sub(" ", unicodedata.normalize("NFC", value)).split())
    if len(subject) < SUBJECT_MIN or len(subject) > SUBJECT_MAX:
        raise ValueError(f"The subject must be {SUBJECT_MIN} to {SUBJECT_MAX} characters.")
    return subject


def clean_body(value: object) -> str:
    """The message as plain text: line breaks kept, control and bidi characters removed, 1-5000 characters.
    HTML is NOT stripped (a customer may paste code or markup): it is stored as text and always escaped when shown or emailed."""
    if not isinstance(value, str):
        raise ValueError("Write your message.")
    text = _CONTROL.sub("", unicodedata.normalize("NFC", value).replace("\r\n", "\n").replace("\r", "\n")).strip()
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    if not text:
        raise ValueError("Write your message.")
    if len(text) > BODY_MAX:
        raise ValueError(f"The message must be {BODY_MAX} characters or fewer.")
    return text


class TicketCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    subject: str
    category: Category
    priority: Priority = "normal"
    message: str

    @field_validator("subject")
    @classmethod
    def _subject(cls, value: str) -> str:
        return clean_subject(value)

    @field_validator("message")
    @classmethod
    def _message(cls, value: str) -> str:
        return clean_body(value)


class MessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: str

    @field_validator("body")
    @classmethod
    def _body(cls, value: str) -> str:
        return clean_body(value)


class StaffReply(MessageCreate):
    # Optionally move the ticket along with the reply (checked against the allowed transitions). Default: Waiting for Customer.
    status: Optional[Status] = None


class TicketUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Optional[Status] = None
    priority: Optional[Priority] = None


class MessageResponse(BaseModel):
    id: uuid.UUID
    sender_role: str
    sender_name: str
    body: str
    created_at: datetime
    read: bool  # has the other side seen it


class EventResponse(BaseModel):
    id: uuid.UUID
    actor_role: str
    event_type: str
    old_value: Optional[str]
    new_value: Optional[str]
    created_at: datetime


class OutboxResponse(BaseModel):
    id: uuid.UUID
    notification_type: str
    recipient: str
    delivery_status: str
    attempts: int
    last_error: Optional[str]
    next_retry_at: datetime
    sent_at: Optional[datetime]
    created_at: datetime


class TicketSummary(BaseModel):
    id: uuid.UUID
    ticket_number: str
    organization_id: Optional[uuid.UUID] = None  # shown to the Super Admin only
    organization_name: str
    requester_name: str
    requester_email: Optional[str] = None  # shown to the Super Admin only
    subject: str
    category: str
    category_label: str
    priority: str
    status: str
    status_label: str
    created_at: datetime
    updated_at: datetime
    last_reply_at: datetime
    last_message_role: str
    resolved_at: Optional[datetime]
    message_count: int
    unread: bool  # for the caller: the other side wrote something they have not opened yet
    awaiting_staff: Optional[bool] = None  # Super Admin only: the customer wrote last and the ticket is still active


class TicketDetail(TicketSummary):
    messages: List[MessageResponse]
    can_reply: bool
    events: Optional[List[EventResponse]] = None  # Super Admin only
    notifications: Optional[List[OutboxResponse]] = None  # Super Admin only: the email notification records and their delivery state


class TicketPage(BaseModel):
    items: List[TicketSummary]
    total: int
    limit: int
    offset: int
    counts: dict  # per status (all of the caller's tickets, ignoring the current filters)
    unread: int


class Summary(BaseModel):
    unread: int
    open: int
    total: int


class NotificationSettings(BaseModel):
    """Visible to the Super Admin: is the support address configured, and how many emails are waiting or failed."""

    support_email_configured: bool
    pending: int
    failed: int


assert set(CATEGORIES) == set(CATEGORY_LABELS) and set(STATUSES) == set(STATUS_LABELS) and PRIORITIES
