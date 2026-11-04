"""Request and response models.

Write models forbid unknown fields, so an `organization_id`, a `status`, a product name / SKU / unit, a line total or any
other value the caller must not decide is refused with 422 instead of being silently ignored. Money and quantities are
exact decimals (strings in JSON), never floats.
"""
import re
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9._-]{0,31}$")

# Exact decimals: at most 14 digits before and 4 after the point (NUMERIC(18,4)).
Quantity = Annotated[Decimal, Field(gt=0, max_digits=18, decimal_places=4)]
UnitPrice = Annotated[Decimal, Field(ge=0, max_digits=18, decimal_places=4)]
Currency = Annotated[str, Field(min_length=3, max_length=3)]


def blank_to_none(value: Optional[str]) -> Optional[str]:
    return None if value is None or value == "" else value


# =====================================================================================================
# Suppliers
# =====================================================================================================
class SupplierFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("code", "contact_person", "email", "phone", "address", "country_code", "tax_identifier", check_fields=False)
    @classmethod
    def _optional_blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)

    @field_validator("name", check_fields=False)
    @classmethod
    def _collapse_name(cls, value: Optional[str]) -> Optional[str]:
        return " ".join(value.split()) if value else value

    @field_validator("email", check_fields=False)
    @classmethod
    def _email_shape(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not EMAIL_RE.match(value):
            raise ValueError("Enter a valid e-mail address")
        return value.lower() if value else value

    @field_validator("code", check_fields=False)
    @classmethod
    def _code_shape(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        value = value.upper()
        if not CODE_RE.match(value):
            raise ValueError("Supplier code may contain only letters, digits and . _ - (max 32 characters)")
        return value

    @field_validator("country_code", check_fields=False)
    @classmethod
    def _country_shape(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        value = value.upper()
        if not re.fullmatch(r"[A-Z]{2}", value):
            raise ValueError("Use the 2-letter country code, e.g. DE, PK, US")
        return value


class SupplierCreate(SupplierFields):
    name: str = Field(min_length=1, max_length=255)
    code: Optional[str] = Field(default=None, max_length=32)
    contact_person: Optional[str] = Field(default=None, max_length=255)
    email: Optional[str] = Field(default=None, max_length=320)
    phone: Optional[str] = Field(default=None, max_length=50)
    address: Optional[str] = Field(default=None, max_length=500)
    country_code: Optional[str] = Field(default=None, max_length=2)
    tax_identifier: Optional[str] = Field(default=None, max_length=50)


class SupplierUpdate(SupplierFields):
    """Partial update: only the fields that are sent change."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    code: Optional[str] = Field(default=None, max_length=32)
    contact_person: Optional[str] = Field(default=None, max_length=255)
    email: Optional[str] = Field(default=None, max_length=320)
    phone: Optional[str] = Field(default=None, max_length=50)
    address: Optional[str] = Field(default=None, max_length=500)
    country_code: Optional[str] = Field(default=None, max_length=2)
    tax_identifier: Optional[str] = Field(default=None, max_length=50)

    @model_validator(mode="after")
    def _something_to_change(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to change.")
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("name cannot be empty")
        return self


class SupplierResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    code: Optional[str]
    contact_person: Optional[str]
    email: Optional[str]
    phone: Optional[str]
    address: Optional[str]
    country_code: Optional[str]
    tax_identifier: Optional[str]
    is_active: bool
    created_at: datetime
    updated_at: datetime


class SupplierList(BaseModel):
    items: List[SupplierResponse]
    total: int
    limit: int
    offset: int


class SupplierRef(BaseModel):
    id: uuid.UUID
    name: str
    code: Optional[str]
    is_active: bool


# =====================================================================================================
# Purchase orders
# =====================================================================================================
Status = Literal["draft", "ordered", "cancelled"]


class OrderFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("supplier_reference", "notes", "expected_delivery_date", check_fields=False)
    @classmethod
    def _blank(cls, value):
        return blank_to_none(value) if isinstance(value, str) else value

    @field_validator("currency_code", check_fields=False)
    @classmethod
    def _currency(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        value = value.upper()
        if not re.fullmatch(r"[A-Z]{3}", value):
            raise ValueError("Use a 3-letter currency code such as USD or EUR")
        return value


class PurchaseOrderCreate(OrderFields):
    """Start a draft order with a supplier. The number, status, owner and totals are decided by the service."""

    supplier_id: uuid.UUID
    currency_code: Currency
    supplier_reference: Optional[str] = Field(default=None, max_length=100)
    order_date: Optional[date] = None  # default: today
    expected_delivery_date: Optional[date] = None
    notes: Optional[str] = Field(default=None, max_length=2000)


class PurchaseOrderUpdate(OrderFields):
    """Edit a DRAFT's header (only the fields that are sent)."""

    supplier_id: Optional[uuid.UUID] = None
    currency_code: Optional[Currency] = None
    supplier_reference: Optional[str] = Field(default=None, max_length=100)
    order_date: Optional[date] = None
    expected_delivery_date: Optional[date] = None
    notes: Optional[str] = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _valid(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to change.")
        for required in ("supplier_id", "currency_code", "order_date"):
            if required in self.model_fields_set and getattr(self, required) is None:
                raise ValueError(f"{required} cannot be empty")
        return self


class LineCreate(BaseModel):
    """Add a product. Only its id, the ordered quantity and the unit purchase price come from the caller: name, SKU and unit
    are read from the Inventory Service, and the line total is calculated here."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    product_id: uuid.UUID
    quantity: Quantity
    unit_price: UnitPrice
    planned_warehouse_id: Optional[uuid.UUID] = None
    notes: Optional[str] = Field(default=None, max_length=500)

    @field_validator("notes")
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)


class LineUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    quantity: Optional[Quantity] = None
    unit_price: Optional[UnitPrice] = None
    planned_warehouse_id: Optional[uuid.UUID] = None  # send null to clear it
    notes: Optional[str] = Field(default=None, max_length=500)

    @field_validator("notes")
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)

    @model_validator(mode="after")
    def _valid(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to change.")
        for required in ("quantity", "unit_price"):
            if required in self.model_fields_set and getattr(self, required) is None:
                raise ValueError(f"{required} cannot be empty")
        return self


class LineResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    product_id: uuid.UUID
    product_sku: str
    product_name: str
    unit: str
    quantity: Decimal
    unit_price: Decimal
    line_total: Decimal
    planned_warehouse_id: Optional[uuid.UUID]
    planned_warehouse_code: Optional[str]
    notes: Optional[str]
    created_at: datetime
    updated_at: datetime


NO_STOCK_NOTICE = (
    "A purchase order does not change your stock. Placing an order does not add the goods to inventory; they are added only when "
    "they are received (a later step)."
)


class PurchaseOrderSummary(BaseModel):
    id: uuid.UUID
    number: str
    supplier: SupplierRef
    supplier_reference: Optional[str]
    order_date: date
    expected_delivery_date: Optional[date]
    currency_code: str
    notes: Optional[str]
    status: Status
    line_count: int
    total_amount: Decimal  # the sum of the line totals, calculated here
    created_by_email: str
    ordered_at: Optional[datetime]
    ordered_by_email: Optional[str]
    cancelled_at: Optional[datetime]
    cancelled_by_email: Optional[str]
    created_at: datetime
    updated_at: datetime


class PurchaseOrderPage(BaseModel):
    items: List[PurchaseOrderSummary]
    total: int
    limit: int
    offset: int


class PurchaseOrderDetail(PurchaseOrderSummary):
    lines: List[LineResponse]
    frozen: bool  # True once the order is Ordered or Cancelled: nothing commercial can change any more
    stock_notice: str = NO_STOCK_NOTICE


class LineRemoved(BaseModel):
    """What is left of the order after a line was removed (the total is calculated here)."""

    line_count: int
    total_amount: Decimal
    currency_code: str


class LineResult(BaseModel):
    """A line as saved, plus the order's new line count and total (calculated here, not by the browser)."""

    line: LineResponse
    line_count: int
    total_amount: Decimal
    currency_code: str
