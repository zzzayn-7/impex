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
        CheckConstraint("entity_type IN ('account', 'journal_entry', 'expense', 'sync', 'capital_record', 'opening', 'delivery', 'cost_basis')", name="entity_type_valid"),
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


# =====================================================================================================
# Capital, Investment and Profit & Loss (Step 24). ADDITIVE: nothing above is changed, the ledger stays exactly as it was.
#
# These tables are the Finance Service's reporting model. Each row records ONE fact exactly once (a unique `source_key` / Idempotency-Key), in ONE
# currency; nothing here converts between currencies. See docs/finance.md ("Capital, Investment and Profit & Loss").
# =====================================================================================================
COST_ENTRY_KINDS = ("basis", "receipt", "delivery")
DELIVERY_STATUSES = ("recognized", "needs_cost", "needs_price")
ADJUSTMENT_KINDS = ("invoice_adjustment", "invoice_adjustment_reversal")
CAPITAL_KINDS = ("contribution", "withdrawal")
CAPITAL_TYPES = ("cash", "asset", "inventory")
POSITION_STATUSES = ("active", "reversed")


class InventoryCost(Base):
    """What the stock of ONE product, in ONE currency, cost: the running quantity and VALUE (weighted-average method). A delivery takes its cost from here
    (value x quantity delivered / quantity on hand), so the cost of goods sold is the ACTUAL historical cost - never the product's editable cost-price field."""

    __tablename__ = "inventory_costs"
    __table_args__ = (
        CheckConstraint("quantity >= 0 AND total_value >= 0", name="not_negative"),
        CheckConstraint("quantity > 0 OR total_value = 0", name="empty_stock_has_no_value"),
        CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name="currency_code_valid"),
    )

    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    product_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    currency_code: Mapped[str] = mapped_column(String(3), primary_key=True)
    product_sku: Mapped[str] = mapped_column(String(64), nullable=False)
    product_name: Mapped[str] = mapped_column(String(255), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0, server_default=text("0"))
    total_value: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0, server_default=text("0"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW, onupdate=NOW)


class CostEntry(TenantOwnedMixin, Base):
    """Every movement of a product's cost, append-only: a goods receipt adds quantity at its actual price ('receipt'), the person adds the cost of stock
    already held ('basis'), a delivery takes quantity out at the weighted-average cost ('delivery'). The history of how every cost came to be."""

    __tablename__ = "cost_entries"
    __table_args__ = (
        UniqueConstraint("organization_id", "source_key", name="uq_cost_entries_organization_id_source_key"),
        Index("ix_cost_entries_organization_id_effective_at", "organization_id", "effective_at"),
        Index("ix_cost_entries_organization_id_product_id", "organization_id", "product_id"),
        CheckConstraint(_in("kind", COST_ENTRY_KINDS), name="kind_valid"),
        CheckConstraint("quantity > 0 AND value >= 0", name="amounts_valid"),
        CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name="currency_code_valid"),
    )

    id: Mapped[uuid.UUID] = _pk()
    source_key: Mapped[str] = mapped_column(String(160), nullable=False)
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    product_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    product_sku: Mapped[str] = mapped_column(String(64), nullable=False)
    product_name: Mapped[str] = mapped_column(String(255), nullable=False)
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    value: Mapped[Decimal] = mapped_column(MONEY, nullable=False)  # what this quantity cost (receipt / basis) or the cost of what was delivered (delivery)
    quantity_after: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    value_after: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    effective_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reference: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # the goods receipt / dispatch number
    counterparty: Mapped[Optional[str]] = mapped_column(String(150), nullable=True)  # the supplier / the client
    detail: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)  # the purchase order / sales order number, or a note
    link_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)  # the goods receipt id in Purchasing
    created_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)  # NULL: recorded by the synchronisation
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW)


class TradeDelivery(TenantOwnedMixin, Base):
    """Goods that LEFT stock for a client, recognised ONCE at delivery confirmation: revenue = delivered quantity x the unit price agreed on the order,
    cost of goods sold = the actual (weighted-average) cost of that quantity. Neither an invoice nor a payment ever creates one: they cannot recognise it twice.

    status: 'recognized' (price and cost both known: it counts in profit), 'needs_price' (an older order with no recorded price) or 'needs_cost' (no reliable
    cost yet). Nothing is guessed: such a delivery is listed for reconciliation and counts in no profit figure until a person (or a later goods receipt) settles it."""

    __tablename__ = "trade_deliveries"
    __table_args__ = (
        UniqueConstraint("organization_id", "source_key", name="uq_trade_deliveries_organization_id_source_key"),
        UniqueConstraint("organization_id", "id", name="uq_trade_deliveries_organization_id_id"),
        Index("ix_trade_deliveries_organization_id_delivered_at", "organization_id", "delivered_at"),
        Index("ix_trade_deliveries_organization_id_product_id", "organization_id", "product_id"),
        Index("ix_trade_deliveries_organization_id_status", "organization_id", "status"),
        CheckConstraint(_in("status", DELIVERY_STATUSES), name="status_valid"),
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'", name="currency_code_valid"),
        CheckConstraint("(unit_price IS NULL) = (revenue IS NULL)", name="price_and_revenue_together"),
        CheckConstraint("unit_price IS NULL OR (unit_price >= 0 AND currency_code IS NOT NULL)", name="price_has_currency"),
        CheckConstraint("cogs IS NULL OR cogs >= 0", name="cogs_not_negative"),
        CheckConstraint(
            "(status = 'needs_price' AND revenue IS NULL) OR (status = 'needs_cost' AND revenue IS NOT NULL AND cogs IS NULL) OR (status = 'recognized' AND revenue IS NOT NULL AND cogs IS NOT NULL)",
            name="status_matches_amounts",
        ),
    )

    id: Mapped[uuid.UUID] = _pk()
    source_key: Mapped[str] = mapped_column(String(160), nullable=False)  # 'delivery-line:<dispatch line id>'
    dispatch_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    dispatch_line_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    dispatch_number: Mapped[str] = mapped_column(String(32), nullable=False)
    order_number: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    client_name: Mapped[str] = mapped_column(String(255), nullable=False)
    product_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    product_sku: Mapped[str] = mapped_column(String(64), nullable=False)
    product_name: Mapped[str] = mapped_column(String(255), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    currency_code: Mapped[Optional[str]] = mapped_column(String(3), nullable=True)
    unit_price: Mapped[Optional[Decimal]] = mapped_column(MONEY, nullable=True)
    revenue: Mapped[Optional[Decimal]] = mapped_column(MONEY, nullable=True)
    cogs: Mapped[Optional[Decimal]] = mapped_column(MONEY, nullable=True)
    status: Mapped[str] = mapped_column(String(12), nullable=False)
    note: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)  # why it needs reconciliation / how it was settled
    delivered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reconciled_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    reconciled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW, onupdate=NOW)


class TradeAdjustment(TenantOwnedMixin, Base):
    """A change to revenue that was already recognised at delivery - today only: an issued invoice that billed LESS or MORE than the delivery's agreed value (a
    discount, a different price). Signed (negative reduces profit), append-only; voiding the invoice adds the opposite row. Never a second revenue."""

    __tablename__ = "trade_adjustments"
    __table_args__ = (
        UniqueConstraint("organization_id", "source_key", name="uq_trade_adjustments_organization_id_source_key"),
        UniqueConstraint("organization_id", "id", name="uq_trade_adjustments_organization_id_id"),
        Index("ix_trade_adjustments_organization_id_effective_at", "organization_id", "effective_at"),
        CheckConstraint(_in("kind", ADJUSTMENT_KINDS), name="kind_valid"),
        CheckConstraint("amount <> 0", name="amount_not_zero"),
        CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name="currency_code_valid"),
        CheckConstraint("(kind = 'invoice_adjustment_reversal') = (reverses_id IS NOT NULL)", name="reversal_names_its_original"),
        ForeignKeyConstraint(["organization_id", "reverses_id"], ["trade_adjustments.organization_id", "trade_adjustments.id"], name="fk_trade_adjustments_organization_id_trade_adjustments"),
        ForeignKeyConstraint(["organization_id", "delivery_id"], ["trade_deliveries.organization_id", "trade_deliveries.id"], name="fk_trade_adjustments_organization_id_trade_deliveries"),
        Index("ix_trade_adjustments_organization_id_invoice_id", "organization_id", "invoice_id"),
    )

    id: Mapped[uuid.UUID] = _pk()
    source_key: Mapped[str] = mapped_column(String(160), nullable=False)
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    invoice_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    delivery_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)  # the recognised delivery whose revenue this adjusts
    reference: Mapped[str] = mapped_column(String(32), nullable=False)  # the invoice number
    description: Mapped[str] = mapped_column(String(300), nullable=False)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False)
    effective_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reverses_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW)


class CapitalRecord(TenantOwnedMixin, Base):
    """An owner contribution or withdrawal - the ONLY things that change the owner's invested capital. Append-only: a mistake is corrected by a REVERSAL row that
    names it. `effect` is the signed change to invested capital (contribution +, withdrawal -, a reversal the opposite of what it reverses)."""

    __tablename__ = "capital_records"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_capital_records_organization_id_id"),
        UniqueConstraint("organization_id", "reverses_id", name="uq_capital_records_organization_id_reverses_id"),
        Index("ix_capital_records_organization_id_effective_date", "organization_id", "effective_date"),
        CheckConstraint(_in("kind", CAPITAL_KINDS), name="kind_valid"),
        CheckConstraint(_in("entry_type", CAPITAL_TYPES), name="entry_type_valid"),
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name="currency_code_valid"),
        CheckConstraint("(reverses_id IS NOT NULL) = is_reversal", name="reversal_names_its_original"),
        CheckConstraint("effect = amount * (CASE WHEN kind = 'contribution' THEN 1 ELSE -1 END) * (CASE WHEN is_reversal THEN -1 ELSE 1 END)", name="effect_matches"),
        CheckConstraint("NOT is_reversal OR (reversal_reason IS NOT NULL AND length(btrim(reversal_reason)) > 0)", name="reversal_has_reason"),
        ForeignKeyConstraint(["organization_id", "reverses_id"], ["capital_records.organization_id", "capital_records.id"], name="fk_capital_records_organization_id_capital_records"),
    )

    id: Mapped[uuid.UUID] = _pk()
    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    entry_type: Mapped[str] = mapped_column(String(10), nullable=False)  # cash | asset (an asset given in kind) | inventory (stock given in kind)
    is_reversal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    reverses_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    effect: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False)
    effective_date: Mapped[date] = mapped_column(Date, nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    reference: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    reversal_reason: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    created_by_email: Mapped[str] = mapped_column(String(320), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW)


class OpeningPosition(TenantOwnedMixin, Base):
    """The financial position an organization starts from, per currency: what it owned and what it owed on `effective_date`. The owner's equity is the difference.
    One active position per currency; a correction reverses it (kept, with who and why) and records a new one."""

    __tablename__ = "opening_positions"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_opening_positions_organization_id_id"),
        Index("uq_opening_positions_organization_id_active_currency", "organization_id", "currency_code", unique=True, postgresql_where=text("status = 'active'")),
        CheckConstraint(_in("status", POSITION_STATUSES), name="status_valid"),
        CheckConstraint("assets >= 0 AND liabilities >= 0", name="amounts_not_negative"),
        CheckConstraint("equity = assets - liabilities", name="equity_matches"),
        CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name="currency_code_valid"),
        CheckConstraint("status = 'active' OR (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL)", name="reversed_has_reason"),
    )

    id: Mapped[uuid.UUID] = _pk()
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False)
    effective_date: Mapped[date] = mapped_column(Date, nullable=False)
    assets: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    liabilities: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    equity: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="active", server_default=text("'active'"))
    reversed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    reversed_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    reversal_reason: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    created_by_email: Mapped[str] = mapped_column(String(320), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=NOW)
