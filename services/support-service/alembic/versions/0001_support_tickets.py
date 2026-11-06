"""support tickets, messages, audit events, durable email outbox

Revision ID: 0001
Revises:
Create Date: 2026-11-07
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CATEGORIES = ("technical_issue", "change_request", "account_organization", "billing_subscription", "general_inquiry")
PRIORITIES = ("low", "normal", "high", "urgent")
STATUSES = ("open", "in_progress", "waiting_for_customer", "resolved", "closed")
ROLES = ("organization-admin", "super-admin")
NOTIFICATION_TYPES = ("new_ticket", "customer_followup", "staff_reply")
DELIVERY_STATUSES = ("pending", "sending", "sent", "failed")
EVENT_TYPES = ("created", "replied", "status_changed", "priority_changed")


def _in(column: str, values) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


TIMESTAMP = dict(type_=sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)


def _id():
    return sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False)


# Deletes are refused unless the maintenance switch is on (an out-of-band switch the application never sets; the live verification
# scripts use it to clean up their own throwaway rows by exact id).
TICKETS_GUARD = """
CREATE FUNCTION support_tickets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'support tickets are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.ticket_number, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.ticket_number, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'the identity of a support ticket can never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'open'                 AND NEW.status IN ('in_progress', 'waiting_for_customer', 'resolved', 'closed'))
    OR (OLD.status = 'in_progress'          AND NEW.status IN ('open', 'waiting_for_customer', 'resolved', 'closed'))
    OR (OLD.status = 'waiting_for_customer' AND NEW.status IN ('open', 'in_progress', 'resolved', 'closed'))
    OR (OLD.status = 'resolved'             AND NEW.status IN ('open', 'in_progress', 'closed'))
    OR (OLD.status = 'closed'               AND NEW.status = 'open')
  ) THEN
    RAISE EXCEPTION 'a ticket cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$
"""

MESSAGES_GUARD = """
CREATE FUNCTION support_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'support messages are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- A message is never edited. The only change allowed is the one-time "the other side has read it".
  IF OLD.read_at IS NOT NULL
     OR (NEW.id, NEW.ticket_id, NEW.sender_user_id, NEW.sender_role, NEW.sender_name, NEW.message_body, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.ticket_id, OLD.sender_user_id, OLD.sender_role, OLD.sender_name, OLD.message_body, OLD.created_at) THEN
    RAISE EXCEPTION 'a support message cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$
"""

APPEND_ONLY = """
CREATE FUNCTION support_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END
$$
"""

OUTBOX_GUARD = """
CREATE FUNCTION support_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'email notification records are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.id, NEW.ticket_id, NEW.message_id, NEW.notification_type, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.ticket_id, OLD.message_id, OLD.notification_type, OLD.created_at) THEN
    RAISE EXCEPTION 'what a notification is about can never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$
"""


def upgrade() -> None:
    op.create_table(
        "support_counters",
        sa.Column("name", sa.String(length=30), nullable=False),
        sa.Column("last_number", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.PrimaryKeyConstraint("name", name=op.f("pk_support_counters")),
    )

    op.create_table(
        "support_tickets",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("ticket_number", sa.String(length=20), nullable=False),
        sa.Column("created_by_user_id", sa.Uuid(), nullable=False),
        sa.Column("requester_name", sa.String(length=255), nullable=False),
        sa.Column("requester_email", sa.String(length=320), nullable=False),
        sa.Column("organization_name", sa.String(length=255), nullable=False),
        sa.Column("subject", sa.String(length=150), nullable=False),
        sa.Column("category", sa.String(length=30), nullable=False),
        sa.Column("priority", sa.String(length=10), server_default=sa.text("'normal'"), nullable=False),
        sa.Column("status", sa.String(length=30), server_default=sa.text("'open'"), nullable=False),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("updated_at", **TIMESTAMP),
        sa.Column("last_reply_at", **TIMESTAMP),
        sa.Column("last_message_role", sa.String(length=20), server_default=sa.text("'organization-admin'"), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(_in("category", CATEGORIES), name=op.f("ck_support_tickets_category_valid")),
        sa.CheckConstraint(_in("priority", PRIORITIES), name=op.f("ck_support_tickets_priority_valid")),
        sa.CheckConstraint(_in("status", STATUSES), name=op.f("ck_support_tickets_status_valid")),
        sa.CheckConstraint("status <> 'resolved' OR resolved_at IS NOT NULL", name=op.f("ck_support_tickets_resolved_has_a_time")),
        sa.CheckConstraint("char_length(subject) BETWEEN 3 AND 150", name=op.f("ck_support_tickets_subject_length")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_support_tickets")),
        sa.UniqueConstraint("ticket_number", name="uq_support_tickets_ticket_number"),
    )
    op.create_index(op.f("ix_support_tickets_organization_id"), "support_tickets", ["organization_id"], unique=False)
    op.create_index("ix_support_tickets_organization_id_created_at", "support_tickets", ["organization_id", "created_at"], unique=False)
    op.create_index("ix_support_tickets_status_last_reply_at", "support_tickets", ["status", "last_reply_at"], unique=False)

    op.create_table(
        "support_messages",
        _id(),
        sa.Column("ticket_id", sa.Uuid(), nullable=False),
        sa.Column("sender_user_id", sa.Uuid(), nullable=False),
        sa.Column("sender_role", sa.String(length=20), nullable=False),
        sa.Column("sender_name", sa.String(length=255), nullable=False),
        sa.Column("message_body", sa.Text(), nullable=False),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(_in("sender_role", ROLES), name=op.f("ck_support_messages_sender_role_valid")),
        sa.CheckConstraint("char_length(message_body) BETWEEN 1 AND 5000", name=op.f("ck_support_messages_body_length")),
        sa.ForeignKeyConstraint(["ticket_id"], ["support_tickets.id"], name=op.f("fk_support_messages_ticket_id_support_tickets"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_support_messages")),
    )
    op.create_index("ix_support_messages_ticket_id_created_at", "support_messages", ["ticket_id", "created_at"], unique=False)

    op.create_table(
        "support_ticket_events",
        _id(),
        sa.Column("seq", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("ticket_id", sa.Uuid(), nullable=False),
        sa.Column("actor_user_id", sa.Uuid(), nullable=False),
        sa.Column("actor_role", sa.String(length=20), nullable=False),
        sa.Column("event_type", sa.String(length=20), nullable=False),
        sa.Column("old_value", sa.String(length=50), nullable=True),
        sa.Column("new_value", sa.String(length=50), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.CheckConstraint(_in("event_type", EVENT_TYPES), name=op.f("ck_support_ticket_events_event_type_valid")),
        sa.ForeignKeyConstraint(["ticket_id"], ["support_tickets.id"], name=op.f("fk_support_ticket_events_ticket_id_support_tickets"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_support_ticket_events")),
    )
    op.create_index("ix_support_ticket_events_ticket_id_created_at", "support_ticket_events", ["ticket_id", "created_at"], unique=False)

    op.create_table(
        "support_email_outbox",
        _id(),
        sa.Column("ticket_id", sa.Uuid(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=True),
        sa.Column("recipient", sa.String(length=320), server_default=sa.text("''"), nullable=False),
        sa.Column("notification_type", sa.String(length=20), nullable=False),
        sa.Column("delivery_status", sa.String(length=10), server_default=sa.text("'pending'"), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("next_retry_at", **TIMESTAMP),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.CheckConstraint(_in("notification_type", NOTIFICATION_TYPES), name=op.f("ck_support_email_outbox_notification_type_valid")),
        sa.CheckConstraint(_in("delivery_status", DELIVERY_STATUSES), name=op.f("ck_support_email_outbox_delivery_status_valid")),
        sa.CheckConstraint("attempts >= 0", name=op.f("ck_support_email_outbox_attempts_non_negative")),
        sa.ForeignKeyConstraint(["ticket_id"], ["support_tickets.id"], name=op.f("fk_support_email_outbox_ticket_id_support_tickets"), ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["message_id"], ["support_messages.id"], name=op.f("fk_support_email_outbox_message_id_support_messages"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_support_email_outbox")),
    )
    op.create_index("ix_support_email_outbox_due", "support_email_outbox", ["delivery_status", "next_retry_at"], unique=False)
    op.create_index("ix_support_email_outbox_ticket_id", "support_email_outbox", ["ticket_id"], unique=False)

    op.create_table(
        "support_requests",
        _id(),
        sa.Column("scope_id", sa.Uuid(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=100), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("ticket_id", sa.Uuid(), nullable=True),
        sa.Column("message_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.ForeignKeyConstraint(["ticket_id"], ["support_tickets.id"], name=op.f("fk_support_requests_ticket_id_support_tickets"), ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["message_id"], ["support_messages.id"], name=op.f("fk_support_requests_message_id_support_messages"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_support_requests")),
        sa.UniqueConstraint("scope_id", "idempotency_key", name="uq_support_requests_scope_id_idempotency_key"),
    )

    op.execute(TICKETS_GUARD)
    op.execute("CREATE TRIGGER trg_support_tickets_guard BEFORE UPDATE OR DELETE ON support_tickets FOR EACH ROW EXECUTE FUNCTION support_tickets_guard()")
    op.execute(MESSAGES_GUARD)
    op.execute("CREATE TRIGGER trg_support_messages_guard BEFORE UPDATE OR DELETE ON support_messages FOR EACH ROW EXECUTE FUNCTION support_messages_guard()")
    op.execute(APPEND_ONLY)
    op.execute("CREATE TRIGGER trg_support_ticket_events_guard BEFORE UPDATE OR DELETE ON support_ticket_events FOR EACH ROW EXECUTE FUNCTION support_append_only_guard()")
    op.execute(OUTBOX_GUARD)
    op.execute("CREATE TRIGGER trg_support_email_outbox_guard BEFORE UPDATE OR DELETE ON support_email_outbox FOR EACH ROW EXECUTE FUNCTION support_outbox_guard()")


def downgrade() -> None:
    for trigger, table in (
        ("trg_support_email_outbox_guard", "support_email_outbox"), ("trg_support_ticket_events_guard", "support_ticket_events"),
        ("trg_support_messages_guard", "support_messages"), ("trg_support_tickets_guard", "support_tickets"),
    ):
        op.execute(f"DROP TRIGGER {trigger} ON {table}")
    for function in ("support_outbox_guard", "support_append_only_guard", "support_messages_guard", "support_tickets_guard"):
        op.execute(f"DROP FUNCTION {function}()")
    for table in ("support_requests", "support_email_outbox", "support_ticket_events", "support_messages", "support_tickets", "support_counters"):
        op.drop_table(table)
