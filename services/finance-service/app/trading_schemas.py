"""Request bodies for Capital, Investment and Profit & Loss. They forbid unknown fields: an organization id, a total, a status or anything else the caller must not
decide is refused (422), never silently ignored. Amounts are exact decimals (at most 14 digits before and 4 after the point)."""
import uuid
from datetime import date
from typing import Literal, Optional

from pydantic import Field, field_validator

from app.schemas import Money, PositiveMoney, Strict, _blank_to_none, _currency


class InvestmentCreate(Strict):
    kind: Literal["contribution", "withdrawal"] = "contribution"
    entry_type: Literal["cash", "asset", "inventory"] = "cash"  # cash / bank, an asset given in kind, or stock given in kind (its amount is the valuation)
    amount: PositiveMoney
    currency_code: Optional[str] = None
    effective_date: date
    description: Optional[str] = Field(default=None, max_length=500)
    reference: Optional[str] = Field(default=None, max_length=100)
    notes: Optional[str] = Field(default=None, max_length=500)

    @field_validator("currency_code")
    @classmethod
    def _check_currency(cls, value):
        return _currency(value)

    @field_validator("description", "reference", "notes")
    @classmethod
    def _check_blank(cls, value):
        return _blank_to_none(value)


class ReasonBody(Strict):
    reason: str = Field(min_length=3, max_length=500)


class InvestmentReverse(ReasonBody):
    effective_date: Optional[date] = None


class OpeningCreate(Strict):
    currency_code: Optional[str] = None
    effective_date: date
    assets: Money
    liabilities: Money
    notes: Optional[str] = Field(default=None, max_length=500)

    @field_validator("currency_code")
    @classmethod
    def _check_currency(cls, value):
        return _currency(value)

    @field_validator("notes")
    @classmethod
    def _check_blank(cls, value):
        return _blank_to_none(value)


class BasisCreate(Strict):
    product_id: uuid.UUID
    sku: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=255)
    quantity: PositiveMoney
    unit_cost: PositiveMoney
    currency_code: Optional[str] = None
    effective_date: date
    notes: Optional[str] = Field(default=None, max_length=300)

    @field_validator("currency_code")
    @classmethod
    def _check_currency(cls, value):
        return _currency(value)

    @field_validator("notes")
    @classmethod
    def _check_blank(cls, value):
        return _blank_to_none(value)


class ReconcileBody(Strict):
    unit_price: Optional[PositiveMoney] = None
    unit_cost: Optional[Money] = None
    currency_code: Optional[str] = None
    reason: str = Field(min_length=3, max_length=200)

    @field_validator("currency_code")
    @classmethod
    def _check_currency(cls, value):
        return _currency(value)
