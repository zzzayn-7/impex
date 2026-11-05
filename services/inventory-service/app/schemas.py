import re
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator

from app.units import allows_fractions

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
    # True once the product has stock movements: its unit of measurement can no longer be changed.
    unit_locked: bool = False

    @computed_field  # the portal asks the service instead of keeping its own list of units
    @property
    def unit_allows_fractions(self) -> bool:
        return allows_fractions(self.unit)


class ProductList(BaseModel):
    items: List[ProductResponse]
    total: int  # all matches for the filters, ignoring limit/offset
    limit: int
    offset: int


# =====================================================================================================
# Warehouses
# =====================================================================================================
CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9._-]{0,31}$")


class WarehouseFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("code", check_fields=False)
    @classmethod
    def _normalize_code(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        value = value.upper()  # "main" and "MAIN" are the same warehouse code
        if not CODE_RE.match(value):
            raise ValueError("Code may contain only letters, digits and . _ - (max 32 characters)")
        return value

    @field_validator("address", check_fields=False)
    @classmethod
    def _blank_address_to_none(cls, value: Optional[str]) -> Optional[str]:
        return None if value is None or value == "" else value


class WarehouseCreate(WarehouseFields):
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=255)
    address: Optional[str] = Field(default=None, max_length=500)


class WarehouseUpdate(WarehouseFields):
    """Partial update: only the fields that are sent change."""

    code: Optional[str] = Field(default=None, min_length=1, max_length=32)
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    address: Optional[str] = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def _at_least_one_and_no_nulls(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to change.")
        for field in ("code", "name"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be empty")
        return self


class WarehouseResponse(BaseModel):
    """A warehouse as the tenant sees it. No organization_id is exposed."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    name: str
    address: Optional[str]
    is_active: bool
    created_at: datetime
    updated_at: datetime
    products_in_stock: int = 0  # how many products currently have stock here (archive/restore hint)


class WarehouseList(BaseModel):
    items: List[WarehouseResponse]
    total: int
    limit: int
    offset: int


# =====================================================================================================
# Stock
# =====================================================================================================
# Exact decimals again: at most 14 digits before and 4 after the point, strictly positive.
Quantity = Annotated[Decimal, Field(gt=0, max_digits=18, decimal_places=4)]
MovementType = Literal["opening", "in", "out", "transfer_out", "transfer_in"]


class StockChange(BaseModel):
    """Opening balance, stock-in or stock-out of one product in one warehouse. No organization field exists."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    product_id: uuid.UUID
    warehouse_id: uuid.UUID
    quantity: Quantity
    reason: Optional[str] = Field(default=None, max_length=255)

    @field_validator("reason")
    @classmethod
    def _blank_reason_to_none(cls, value: Optional[str]) -> Optional[str]:
        return None if value == "" else value


class StockTransfer(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    product_id: uuid.UUID
    from_warehouse_id: uuid.UUID
    to_warehouse_id: uuid.UUID
    quantity: Quantity
    reason: Optional[str] = Field(default=None, max_length=255)

    @field_validator("reason")
    @classmethod
    def _blank_reason_to_none(cls, value: Optional[str]) -> Optional[str]:
        return None if value == "" else value


class MovementResponse(BaseModel):
    id: uuid.UUID
    operation_id: uuid.UUID
    product_id: uuid.UUID
    product_sku: str
    product_name: str
    product_unit: str
    unit_allows_fractions: bool
    warehouse_id: uuid.UUID
    warehouse_code: str
    warehouse_name: str
    movement_type: MovementType
    quantity: Decimal
    balance_after: Decimal
    reason: str
    transfer_id: Optional[uuid.UUID]
    created_by_email: str
    source_type: Optional[str] = None
    source_reference: Optional[str] = None
    created_at: datetime


class MovementList(BaseModel):
    items: List[MovementResponse]
    total: int
    limit: int
    offset: int


class StockOperationResult(BaseModel):
    operation_id: uuid.UUID
    kind: Literal["opening", "in", "out", "transfer"]
    replayed: bool  # true when this was a retry of an earlier request with the same Idempotency-Key
    movements: List[MovementResponse]


class StockLine(BaseModel):
    warehouse_id: uuid.UUID
    warehouse_code: str
    warehouse_name: str
    warehouse_active: bool
    quantity: Decimal


class StockProduct(BaseModel):
    product_id: uuid.UUID
    sku: str
    name: str
    category: str
    unit: str
    unit_allows_fractions: bool
    is_active: bool
    total_quantity: Decimal  # across every warehouse that holds it
    available_quantity: Decimal  # only warehouses that are active
    lines: List[StockLine]


class StockOverview(BaseModel):
    items: List[StockProduct]
    total: int
    limit: int
    offset: int


class StockSummary(BaseModel):
    """Details and stock for specific products. Ids that are not the caller's products are simply absent."""

    items: List[StockProduct]


# =====================================================================================================
# Scannable codes (QR / Code 128 / supplier barcodes) and scan lookup
# =====================================================================================================
class IdentifierCreate(BaseModel):
    """Attach a manufacturer or supplier barcode to a product. No organization or product field: the product is in the URL."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    kind: Literal["manufacturer", "supplier"]
    value: str = Field(min_length=1, max_length=64)
    label: Optional[str] = Field(default=None, max_length=100)

    @field_validator("label")
    @classmethod
    def _blank_label_to_none(cls, value: Optional[str]) -> Optional[str]:
        return None if value == "" else value


class IdentifierResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    product_id: uuid.UUID
    kind: Literal["generated", "manufacturer", "supplier"]
    value: str
    label: Optional[str]
    is_active: bool
    created_by_email: str
    created_at: datetime
    retired_at: Optional[datetime]


class IdentifierList(BaseModel):
    items: List[IdentifierResponse]


class LabelProduct(BaseModel):
    id: uuid.UUID
    sku: str
    name: str
    unit: str


class LabelResponse(BaseModel):
    """Everything needed to print one product label. The SVGs are generated here; the QR contains `code` as plain text."""

    product: LabelProduct
    identifier: IdentifierResponse
    code: str
    qr_svg: str
    barcode_svg: str


class ScanResult(BaseModel):
    """What a scanned code means for the caller's organization, including current stock. Reading only: nothing changes."""

    matched_by: Literal["identifier", "sku"]
    identifier_kind: Optional[Literal["generated", "manufacturer", "supplier"]]
    product: ProductResponse
    stock: StockProduct


# =====================================================================================================
# Goods-receipt posting (Step 16B): stock-in for goods received against a purchase order of another service
# =====================================================================================================
class ReceiptLine(BaseModel):
    """One accepted quantity of one product into one warehouse. `unit` is the unit the buyer ordered in: the posting is refused
    if the product's current unit differs, so a quantity is never silently reinterpreted."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    line_id: uuid.UUID  # the receipt line in the calling service: a line can be posted only once, ever
    product_id: uuid.UUID
    warehouse_id: uuid.UUID
    quantity: Quantity
    unit: str = Field(min_length=1, max_length=20)


class ReceiptPost(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    receipt_number: str = Field(min_length=1, max_length=32)
    purchase_order_number: Optional[str] = Field(default=None, max_length=32)
    lines: List[ReceiptLine] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def _no_repeated_lines(self):
        ids = [l.line_id for l in self.lines]
        if len(ids) != len(set(ids)):
            raise ValueError("A receipt line can appear only once.")
        return self


class ReceiptMovement(BaseModel):
    id: uuid.UUID
    line_id: uuid.UUID
    product_id: uuid.UUID
    warehouse_id: uuid.UUID
    quantity: Decimal
    balance_after: Decimal


class ReceiptPosting(BaseModel):
    operation_id: uuid.UUID
    receipt_number: str
    replayed: bool  # true when this was a retry of an earlier posting with the same Idempotency-Key
    movements: List[ReceiptMovement]


# =====================================================================================================
# Client-dispatch posting (Step 17A): stock-out for goods dispatched against a delivery list of the Sales Service
# =====================================================================================================
class DispatchLine(ReceiptLine):
    """One quantity of one product leaving one warehouse. `line_id` is the dispatch line in the Sales Service: it can be posted
    only once, ever. `unit` must equal the product's current unit (a quantity is never reinterpreted)."""


class DispatchPost(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    dispatch_number: str = Field(min_length=1, max_length=32)
    delivery_list_number: Optional[str] = Field(default=None, max_length=32)
    lines: List[DispatchLine] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def _no_repeated_lines(self):
        ids = [l.line_id for l in self.lines]
        if len(ids) != len(set(ids)):
            raise ValueError("A dispatch line can appear only once.")
        return self


class DispatchPosting(BaseModel):
    operation_id: uuid.UUID
    dispatch_number: str
    replayed: bool  # true when this was a retry of an earlier posting with the same Idempotency-Key
    movements: List[ReceiptMovement]
