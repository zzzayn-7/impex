"""The Finance Service's data: a tenant's chart of accounts, a double-entry journal, expenses, an immutable audit trail and the inbox of
events synchronised from Sales and Purchasing.

Money is NUMERIC(18,4), always read and written as an exact decimal string (never a float). Every journal entry is in ONE currency; nothing here
ever adds amounts of different currencies together or converts between them.

The accounting rules are enforced by the DATABASE as well as by the application (see alembic/versions/0001_finance_foundation.py): a posted
entry cannot be changed or deleted, only a balanced entry (at least two lines, debits equal credits) can be posted, a line is exactly one
debit or one credit, a system account cannot be deleted, deactivated or re-typed, an account that has postings keeps its code and type, and the
audit trail is append-only.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, Optional

from sqlalchemy import BigInteger, Boolean, CheckConstraint, Date, DateTime, ForeignKeyConstraint, Identity, Index, Integer, Numeric, String, Text, UniqueConstraint, Uuid, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.tenancy import TenantOwnedMixin

ACCOUNT_TYPES = ("asset", "liability", "equity", "revenue", "expense")
ENTRY_STATUSES = ("draft", "posted")
ENTRY_SOURCES = ("manual", "expense", "sales", "purchasing", "reversal")
EXPENSE_STATUSES = ("draft", "posted", "reversed")
SYNC_STATUSES = ("pending", "posted", "skipped", "failed")
SYNC_SOURCES = ("sales", "purchasing")


def _in(column: str, values) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _pk() -> Mapped[uuid.UUID]:
    return mapped_column(Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()"))


MONEY = Numeric(18, 4)
NOW = func.now()


class FinanceOrganization(Base):
    """An organization that has started using Finance. Created by its first Finance request (never by a browser-supplied id). The background
    worker synchronises only these, and only events AFTER `activated_at`: earlier history is not back-filled (an opening-balance entry is how
    a business brings it in)."""

    __tablename__ = "finance_organizations"

    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    activated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW)


class Account(TenantOwnedMixin, Base):
    __tablename__ = "accounts"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_accounts_organization_id_id"),
        UniqueConstraint("organization_id", "code", name="uq_accounts_organization_id_code"),
        Index("uq_accounts_organization_id_system_key", "organization_id", "system_key", unique=True, postgresql_where=text("system_key IS NOT NULL")),
        CheckConstraint(_in("account_type", ACCOUNT_TYPES), name="account_type_valid"),
        CheckConstraint("(is_system = (system_key IS NOT NULL))", name="system_has_key"),
        CheckConstraint("code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'", name="code_format"),
        CheckConstraint("length(btrim(name)) > 0", name="name_not_blank"),
    )

    id: Mapped[uuid.UUID] = _pk()
    code: Mapped[str] = mapped_column(String(20), nullable=False)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    account_type: Mapped[str] = mapped_column(String(10), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))
    # A system account is one Finance itself posts to (receivables, revenue, tax payable ...). It cannot be deleted, deactivated or re-typed.
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    system_key: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW, onupdate=NOW)


class JournalEntry(TenantOwnedMixin, Base):
    """One journal entry in one currency. A DRAFT can be edited and discarded; once POSTED it is immutable forever and is corrected only by a
    separate reversing entry (`reverses_entry_id`). Numbers are given at posting, so posted numbers have no gaps."""

    __tablename__ = "journal_entries"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_journal_entries_organization_id_id"),
        UniqueConstraint("organization_id", "entry_number", name="uq_journal_entries_organization_id_entry_number"),
        Index("uq_journal_entries_organization_id_source_key", "organization_id", "source_key", unique=True, postgresql_where=text("source_key IS NOT NULL")),
        Index("uq_journal_entries_organization_id_reverses_entry_id", "organization_id", "reverses_entry_id", unique=True, postgresql_where=text("reverses_entry_id IS NOT NULL")),
        Index("ix_journal_entries_organization_id_entry_date", "organization_id", "entry_date"),
        CheckConstraint(_in("status", ENTRY_STATUSES), name="status_valid"),
        CheckConstraint(_in("source_type", ENTRY_SOURCES), name="source_type_valid"),
        CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name="currency_code_valid"),
        CheckConstraint("status <> 'posted' OR (entry_number IS NOT NULL AND posted_at IS NOT NULL AND total IS NOT NULL AND total > 0)", name="posted_is_complete"),
        CheckConstraint("(reverses_entry_id IS NULL) = (source_type <> 'reversal')", name="reversal_names_its_original"),
        CheckConstraint("length(btrim(description)) > 0", name="description_not_blank"),
        ForeignKeyConstraint(["organization_id", "reverses_entry_id"], ["journal_entries.organization_id", "journal_entries.id"], name="fk_journal_entries_organization_id_journal_entries"),
    )

    id: Mapped[uuid.UUID] = _pk()
    entry_number: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    entry_date: Mapped[date] = mapped_column(Date, nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    reference: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="draft", server_default=text("'draft'"))
    source_type: Mapped[str] = mapped_column(String(12), nullable=False, default="manual", server_default=text("'manual'"))
    # Provenance: which fact in which service this entry records ("invoice-issued:<id>"). Unique per organization: the same fact can never post twice.
    source_key: Mapped[Optional[str]] = mapped_column(String(160), nullable=True)
    source_summary: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)  # e.g. "Invoice INV-000012 issued to Acme Ltd"
    reverses_entry_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    reversal_reason: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    total: Mapped[Optional[Decimal]] = mapped_column(MONEY, nullable=True)  # the debit total (= the credit total), fixed when posted
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)  # NULL: created by the synchronisation, not by a person
    created_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    posted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    posted_by: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    posted_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW, onupdate=NOW)


class JournalLine(TenantOwnedMixin, Base):
    __tablename__ = "journal_lines"
    __table_args__ = (
        UniqueConstraint("entry_id", "line_no", name="uq_journal_lines_entry_id_line_no"),
        CheckConstraint("debit >= 0 AND credit >= 0", name="amounts_not_negative"),
        CheckConstraint("(debit > 0) <> (credit > 0)", name="exactly_one_side"),
        Index("ix_journal_lines_organization_id_account_id", "organization_id", "account_id"),
        ForeignKeyConstraint(["organization_id", "entry_id"], ["journal_entries.organization_id", "journal_entries.id"], name="fk_journal_lines_organization_id_journal_entries", ondelete="CASCADE"),
        ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"], name="fk_journal_lines_organization_id_accounts"),
    )

    id: Mapped[uuid.UUID] = _pk()
    entry_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    line_no: Mapped[int] = mapped_column(Integer, nullable=False)
    account_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    debit: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0, server_default=text("0"))
    credit: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0, server_default=text("0"))
    description: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)


class Expense(TenantOwnedMixin, Base):
    """A business expense. Draft -> posted (a journal entry: debit the expense account, credit the system account 'Accrued expenses payable')
    -> reversed (a reversing entry). Recording an expense does NOT move money and says nothing about a bank: it records that the cost was
    incurred and is owed until it is settled."""

    __tablename__ = "expenses"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_expenses_organization_id_id"),
        UniqueConstraint("organization_id", "number", name="uq_expenses_organization_id_number"),
        Index("ix_expenses_organization_id_expense_date", "organization_id", "expense_date"),
        CheckConstraint(_in("status", EXPENSE_STATUSES), name="status_valid"),
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name="currency_code_valid"),
        CheckConstraint("status = 'draft' OR journal_entry_id IS NOT NULL", name="posted_has_entry"),
        CheckConstraint("status <> 'reversed' OR reversal_entry_id IS NOT NULL", name="reversed_has_entry"),
        CheckConstraint("length(btrim(description)) > 0", name="description_not_blank"),
        ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"], name="fk_expenses_organization_id_accounts"),
        ForeignKeyConstraint(["organization_id", "journal_entry_id"], ["journal_entries.organization_id", "journal_entries.id"], name="fk_expenses_organization_id_journal_entries"),
    )

    id: Mapped[uuid.UUID] = _pk()
    number: Mapped[str] = mapped_column(String(20), nullable=False)
    expense_date: Mapped[date] = mapped_column(Date, nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    reference: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    vendor: Mapped[Optional[str]] = mapped_column(String(150), nullable=True)
    account_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="draft", server_default=text("'draft'"))
    journal_entry_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    reversal_entry_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    created_by_email: Mapped[str] = mapped_column(String(320), nullable=False)
    posted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    posted_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    reversed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    reversed_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    reversal_reason: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW, onupdate=NOW)


class FinanceEvent(Base):
    """The audit trail: who did what, to what, when, and whether a person or the synchronisation did it. Append-only (a trigger refuses
    UPDATE and DELETE). Holds short, non-secret descriptions only."""

    __tablename__ = "finance_events"
    __table_args__ = (
        CheckConstraint("entity_type IN ('account', 'journal_entry', 'expense', 'sync')", name="entity_type_valid"),
        CheckConstraint("source IN ('user', 'sync')", name="source_valid"),
        Index("ix_finance_events_organization_id_seq", "organization_id", "seq"),
        Index("ix_finance_events_organization_id_entity_id", "organization_id", "entity_id"),
    )

    id: Mapped[uuid.UUID] = _pk()
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), nullable=False)
    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    entity_type: Mapped[str] = mapped_column(String(15), nullable=False)
    entity_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    action: Mapped[str] = mapped_column(String(40), nullable=False)
    actor_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    actor_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    source: Mapped[str] = mapped_column(String(10), nullable=False, default="user", server_default=text("'user'"))
    detail: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW)


class FinanceRequest(Base):
    """Idempotency: the same Idempotency-Key from the same organization returns the first result instead of doing the work again."""

    __tablename__ = "finance_requests"
    __table_args__ = (UniqueConstraint("organization_id", "idempotency_key", name="uq_finance_requests_organization_id_idempotency_key"),)

    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(100), nullable=False)
    scope: Mapped[str] = mapped_column(String(30), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW)


class FinanceCounter(Base):
    __tablename__ = "finance_counters"

    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    name: Mapped[str] = mapped_column(String(20), primary_key=True)
    last_number: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))


class SyncSource(Base):
    """Where the synchronisation from Sales / Purchasing stands for one organization, and whether it is healthy."""

    __tablename__ = "sync_sources"
    __table_args__ = (CheckConstraint("source IN ('sales', 'purchasing')", name="source_valid"), CheckConstraint("status IN ('idle', 'ok', 'error')", name="status_valid"))

    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    source: Mapped[str] = mapped_column(String(12), primary_key=True)
    cursor_time: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)  # the newest event time read (the next read starts a little before it)
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="idle", server_default=text("'idle'"))
    last_attempt_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_success_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    consecutive_failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))


class SyncEvent(Base):
    """A financial fact received from Sales or Purchasing, kept until it is posted. `event_key` is unique per organization: reading the same fact again
    (a retry, an overlapping read, a restart) can never create a second row, and so never a second posting."""

    __tablename__ = "sync_events"
    __table_args__ = (
        UniqueConstraint("organization_id", "event_key", name="uq_sync_events_organization_id_event_key"),
        CheckConstraint(_in("status", SYNC_STATUSES), name="status_valid"),
        CheckConstraint(_in("source", SYNC_SOURCES), name="source_valid"),
        CheckConstraint("attempts >= 0", name="attempts_non_negative"),
        Index("ix_sync_events_due", "status", "next_retry_at"),
        Index("ix_sync_events_organization_id_event_time", "organization_id", "event_time"),
    )

    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    source: Mapped[str] = mapped_column(String(12), nullable=False)
    event_key: Mapped[str] = mapped_column(String(160), nullable=False)
    event_type: Mapped[str] = mapped_column(String(30), nullable=False)
    event_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    payload: Mapped[Dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="pending", server_default=text("'pending'"))
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    next_retry_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW)
    last_error: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    journal_entry_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    processed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW)
