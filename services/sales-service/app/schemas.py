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
    planned_warehouse_id: Optional[uuid.UUID] = None


class ItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quantity: Optional[Quantity] = None
    planned_warehouse_id: Optional[uuid.UUID] = None  # send null to clear it

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
    """What the Inventory Service says right now. Information only: stock is NOT reserved."""

    total_quantity: Decimal
    available_quantity: Decimal
    product_active: bool
    unit_allows_fractions: bool
    exceeds_available: bool
    shortfall: Decimal  # how much more is wanted than is available (0 when it fits)


class ItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    product_id: uuid.UUID
    product_sku: str
    product_name: str
    quantity: Decimal
    unit: str
    planned_warehouse_id: Optional[uuid.UUID]
    planned_warehouse_code: Optional[str]
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


class DeliveryListPage(BaseModel):
    items: List[DeliveryListSummary]
    total: int
    limit: int
    offset: int


STOCK_NOTICE = (
    "Stock is not reserved by a delivery list. Saving it, marking it Ready or cancelling it never changes inventory, and "
    "the quantities on hand may change before dispatch."
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
    """A quantity of one delivery-list item leaving one warehouse. Product, SKU, name and unit come from the item, never from the caller."""

    model_config = ConfigDict(extra="forbid")

    delivery_list_item_id: uuid.UUID
    warehouse_id: uuid.UUID
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
    warehouse_id: uuid.UUID
    warehouse_code: Optional[str]
    quantity: Decimal
    inventory_movement_id: Optional[uuid.UUID]  # the Inventory Service's stock movement, once confirmed
    available_in_warehouse: Optional[Decimal] = None  # live stock of this product there (information only: not reserved)


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
    lines_exceeding_stock: int  # lines whose quantity is more than the warehouse holds right now (a draft only)
    stock_notice: str = DISPATCH_NOTICE


class DispatchPage(BaseModel):
    items: List[DispatchSummary]
    total: int
    limit: int
    offset: int


DeliveryListDetail.model_rebuild()
