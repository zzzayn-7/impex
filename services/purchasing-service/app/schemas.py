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
Status = Literal["draft", "ordered", "partially_received", "received", "cancelled"]


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
    notes: Optional[str] = Field(default=None, max_length=500)

    @field_validator("notes")
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)


class LineUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    quantity: Optional[Quantity] = None
    unit_price: Optional[UnitPrice] = None
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
    notes: Optional[str]
    created_at: datetime
    updated_at: datetime
    # How much has arrived. Only goods receipts that were CONFIRMED count as received; a receipt being posted is "pending"
    # (reserved, so nobody can receive the same goods twice). remaining = ordered - received - pending.
    received_quantity: Decimal = Decimal("0.0000")
    pending_quantity: Decimal = Decimal("0.0000")
    remaining_quantity: Optional[Decimal] = None

    @model_validator(mode="after")
    def _remaining(self):
        if self.remaining_quantity is None:
            self.remaining_quantity = self.quantity - self.received_quantity - self.pending_quantity
        return self


NO_STOCK_NOTICE = (
    "A purchase order does not change your stock. Placing an order does not add the goods to inventory; they are added only when "
    "the goods are received and the goods receipt is confirmed."
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
    receipts: List["ReceiptSummary"] = []  # the goods receipts of this order, newest first (drafts and cancelled ones included)
    can_receive: bool = False  # Ordered or Partially Received, with something still receivable
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


# =====================================================================================================
# Goods receipts (Step 16B)
# =====================================================================================================
ReceiptStatus = Literal["draft", "posting", "confirmed", "cancelled"]
ReceivedQuantity = Annotated[Decimal, Field(ge=0, max_digits=18, decimal_places=4)]

RECEIPT_NOTICE = (
    "Saving or reviewing a goods receipt does not change your stock. Stock is added only when you confirm the receipt, "
    "and only for the accepted quantities."
)


class ReceiptLineInput(BaseModel):
    """What arrived of one purchase-order line. Product, SKU, name and unit come from the order line, never from the caller."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    purchase_order_line_id: uuid.UUID
    accepted_quantity: ReceivedQuantity = Decimal("0")  # added to stock when the receipt is confirmed
    rejected_quantity: ReceivedQuantity = Decimal("0")  # informational only: never added to stock
    notes: Optional[str] = Field(default=None, max_length=500)

    @field_validator("notes")
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)


class ReceiptFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("supplier_reference", "notes", check_fields=False)
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)


class ReceiptCreate(ReceiptFields):
    purchase_order_id: uuid.UUID
    received_date: Optional[date] = None  # default: today
    supplier_reference: Optional[str] = Field(default=None, max_length=100)  # e.g. the supplier's delivery note number
    notes: Optional[str] = Field(default=None, max_length=2000)
    lines: List[ReceiptLineInput] = Field(default_factory=list, max_length=500)


class ReceiptUpdate(ReceiptFields):
    received_date: Optional[date] = None
    supplier_reference: Optional[str] = Field(default=None, max_length=100)
    notes: Optional[str] = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _valid(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to change.")
        if "received_date" in self.model_fields_set and self.received_date is None:
            raise ValueError("received_date cannot be empty")
        return self


class ReceiptLines(BaseModel):
    """The complete set of lines of a draft receipt. Lines that are not listed (or have nothing accepted or rejected) are not on it."""

    model_config = ConfigDict(extra="forbid")

    lines: List[ReceiptLineInput] = Field(max_length=500)


class OrderRef(BaseModel):
    id: uuid.UUID
    number: str
    status: Status


class ReceiptLineResponse(BaseModel):
    id: uuid.UUID
    purchase_order_line_id: uuid.UUID
    product_id: uuid.UUID
    product_sku: str
    product_name: str
    unit: str
    ordered_quantity: Decimal
    received_elsewhere_quantity: Decimal  # confirmed on OTHER receipts of the order
    pending_elsewhere_quantity: Decimal  # being posted on other receipts (reserved)
    receivable_quantity: Decimal  # the most this receipt may accept: ordered - received elsewhere - pending elsewhere
    accepted_quantity: Decimal
    rejected_quantity: Decimal
    notes: Optional[str]
    inventory_movement_id: Optional[uuid.UUID]  # the Inventory Service's stock movement, once confirmed


class PostingInfo(BaseModel):
    attempts: int
    started_at: Optional[datetime]
    last_attempt_at: Optional[datetime]
    last_error: Optional[str]


class ReceiptSummary(BaseModel):
    id: uuid.UUID
    number: str
    status: ReceiptStatus
    purchase_order: OrderRef
    supplier: SupplierRef
    supplier_reference: Optional[str]
    received_date: date
    notes: Optional[str]
    line_count: int
    created_by_email: str
    created_at: datetime
    confirmed_at: Optional[datetime]
    confirmed_by_email: Optional[str]
    cancelled_at: Optional[datetime]
    cancelled_by_email: Optional[str]
    updated_at: datetime


class ReceiptDetail(ReceiptSummary):
    lines: List[ReceiptLineResponse]
    posting: PostingInfo
    inventory_operation_id: Optional[uuid.UUID]
    editable: bool  # only a draft can be edited
    stock_notice: str = RECEIPT_NOTICE


class ReceiptPage(BaseModel):
    items: List[ReceiptSummary]
    total: int
    limit: int
    offset: int


PurchaseOrderDetail.model_rebuild()
