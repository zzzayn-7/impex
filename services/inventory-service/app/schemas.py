import re
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SKU_RE = re.compile(r"^[A-Z0-9][A-Z0-9._/\-]{0,63}$")
# Harmonized System code: 4 digits, optionally refined by 2-digit groups (8517.12.00), or 4-10 plain digits.
HS_RE = re.compile(r"^[0-9]{4}(\.[0-9]{2}){0,3}$|^[0-9]{4,10}$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")

# Exact decimals: at most 10 digits before and 4 after the point, never negative. Matches NUMERIC(14,4).
Money = Annotated[Decimal, Field(ge=0, max_digits=14, decimal_places=4)]


class ProductFields(BaseModel):
    """Shared input rules. Unknown fields (including organization_id) are rejected, never silently accepted."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("sku", check_fields=False)
    @classmethod
    def _normalize_sku(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        value = value.upper()  # "abc-1" and "ABC-1" are the same SKU
        if not SKU_RE.match(value):
            raise ValueError("SKU may contain only letters, digits and . _ - /")
        return value

    @field_validator("currency_code", check_fields=False)
    @classmethod
    def _normalize_currency(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        value = value.upper()
        if not CURRENCY_RE.match(value):
            raise ValueError("Currency must be a 3-letter ISO 4217 code such as USD or EUR")
        return value

    @field_validator("hs_code", "description", check_fields=False)
    @classmethod
    def _blank_to_none(cls, value: Optional[str], info) -> Optional[str]:
        if value is None or value == "":
            return None
        if info.field_name == "hs_code" and not HS_RE.match(value):
            raise ValueError("HS code must look like 8517, 8517.12 or 8517.12.00")
        return value


class ProductCreate(ProductFields):
    sku: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2000)
    category: str = Field(min_length=1, max_length=100)
    unit: str = Field(min_length=1, max_length=20)
    hs_code: Optional[str] = Field(default=None, max_length=16)
    cost_price: Money
    selling_price: Money
    currency_code: str = Field(min_length=3, max_length=3)
    is_active: bool = True


class ProductUpdate(ProductFields):
    """Partial update: only the fields that are sent change."""

    sku: Optional[str] = Field(default=None, min_length=1, max_length=64)
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2000)
    category: Optional[str] = Field(default=None, min_length=1, max_length=100)
    unit: Optional[str] = Field(default=None, min_length=1, max_length=20)
    hs_code: Optional[str] = Field(default=None, max_length=16)
    cost_price: Optional[Money] = None
    selling_price: Optional[Money] = None
    currency_code: Optional[str] = Field(default=None, min_length=3, max_length=3)
    is_active: Optional[bool] = None

    @model_validator(mode="after")
    def _at_least_one_and_no_nulls(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to change.")
        required = ("sku", "name", "category", "unit", "cost_price", "selling_price", "currency_code", "is_active")
        for field in required:
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be empty")
        return self


class ProductResponse(BaseModel):
    """A product as the tenant sees it. Prices are decimal strings (exact). No organization_id is exposed."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    sku: str
    name: str
    description: Optional[str]
    category: str
    unit: str
    hs_code: Optional[str]
    cost_price: Decimal
    selling_price: Decimal
    currency_code: str
    is_active: bool
    created_at: datetime
    updated_at: datetime


class ProductList(BaseModel):
    items: List[ProductResponse]
    total: int  # all matches for the filters, ignoring limit/offset
    limit: int
    offset: int
