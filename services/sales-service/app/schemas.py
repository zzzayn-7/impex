"""Request and response models.

Write models forbid unknown fields, so an `organization_id`, a `status`, a product name or SKU, a stock quantity or any
other value the caller must not decide is refused with 422 instead of being silently ignored.
"""
import re
import uuid
from datetime import datetime
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
Status = Literal["draft", "ready", "cancelled"]


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
    stock_notice: str = STOCK_NOTICE


class ItemResult(BaseModel):
    """An item as saved, plus the list's new item count."""

    item: ItemResponse
    item_count: int
    stock_notice: str = STOCK_NOTICE
