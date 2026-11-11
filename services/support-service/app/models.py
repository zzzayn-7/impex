"""Support tickets and their conversation.

Rules the DATABASE keeps by itself (see alembic/versions/0001_support_tickets.py), on top of the application's:
  * a ticket or a message is never deleted, and a message is never edited (only its read time is set, once);
  * a ticket's identity (id, organization, number, creator) never changes;
  * a ticket's status moves only along the documented transitions;
  * the audit trail of events is append-only.
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Identity, Index, Integer, String, Text, UniqueConstraint, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

CATEGORIES = ("technical_issue", "change_request", "account_organization", "billing_subscription", "general_inquiry")
PRIORITIES = ("low", "normal", "high", "urgent")
STATUSES = ("open", "in_progress", "waiting_for_customer", "resolved", "closed")
ROLES = ("organization-admin", "super-admin")
NOTIFICATION_TYPES = ("new_ticket", "customer_followup", "staff_reply")
DELIVERY_STATUSES = ("pending", "sending", "sent", "failed")
EVENT_TYPES = ("created", "replied", "status_changed", "priority_changed")


def _in(column: str, values) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class SupportTicket(Base):
    __tablename__ = "support_tickets"
    __table_args__ = (
        UniqueConstraint("ticket_number", name="uq_support_tickets_ticket_number"),
        CheckConstraint(_in("category", CATEGORIES), name="category_valid"),
        CheckConstraint(_in("priority", PRIORITIES), name="priority_valid"),
        CheckConstraint(_in("status", STATUSES), name="status_valid"),
        CheckConstraint("status <> 'resolved' OR resolved_at IS NOT NULL", name="resolved_has_a_time"),
        CheckConstraint("char_length(subject) BETWEEN 3 AND 150", name="subject_length"),
        Index("ix_support_tickets_organization_id_created_at", "organization_id", "created_at"),
        Index("ix_support_tickets_status_last_reply_at", "status", "last_reply_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()"))
    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)  # from the verified token, never from the request
    ticket_number: Mapped[str] = mapped_column(String(20), nullable=False)  # SUP-000001
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    # Snapshots taken from the verified identity when the ticket is created: the ticket stays readable if they change later.
    requester_name: Mapped[str] = mapped_column(String(255), nullable=False)
    requester_email: Mapped[str] = mapped_column(String(320), nullable=False)
    organization_name: Mapped[str] = mapped_column(String(255), nullable=False)
    subject: Mapped[str] = mapped_column(String(150), nullable=False)
    category: Mapped[str] = mapped_column(String(30), nullable=False)
    priority: Mapped[str] = mapped_column(String(10), nullable=False, default="normal", server_default=text("'normal'"))
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="open", server_default=text("'open'"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    last_reply_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())  # latest message by anyone
    last_message_role: Mapped[str] = mapped_column(String(20), nullable=False, default="organization-admin", server_default=text("'organization-admin'"))
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    # The requesting organization deleted the ticket from ITS list (the ticket itself is kept; the Super Admin still sees it).
    hidden_by_organization_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class SupportMessage(Base):
    __tablename__ = "support_messages"
    __table_args__ = (
        CheckConstraint(_in("sender_role", ROLES), name="sender_role_valid"),
        CheckConstraint("char_length(message_body) BETWEEN 1 AND 5000", name="body_length"),
        Index("ix_support_messages_ticket_id_created_at", "ticket_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()"))
    ticket_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("support_tickets.id", ondelete="RESTRICT"), nullable=False)
    sender_user_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    sender_role: Mapped[str] = mapped_column(String(20), nullable=False)
    sender_name: Mapped[str] = mapped_column(String(255), nullable=False)
    message_body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    # Set when the OTHER side has opened the ticket (the requester for a staff reply, the platform for a customer message).
    read_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class SupportTicketEvent(Base):
    """The audit trail: who did what to a ticket, and when. Append-only."""

    __tablename__ = "support_ticket_events"
    __table_args__ = (
        CheckConstraint(_in("event_type", EVENT_TYPES), name="event_type_valid"),
        Index("ix_support_ticket_events_ticket_id_created_at", "ticket_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()"))
    # A definite order: events written in one transaction share the same created_at, so the sequence decides.
    seq: Mapped[int] = mapped_column(BigInteger, Identity(), nullable=False)
    ticket_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("support_tickets.id", ondelete="RESTRICT"), nullable=False)
    actor_user_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    actor_role: Mapped[str] = mapped_column(String(20), nullable=False)
    event_type: Mapped[str] = mapped_column(String(20), nullable=False)
    old_value: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    new_value: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class SupportEmailOutbox(Base):
    """A durable email notification. The ticket and the notification are saved in ONE transaction; sending happens later, from
    a worker, with retries. Email is a notification, never the record of the conversation."""

    __tablename__ = "support_email_outbox"
    __table_args__ = (
        CheckConstraint(_in("notification_type", NOTIFICATION_TYPES), name="notification_type_valid"),
        CheckConstraint(_in("delivery_status", DELIVERY_STATUSES), name="delivery_status_valid"),
        CheckConstraint("attempts >= 0", name="attempts_non_negative"),
        Index("ix_support_email_outbox_due", "delivery_status", "next_retry_at"),
        Index("ix_support_email_outbox_ticket_id", "ticket_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()"))
    ticket_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("support_tickets.id", ondelete="RESTRICT"), nullable=False)
    message_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, ForeignKey("support_messages.id", ondelete="RESTRICT"), nullable=True)
    # Fixed by the server, never by a browser: the configured support address, or the ticket's verified requester address.
    recipient: Mapped[str] = mapped_column(String(320), nullable=False, default="", server_default=text("''"))
    notification_type: Mapped[str] = mapped_column(String(20), nullable=False)
    delivery_status: Mapped[str] = mapped_column(String(10), nullable=False, default="pending", server_default=text("'pending'"))
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # a short, credential-free reason
    next_retry_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    locked_until: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)  # a worker's lease while sending
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class SupportCounter(Base):
    """Gapless ticket numbers: one row, incremented inside the ticket's own transaction."""

    __tablename__ = "support_counters"

    name: Mapped[str] = mapped_column(String(30), primary_key=True)
    last_number: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))


class SupportRequest(Base):
    """Idempotency: the same Idempotency-Key from the same caller scope returns the first result instead of creating a second."""

    __tablename__ = "support_requests"
    __table_args__ = (UniqueConstraint("scope_id", "idempotency_key", name="uq_support_requests_scope_id_idempotency_key"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()"))
    scope_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)  # the organization (tenant calls) or the Super Admin's user id
    idempotency_key: Mapped[str] = mapped_column(String(100), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    ticket_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, ForeignKey("support_tickets.id", ondelete="RESTRICT"), nullable=True)
    message_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, ForeignKey("support_messages.id", ondelete="RESTRICT"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
