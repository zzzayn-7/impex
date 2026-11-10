"""Request and response models.

Write models forbid unknown fields, so an `organization_id`, a `status`, a product name or SKU, a stock quantity or any
other value the caller must not decide is refused with 422 instead of being silently ignored.
"""
import re
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Exact decimals, strictly positive: at most 14 digits before and 4 after the point (NUMERIC(18,4)).
Quantity = Annotated[Decimal, Field(gt=0, max_digits=18, decimal_places=4)]


def blank_to_none(value: Optional[str]) -> Optional[str]:
    return None if value is None or value == "" else value


# =====================================================================================================
# Clients
# =====================================================================================================
class ClientFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("contact_person", "email", "phone", "address", check_fields=False)
    @classmethod
    def _optional_blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)

    @field_validator("email", check_fields=False)
    @classmethod
    def _email_shape(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not EMAIL_RE.match(value):
            raise ValueError("Enter a valid e-mail address")
        return value.lower() if value else value

    @field_validator("name", check_fields=False)
    @classmethod
    def _collapse_name(cls, value: Optional[str]) -> Optional[str]:
        return " ".join(value.split()) if value else value


class ClientCreate(ClientFields):
    name: str = Field(min_length=1, max_length=255)
    contact_person: Optional[str] = Field(default=None, max_length=255)
    email: Optional[str] = Field(default=None, max_length=320)
    phone: Optional[str] = Field(default=None, max_length=50)
    address: Optional[str] = Field(default=None, max_length=500)


class ClientUpdate(ClientFields):
    """Partial update: only the fields that are sent change."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    contact_person: Optional[str] = Field(default=None, max_length=255)
    email: Optional[str] = Field(default=None, max_length=320)
    phone: Optional[str] = Field(default=None, max_length=50)
    address: Optional[str] = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def _something_to_change(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to change.")
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("name cannot be empty")
        return self


class ClientResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    contact_person: Optional[str]
    email: Optional[str]
    phone: Optional[str]
    address: Optional[str]
    is_active: bool
    created_at: datetime
    updated_at: datetime


class ClientList(BaseModel):
    items: List[ClientResponse]
    total: int
    limit: int
    offset: int


class ClientRef(BaseModel):
    id: uuid.UUID
    name: str
    is_active: bool


# =====================================================================================================
# Delivery lists
# =====================================================================================================
Status = Literal["draft", "ready", "partially_dispatched", "dispatched", "cancelled"]


class DeliveryListCreate(BaseModel):
    """Start a list for a client. The number, status and owner are decided by the service."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    client_id: uuid.UUID
    external_reference: Optional[str] = Field(default=None, max_length=100)
    notes: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("external_reference", "notes")
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)


class DeliveryListUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    external_reference: Optional[str] = Field(default=None, max_length=100)
    notes: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("external_reference", "notes")
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)

    @model_validator(mode="after")
    def _something_to_change(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to change.")
        return self


class ItemCreate(BaseModel):
    """Add a product. Only the product's id and the wanted quantity come from the caller: name, SKU, unit and stock are
    read from the Inventory Service."""

    model_config = ConfigDict(extra="forbid")

    product_id: uuid.UUID
    quantity: Quantity


class ItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quantity: Optional[Quantity] = None

    @model_validator(mode="after")
    def _valid(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to change.")
        if "quantity" in self.model_fields_set and self.quantity is None:
            raise ValueError("quantity cannot be empty")
        return self


class ItemIncrease(BaseModel):
    """Explicitly add this much to an existing line (never done implicitly by adding the same product again)."""

    model_config = ConfigDict(extra="forbid")

    quantity: Quantity


class ItemStock(BaseModel):
    """What the Inventory Service says right now (live, information only): the PHYSICAL stock on hand, how much of it is reserved for
    orders, and what is still available to a new order (on hand minus reserved)."""

    total_quantity: Decimal  # physical stock on hand
    reserved_quantity: Decimal = Decimal("0")
    available_quantity: Decimal = Decimal("0")
    product_active: bool
    unit_allows_fractions: bool
    exceeds_available: bool  # more is wanted than can be booked / dispatched (never true for a line that is already booked)
    shortfall: Decimal  # how much more is wanted than is available (0 when it fits)


class ItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    product_id: uuid.UUID
    product_sku: str
    product_name: str
    quantity: Decimal
    unit: str
    created_at: datetime
    updated_at: datetime
    stock: Optional[ItemStock] = None
    # Dispatch progress. Only CONFIRMED dispatches count as dispatched; a dispatch being posted is pending (reserved).
    # remaining = requested - dispatched - pending.
    dispatched_quantity: Decimal = Decimal("0.0000")
    pending_quantity: Decimal = Decimal("0.0000")
    remaining_quantity: Optional[Decimal] = None

    @model_validator(mode="after")
    def _remaining(self):
        if self.remaining_quantity is None:
            self.remaining_quantity = self.quantity - self.dispatched_quantity - self.pending_quantity
        return self


# How a delivery list relates to stock booking:
#   booked        its sales order is active: the stock is reserved in the Inventory Service
#   pending       the order is saved but the Inventory Service has not confirmed the booking yet (never treated as booked)
#   unbooked      an OLDER Ready list that was made before reservations existed: nothing is reserved for it (can be booked)
#   unbooked_partial  an OLDER list that already has goods dispatched: needs reconciliation by hand, nothing is reserved for it
#   draft         a draft list: nothing is booked until it is marked Ready
#   none          finished (dispatched / cancelled)
BookingState = Literal["booked", "pending", "unbooked", "unbooked_partial", "draft", "none"]


class DeliveryListSummary(BaseModel):
    id: uuid.UUID
    number: str
    client: ClientRef
    external_reference: Optional[str]
    status: Status
    notes: Optional[str]
    item_count: int
    created_by_email: str
    created_at: datetime
    updated_at: datetime
    # the sales order this list belongs to, if any
    order_id: Optional[uuid.UUID] = None
    order_number: Optional[str] = None
    order_status: Optional[str] = None
    reservation_status: Optional[str] = None
    booking_state: BookingState = "none"


class DeliveryListPage(BaseModel):
    items: List[DeliveryListSummary]
    total: int
    limit: int
    offset: int


STOCK_NOTICE = (
    "A draft list reserves nothing. Marking it Ready books its quantities as a sales order (they can then no longer be taken by "
    "anything else); physical stock is deducted only when a dispatch is confirmed."
)


class DeliveryListDetail(DeliveryListSummary):
    items: List[ItemResponse]
    stock_status: Literal["ok", "unavailable"]  # unavailable: the Inventory Service could not be asked right now
    items_exceeding_stock: int
    dispatches: List["DispatchSummary"] = []  # the dispatches of this list, newest first (drafts and cancelled ones included)
    can_dispatch: bool = False  # Ready or Partially Dispatched, with something still dispatchable
    stock_notice: str = STOCK_NOTICE


class ItemResult(BaseModel):
    """An item as saved, plus the list's new item count."""

    item: ItemResponse
    item_count: int
    stock_notice: str = STOCK_NOTICE


# =====================================================================================================
# Dispatches (Step 17A)
# =====================================================================================================
DispatchStatus = Literal["draft", "posting", "confirmed", "cancelled"]

DISPATCH_NOTICE = (
    "Preparing, saving or reviewing a dispatch does not change your stock. Stock is deducted only when you confirm the dispatch, "
    "and only the quantities on its lines."
)


class DispatchLineInput(BaseModel):
    """A quantity of one delivery-list item leaving stock. Product, SKU, name and unit come from the item, never from the caller."""

    model_config = ConfigDict(extra="forbid")

    delivery_list_item_id: uuid.UUID
    quantity: Quantity


class DispatchFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("delivery_address", "transport_details", "tracking_reference", "notes", check_fields=False)
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)


class DispatchCreate(DispatchFields):
    delivery_list_id: uuid.UUID
    dispatch_date: Optional[date] = None  # default: today
    delivery_address: Optional[str] = Field(default=None, max_length=1000)
    transport_details: Optional[str] = Field(default=None, max_length=500)
    tracking_reference: Optional[str] = Field(default=None, max_length=100)
    notes: Optional[str] = Field(default=None, max_length=2000)
    lines: List[DispatchLineInput] = Field(default_factory=list, max_length=500)


class DispatchUpdate(DispatchFields):
    dispatch_date: Optional[date] = None
    delivery_address: Optional[str] = Field(default=None, max_length=1000)
    transport_details: Optional[str] = Field(default=None, max_length=500)
    tracking_reference: Optional[str] = Field(default=None, max_length=100)
    notes: Optional[str] = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _valid(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to change.")
        if "dispatch_date" in self.model_fields_set and self.dispatch_date is None:
            raise ValueError("dispatch_date cannot be empty")
        return self


class DispatchLines(BaseModel):
    """The complete set of lines of a draft dispatch. Lines that are not listed are not on it."""

    model_config = ConfigDict(extra="forbid")

    lines: List[DispatchLineInput] = Field(max_length=500)


class ListRef(BaseModel):
    id: uuid.UUID
    number: str
    status: Status


class DispatchLineResponse(BaseModel):
    id: uuid.UUID
    delivery_list_item_id: uuid.UUID
    product_id: uuid.UUID
    product_sku: str
    product_name: str
    unit: str
    requested_quantity: Decimal  # what the client asked for
    dispatched_elsewhere_quantity: Decimal  # confirmed on OTHER dispatches of the list
    pending_elsewhere_quantity: Decimal  # being posted on other dispatches (reserved)
    dispatchable_quantity: Decimal  # the most this dispatch may carry: requested - dispatched elsewhere - pending elsewhere
    quantity: Decimal
    inventory_movement_id: Optional[uuid.UUID]  # the Inventory Service's stock movement, once confirmed
    available_quantity: Optional[Decimal] = None  # live stock of this product (information only: not reserved)


class PostingInfo(BaseModel):
    attempts: int
    started_at: Optional[datetime]
    last_attempt_at: Optional[datetime]
    last_error: Optional[str]


class DispatchSummary(BaseModel):
    id: uuid.UUID
    number: str
    status: DispatchStatus
    delivery_list: ListRef
    client: ClientRef
    dispatch_date: date
    tracking_reference: Optional[str]
    line_count: int
    created_by_email: str
    created_at: datetime
    confirmed_at: Optional[datetime]
    confirmed_by_email: Optional[str]
    cancelled_at: Optional[datetime]
    cancelled_by_email: Optional[str]
    updated_at: datetime


class DispatchDetail(DispatchSummary):
    delivery_address: Optional[str]
    transport_details: Optional[str]
    notes: Optional[str]
    lines: List[DispatchLineResponse]
    posting: PostingInfo
    inventory_operation_id: Optional[uuid.UUID]
    editable: bool  # only a draft can be edited
    stock_status: Literal["ok", "unavailable", "not-needed"]  # whether the live stock shown on the lines could be read
    lines_exceeding_stock: int  # lines whose quantity is more than is in stock right now (a draft only)
    stock_notice: str = DISPATCH_NOTICE


class DispatchPage(BaseModel):
    items: List[DispatchSummary]
    total: int
    limit: int
    offset: int


DeliveryListDetail.model_rebuild()


# =====================================================================================================
# Invoices and payments (Step 17B)
# =====================================================================================================
InvoiceStatus = Literal["draft", "issued", "partially_paid", "paid", "void"]
PaymentKind = Literal["payment", "reversal"]
PaymentMethod = Literal["cash", "bank_transfer", "cheque", "card", "mobile_wallet", "other"]

UnitPrice = Annotated[Decimal, Field(ge=0, max_digits=18, decimal_places=4)]
Money = Annotated[Decimal, Field(ge=0, max_digits=18, decimal_places=4)]
TaxRate = Annotated[Decimal, Field(ge=0, le=100, max_digits=7, decimal_places=4)]  # a percentage, entered explicitly

DISCLAIMER = (
    "This document records goods supplied and amounts due as entered by the seller. Discounts and taxes are exactly as entered; "
    "Impex does not apply any country's tax rules and does not certify that this invoice meets any tax or legal requirement."
)


class InvoiceLineInput(BaseModel):
    """One dispatched product to bill. Product, SKU, name and unit come from the dispatch line, never from the caller. The SELLING
    PRICE, the discount and the tax rate are exactly what the administrator enters: the catalog price is not consulted or changed."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    dispatch_line_id: uuid.UUID
    quantity: Quantity
    unit_price: UnitPrice
    discount_amount: Money = Decimal("0")  # an amount in the invoice currency, taken off this line before tax
    tax_rate: TaxRate = Decimal("0")  # percent of the discounted line amount
    tax_label: Optional[str] = Field(default=None, max_length=50)

    @field_validator("tax_label")
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)


class InvoiceFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("notes", check_fields=False)
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)


class InvoiceCreate(InvoiceFields):
    client_id: uuid.UUID
    currency_code: str = Field(min_length=3, max_length=3)
    invoice_date: Optional[date] = None  # default: today
    due_date: Optional[date] = None  # default: 30 days after the invoice date
    notes: Optional[str] = Field(default=None, max_length=2000)
    lines: List[InvoiceLineInput] = Field(default_factory=list, max_length=500)

    @field_validator("currency_code")
    @classmethod
    def _currency(cls, value: str) -> str:
        value = value.upper()
        if not re.fullmatch(r"[A-Z]{3}", value):
            raise ValueError("Use a 3-letter currency code such as USD, EUR or PKR")
        return value


class InvoiceUpdate(InvoiceFields):
    invoice_date: Optional[date] = None
    due_date: Optional[date] = None
    notes: Optional[str] = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _valid(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to change.")
        for required in ("invoice_date", "due_date"):
            if required in self.model_fields_set and getattr(self, required) is None:
                raise ValueError(f"{required} cannot be empty")
        return self


class InvoiceLines(BaseModel):
    """The complete set of lines of a draft invoice. Lines that are not listed are not on it."""

    model_config = ConfigDict(extra="forbid")

    lines: List[InvoiceLineInput] = Field(max_length=500)


class VoidRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    reason: Optional[str] = Field(default=None, max_length=500)

    @field_validator("reason")
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)


class PaymentCreate(BaseModel):
    """A payment received. The currency is always the invoice's; the recorder and the time are decided by the service."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    amount: Quantity
    method: PaymentMethod
    payment_date: Optional[date] = None  # default: today
    reference: Optional[str] = Field(default=None, max_length=100)
    notes: Optional[str] = Field(default=None, max_length=500)

    @field_validator("reference", "notes")
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)


class ReversalCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    reason: str = Field(min_length=1, max_length=500)


class AllocationResponse(BaseModel):
    dispatch_line_id: uuid.UUID
    dispatch_id: uuid.UUID
    dispatch_number: str
    quantity: Decimal


class InvoiceLineResponse(BaseModel):
    id: uuid.UUID
    product_id: uuid.UUID
    product_sku: str
    product_name: str
    unit: str
    quantity: Decimal
    unit_price: Decimal
    discount_amount: Decimal
    tax_rate: Decimal
    tax_label: Optional[str]
    line_subtotal: Decimal
    line_net: Decimal
    line_tax: Decimal
    line_total: Decimal
    allocations: List[AllocationResponse]


class PaymentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    invoice_id: uuid.UUID
    kind: PaymentKind
    reverses_payment_id: Optional[uuid.UUID]
    payment_date: date
    amount: Decimal
    currency_code: str
    method: str
    reference: Optional[str]
    notes: Optional[str]
    recorded_by_email: str
    created_at: datetime
    reversed: bool = False  # a payment that has been reversed (both rows stay on the invoice)


class PaymentWithInvoice(PaymentResponse):
    invoice_number: str


class InvoiceSummary(BaseModel):
    id: uuid.UUID
    number: Optional[str]
    status: InvoiceStatus
    client: ClientRef
    delivery_list: Optional["ListRef"]
    invoice_date: date
    due_date: date
    currency_code: str
    subtotal: Decimal
    discount_total: Decimal
    tax_total: Decimal
    total: Decimal
    paid_total: Decimal
    outstanding: Decimal
    overdue: bool  # issued / partially paid and past its due date
    line_count: int
    created_by_email: str
    issued_at: Optional[datetime]
    issued_by_email: Optional[str]
    voided_at: Optional[datetime]
    updated_at: datetime


class InvoiceDetail(InvoiceSummary):
    seller_name: Optional[str]
    client_name: Optional[str]
    client_address: Optional[str]
    notes: Optional[str]
    void_reason: Optional[str]
    lines: List[InvoiceLineResponse]
    payments: List[PaymentResponse]
    editable: bool  # only a draft can be edited
    can_issue: bool
    can_void: bool
    can_record_payment: bool
    disclaimer: str = DISCLAIMER


class InvoicePage(BaseModel):
    items: List[InvoiceSummary]
    total: int
    limit: int
    offset: int


class BillableLine(BaseModel):
    """A line of a CONFIRMED dispatch that can be billed: how much was dispatched, how much issued invoices already cover, how much sits
    in drafts (informational: drafts reserve nothing) and how much is still free to bill."""

    dispatch_line_id: uuid.UUID
    dispatch_id: uuid.UUID
    dispatch_number: str
    dispatch_date: date
    delivery_list: "ListRef"
    product_id: uuid.UUID
    product_sku: str
    product_name: str
    unit: str
    dispatched_quantity: Decimal
    invoiced_quantity: Decimal
    in_drafts_quantity: Decimal
    remaining_quantity: Decimal


class AccountBalance(BaseModel):
    currency_code: str
    invoiced: Decimal
    paid: Decimal
    outstanding: Decimal
    overdue: Decimal


class ClientAccount(BaseModel):
    client: ClientRef
    balances: List[AccountBalance]  # per currency: nothing is converted or added across currencies
    invoices: List[InvoiceSummary]
    payments: List[PaymentWithInvoice]


InvoiceSummary.model_rebuild()
BillableLine.model_rebuild()


# =====================================================================================================
# Sales orders (Step 23)
# =====================================================================================================
OrderStatus = Literal["pending_reservation", "active", "delivered", "closed", "cancelled", "failed"]
ReservationStatus = Literal["pending", "reserved", "updating", "consumed", "released", "none"]


class OrderLineInput(BaseModel):
    """One product and the quantity the client wants. Name, SKU, unit and stock come from the Inventory Service, never from the caller."""

    model_config = ConfigDict(extra="forbid")

    product_id: uuid.UUID
    quantity: Quantity


class OrderLines(BaseModel):
    lines: List[OrderLineInput] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def _no_duplicate_products(self):
        ids = [l.product_id for l in self.lines]
        if len(ids) != len(set(ids)):
            raise ValueError("A product can appear only once in an order. Change its quantity instead.")
        return self


class OrderCreate(OrderLines):
    """Save a customer order: the client and the products required. Prices, discounts, tax and payment are not part of an order."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    client_id: uuid.UUID
    notes: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("notes")
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)


class OrderUpdate(OrderLines):
    """Change an active order: the COMPLETE list of products and quantities it should have afterwards. `version` is the version the
    editor saw: if somebody changed the order meanwhile the change is refused instead of overwriting theirs."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    version: int = Field(ge=1)
    notes: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("notes")
    @classmethod
    def _blank(cls, value: Optional[str]) -> Optional[str]:
        return blank_to_none(value)


class OrderCancel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Optional[int] = Field(default=None, ge=1)


class OrderStock(BaseModel):
    """The product's stock right now. `reserved_for_order` is the part of the reserved stock that belongs to THIS order line."""

    total_quantity: Decimal
    reserved_quantity: Decimal
    available_quantity: Decimal
    reserved_for_order: Decimal
    product_active: bool


class OrderLineResponse(BaseModel):
    id: uuid.UUID  # the order line = the delivery-list item
    product_id: uuid.UUID
    product_sku: str
    product_name: str
    unit: str
    unit_allows_fractions: Optional[bool] = None
    ordered_quantity: Decimal
    dispatched_quantity: Decimal  # confirmed dispatches only
    pending_quantity: Decimal  # on a dispatch that is being posted right now
    remaining_quantity: Decimal  # ordered - dispatched - pending
    stock: Optional[OrderStock] = None


class OrderListRef(BaseModel):
    id: uuid.UUID
    number: str
    status: Status


class OrderSummary(BaseModel):
    id: uuid.UUID
    number: str
    client: ClientRef
    delivery_list: OrderListRef
    status: OrderStatus
    reservation_status: ReservationStatus
    origin: Literal["order", "list"]
    version: int
    product_count: int
    # What the order is worth at the catalog's CURRENT selling prices (ordered quantity x price, one currency). Only the order LIST works it out; it is
    # None when the products use different currencies, a product is gone, or the Inventory Service could not be asked: never a guess.
    total_amount: Optional[Decimal] = None
    currency_code: Optional[str] = None
    created_by_email: str
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    cancelled_at: Optional[datetime] = None
    history_expires_at: Optional[datetime] = None  # delivered / closed orders: when they leave Delivered History (completed_at + 24 h)
    pending_action: Optional[str] = None
    last_error: Optional[str] = None
    notes: Optional[str] = None


class GeneratedInvoice(BaseModel):
    """The answer to Generate Invoice: the draft invoice, and whether it was made by this request (False: the order already had one)."""

    invoice: "InvoiceDetail"
    created: bool


class OrderDetail(OrderSummary):
    lines: List[OrderLineResponse]
    stock_status: Literal["ok", "unavailable"]
    dispatches: List["DispatchSummary"] = []
    can_edit: bool = False
    edit_blocked_reason: Optional[str] = None
    can_cancel: bool = False
    can_cancel_remaining: bool = False
    cancel_blocked_reason: Optional[str] = None
    can_dispatch: bool = False
    message: Optional[str] = None  # e.g. "The booking is not confirmed yet"


class OrderPage(BaseModel):
    items: List[OrderSummary]
    total: int
    limit: int
    offset: int
