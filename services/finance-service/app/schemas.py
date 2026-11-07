"""Request and response models.

Write models forbid unknown fields, so an `organization_id`, a `status`, a number, a total or any other value the caller must not decide is
refused with 422 instead of being silently ignored. Amounts are exact decimals (at most 14 digits before and 4 after the point) and are
returned as exact strings, never floats.
"""
import re
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator

from app.currencies import is_known_currency

Money = Annotated[Decimal, Field(ge=0, max_digits=18, decimal_places=4)]
PositiveMoney = Annotated[Decimal, Field(gt=0, max_digits=18, decimal_places=4)]
CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$")


def _blank_to_none(value: Optional[str]) -> Optional[str]:
    return None if value is None or value == "" else value


def _currency(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    value = value.strip().upper()
    if not is_known_currency(value):
        raise ValueError("Enter a valid three-letter ISO 4217 currency code, e.g. USD")
    return value


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    @field_serializer("*", when_used="json", check_fields=False)
    def _decimals_as_exact_strings(self, value):
        return format(value, "f") if isinstance(value, Decimal) else value


# =====================================================================================================
# Accounts
# =====================================================================================================
AccountType = Literal["asset", "liability", "equity", "revenue", "expense"]


class AccountCreate(Strict):
    code: str = Field(min_length=1, max_length=20)
    name: str = Field(min_length=1, max_length=150)
    account_type: AccountType
    description: Optional[str] = Field(default=None, max_length=500)

    @field_validator("code")
    @classmethod
    def _code(cls, value: str) -> str:
        value = value.upper()
        if not CODE_RE.match(value):
            raise ValueError("Use letters, digits and . _ - only (up to 20 characters)")
        return value

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return " ".join(value.split())

    @field_validator("description")
    @classmethod
    def _description(cls, value):
        return _blank_to_none(value)


class AccountUpdate(Strict):
    """Partial update. The code and type can change only while the account has no postings (the database enforces it too)."""

    code: Optional[str] = Field(default=None, min_length=1, max_length=20)
    name: Optional[str] = Field(default=None, min_length=1, max_length=150)
    account_type: Optional[AccountType] = None
    description: Optional[str] = Field(default=None, max_length=500)
    is_active: Optional[bool] = None

    @field_validator("code")
    @classmethod
    def _code(cls, value):
        if value is None:
            return value
        value = value.upper()
        if not CODE_RE.match(value):
            raise ValueError("Use letters, digits and . _ - only (up to 20 characters)")
        return value

    @field_validator("name")
    @classmethod
    def _name(cls, value):
        return " ".join(value.split()) if value else value


class AccountOut(Out):
    id: uuid.UUID
    code: str
    name: str
    account_type: str
    description: Optional[str]
    is_active: bool
    is_system: bool
    system_key: Optional[str]
    has_postings: bool = False
    created_at: datetime
    updated_at: datetime


# =====================================================================================================
# Journal entries
# =====================================================================================================
class LineIn(Strict):
    account_id: uuid.UUID
    debit: Money = Decimal("0")
    credit: Money = Decimal("0")
    description: Optional[str] = Field(default=None, max_length=255)

    @field_validator("description")
    @classmethod
    def _description(cls, value):
        return _blank_to_none(value)


class EntryFields(Strict):
    @field_validator("description", "reference", check_fields=False)
    @classmethod
    def _blank(cls, value):
        return " ".join(value.split()) if isinstance(value, str) and value.strip() else (None if value in (None, "") else value)

    @field_validator("currency_code", check_fields=False)
    @classmethod
    def _currency_code(cls, value):
        return _currency(value)


class EntryCreate(EntryFields):
    entry_date: date
    description: str = Field(min_length=1, max_length=500)
    reference: Optional[str] = Field(default=None, max_length=100)
    currency_code: Optional[str] = Field(default=None, description="Defaults to the organization's default currency")
    lines: List[LineIn] = Field(default_factory=list, max_length=200)
    post: bool = Field(default=False, description="Post the entry straight away (it must be balanced)")


class EntryUpdate(EntryFields):
    """A DRAFT is replaced as a whole (a posted entry can never be edited)."""

    entry_date: date
    description: str = Field(min_length=1, max_length=500)
    reference: Optional[str] = Field(default=None, max_length=100)
    currency_code: str
    lines: List[LineIn] = Field(default_factory=list, max_length=200)


class ReverseRequest(Strict):
    reason: str = Field(min_length=3, max_length=500)
    entry_date: Optional[date] = Field(default=None, description="The date of the reversing entry; defaults to today")

    @field_validator("reason")
    @classmethod
    def _reason(cls, value: str) -> str:
        return " ".join(value.split())


class LineOut(Out):
    id: uuid.UUID
    line_no: int
    account_id: uuid.UUID
    account_code: str
    account_name: str
    debit: Decimal
    credit: Decimal
    description: Optional[str]


class AuditOut(Out):
    seq: int
    action: str
    actor_email: Optional[str]
    source: str
    detail: Optional[str]
    created_at: datetime


class EntrySummary(Out):
    id: uuid.UUID
    entry_number: Optional[str]
    entry_date: date
    description: str
    reference: Optional[str]
    currency_code: str
    status: str
    source_type: str
    source_summary: Optional[str]
    total: Optional[Decimal]
    reverses_entry_id: Optional[uuid.UUID]
    reversed_by_entry_id: Optional[uuid.UUID] = None
    created_by_email: Optional[str]
    posted_at: Optional[datetime]
    created_at: datetime


class EntryDetail(EntrySummary):
    source_key: Optional[str]
    reversal_reason: Optional[str]
    posted_by_email: Optional[str]
    total_debit: Decimal
    total_credit: Decimal
    is_balanced: bool
    lines: List[LineOut]
    history: List[AuditOut]
    can_reverse: bool


class EntryPage(Out):
    items: List[EntrySummary]
    total: int
    limit: int
    offset: int


# =====================================================================================================
# Expenses
# =====================================================================================================
class ExpenseFields(Strict):
    @field_validator("description", "reference", "vendor", check_fields=False)
    @classmethod
    def _blank(cls, value):
        return " ".join(value.split()) if isinstance(value, str) and value.strip() else (None if value in (None, "") else value)

    @field_validator("currency_code", check_fields=False)
    @classmethod
    def _currency_code(cls, value):
        return _currency(value)


class ExpenseCreate(ExpenseFields):
    expense_date: date
    description: str = Field(min_length=1, max_length=500)
    reference: Optional[str] = Field(default=None, max_length=100)
    vendor: Optional[str] = Field(default=None, max_length=150)
    account_id: uuid.UUID = Field(description="The expense account (category) this cost belongs to")
    amount: PositiveMoney
    currency_code: Optional[str] = Field(default=None, description="Defaults to the organization's default currency")
    post: bool = False


class ExpenseUpdate(ExpenseFields):
    expense_date: date
    description: str = Field(min_length=1, max_length=500)
    reference: Optional[str] = Field(default=None, max_length=100)
    vendor: Optional[str] = Field(default=None, max_length=150)
    account_id: uuid.UUID
    amount: PositiveMoney
    currency_code: str


class ExpenseOut(Out):
    id: uuid.UUID
    number: str
    expense_date: date
    description: str
    reference: Optional[str]
    vendor: Optional[str]
    account_id: uuid.UUID
    account_code: str
    account_name: str
    amount: Decimal
    currency_code: str
    status: str
    journal_entry_id: Optional[uuid.UUID]
    reversal_entry_id: Optional[uuid.UUID]
    created_by_email: str
    posted_at: Optional[datetime]
    posted_by_email: Optional[str]
    reversed_at: Optional[datetime]
    reversed_by_email: Optional[str]
    reversal_reason: Optional[str]
    created_at: datetime


class ExpenseDetail(ExpenseOut):
    history: List[AuditOut]


class ExpensePage(Out):
    items: List[ExpenseOut]
    total: int
    limit: int
    offset: int


# =====================================================================================================
# Overview and synchronisation
# =====================================================================================================
class CurrencyTotals(Out):
    currency_code: str
    assets: Decimal
    liabilities: Decimal
    equity: Decimal
    revenue: Decimal
    expenses: Decimal
    posted_entries: int


class SyncSourceOut(Out):
    source: str
    status: str
    last_attempt_at: Optional[datetime]
    last_success_at: Optional[datetime]
    last_error: Optional[str]
    consecutive_failures: int


class SyncSummary(Out):
    sources: List[SyncSourceOut]
    pending: int
    failed: int
    skipped: int
    posted: int


class Overview(Out):
    default_currency: str
    activated_at: datetime
    accounts: int
    active_accounts: int
    draft_entries: int
    posted_entries: int
    draft_expenses: int
    posted_expenses: int
    totals_by_currency: List[CurrencyTotals]
    recent_entries: List[EntrySummary]
    sync: SyncSummary


class SyncEventOut(Out):
    id: uuid.UUID
    source: str
    event_key: str
    event_type: str
    event_time: datetime
    status: str
    attempts: int
    last_error: Optional[str]
    journal_entry_id: Optional[uuid.UUID]
    processed_at: Optional[datetime]
    created_at: datetime


class SyncEventPage(Out):
    items: List[SyncEventOut]
    total: int
    limit: int
    offset: int
