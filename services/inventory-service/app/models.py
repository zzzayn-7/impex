import uuid
from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKeyConstraint,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.tenancy import TenantOwnedMixin


class Product(TenantOwnedMixin, Base):
    """A catalog product. It always belongs to exactly one organization (organization_id, never client-supplied).

    Prices are NUMERIC(14,4): exact decimals, never floating point. Quantities/stock are intentionally absent.
    """

    __tablename__ = "products"
    __table_args__ = (
        # The SKU is unique within an organization; two organizations may use the same SKU.
        UniqueConstraint("organization_id", "sku", name="uq_products_organization_id_sku"),
        # Lets stock rows reference (organization_id, id), so the database itself guarantees that a stock row
        # and the product it points at belong to the same organization.
        UniqueConstraint("organization_id", "id", name="uq_products_organization_id_id"),
        CheckConstraint("cost_price >= 0", name="cost_price_non_negative"),
        CheckConstraint("selling_price >= 0", name="selling_price_non_negative"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()")
    )
    sku: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    unit: Mapped[str] = mapped_column(String(20), nullable=False)  # unit of measurement: pcs, kg, m, ...
    hs_code: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)  # customs Harmonized System code
    cost_price: Mapped[Decimal] = mapped_column(Numeric(14, 4), nullable=False)
    selling_price: Mapped[Decimal] = mapped_column(Numeric(14, 4), nullable=False)
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False)  # ISO 4217, e.g. USD
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class StockOperation(TenantOwnedMixin, Base):
    """One stock-changing REQUEST, identified by its Idempotency-Key. A retry finds this row and replays the result."""

    __tablename__ = "stock_operations"
    __table_args__ = (
        UniqueConstraint("organization_id", "idempotency_key", name="uq_stock_operations_organization_id_idempotency_key"),
        UniqueConstraint("organization_id", "id", name="uq_stock_operations_organization_id_id"),
        CheckConstraint("kind IN ('opening', 'in', 'out', 'receipt', 'dispatch', 'reserve', 'release')", name="kind_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()")
    )
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(100), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)  # fingerprint of the request body
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    result: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)  # reservations: the first answer, replayed on a retry


class StockBalance(TenantOwnedMixin, Base):
    """How much of a product the organization has in stock. Never negative (CHECK), changed only together with a movement.

    `reserved_quantity` is the part of it committed to active sales orders (see StockReservation). Available = quantity - reserved.
    The database guarantees 0 <= reserved_quantity <= quantity, so no operation can take stock that an order has booked."""

    __tablename__ = "stock_balances"
    __table_args__ = (
        UniqueConstraint("organization_id", "product_id", name="uq_stock_balances_organization_id_product_id"),
        # Same-organization guarantee: the product must belong to this row's organization.
        ForeignKeyConstraint(["organization_id", "product_id"], ["products.organization_id", "products.id"],
                             name="fk_stock_balances_product_same_organization", ondelete="RESTRICT"),
        CheckConstraint("quantity >= 0", name="quantity_non_negative"),
        CheckConstraint("reserved_quantity >= 0", name="reserved_non_negative"),
        CheckConstraint("reserved_quantity <= quantity", name="reserved_within_stock"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()")
    )
    product_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=0, server_default=text("0"))
    reserved_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=0, server_default=text("0"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class StockReservation(TenantOwnedMixin, Base):
    """Stock committed to ONE line of a sales order. Owned by the Inventory Service (the Sales Service only asks for changes).

    original = consumed + released + remaining, always (CHECK). `remaining_quantity` is what is still held back from sale:
      * a CONFIRMED dispatch of the line consumes it (stock leaves and the reservation shrinks in the same transaction);
      * reducing or cancelling the order releases it.
    status: active (remaining > 0), fulfilled (nothing left, something was dispatched), released (nothing left, nothing dispatched).
    """

    __tablename__ = "stock_reservations"
    __table_args__ = (
        UniqueConstraint("organization_id", "source_type", "source_line_id", name="uq_stock_reservations_source_line"),
        ForeignKeyConstraint(["organization_id", "product_id"], ["products.organization_id", "products.id"],
                             name="fk_stock_reservations_product_same_organization", ondelete="RESTRICT"),
        CheckConstraint("source_type = 'sales_order'", name="source_type_valid"),
        CheckConstraint("original_quantity > 0", name="original_positive"),
        CheckConstraint("consumed_quantity >= 0 AND released_quantity >= 0 AND remaining_quantity >= 0", name="quantities_non_negative"),
        CheckConstraint("original_quantity = consumed_quantity + released_quantity + remaining_quantity", name="quantities_add_up"),
        CheckConstraint(
            "(status = 'active' AND remaining_quantity > 0) OR "
            "(status = 'fulfilled' AND remaining_quantity = 0 AND consumed_quantity > 0) OR "
            "(status = 'released' AND remaining_quantity = 0 AND consumed_quantity = 0)",
            name="status_consistent",
        ),
        Index("ix_stock_reservations_organization_id_source_id", "organization_id", "source_id"),
        Index("ix_stock_reservations_organization_id_product_id_active", "organization_id", "product_id", postgresql_where=text("status = 'active'")),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()"))
    product_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    source_type: Mapped[str] = mapped_column(String(30), nullable=False, default="sales_order")
    source_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)  # the sales order
    source_reference: Mapped[str] = mapped_column(String(32), nullable=False)  # its number, SO-000001 (display only)
    source_line_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)  # the order line (the delivery-list item)
    original_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    consumed_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=0, server_default=text("0"))
    released_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=0, server_default=text("0"))
    remaining_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="active", server_default=text("'active'"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class StockMovement(TenantOwnedMixin, Base):
    """The append-only stock ledger. Rows are only ever inserted: a database trigger rejects UPDATE and DELETE.

    `quantity` is always positive; the direction comes from `movement_type` (opening and in add, out subtracts).
    """

    __tablename__ = "stock_movements"
    __table_args__ = (
        ForeignKeyConstraint(["organization_id", "product_id"], ["products.organization_id", "products.id"],
                             name="fk_stock_movements_product_same_organization", ondelete="RESTRICT"),
        ForeignKeyConstraint(["organization_id", "operation_id"], ["stock_operations.organization_id", "stock_operations.id"],
                             name="fk_stock_movements_operation_same_organization", ondelete="RESTRICT"),
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("balance_after >= 0", name="balance_after_non_negative"),
        CheckConstraint("movement_type IN ('opening', 'in', 'out')", name="movement_type_valid"),
        # where a movement came from, when another service caused it (a goods receipt line); all three or none
        CheckConstraint(
            "(source_type IS NULL AND source_reference IS NULL AND source_line_id IS NULL) OR "
            "(source_type = 'goods_receipt' AND movement_type = 'in' AND source_reference IS NOT NULL AND source_line_id IS NOT NULL) OR "
            "(source_type = 'client_dispatch' AND movement_type = 'out' AND source_reference IS NOT NULL AND source_line_id IS NOT NULL)",
            name="source_consistent",
        ),
        # one source line can produce at most one movement: received goods can never be added twice
        Index("uq_stock_movements_source_line", "organization_id", "source_type", "source_line_id", unique=True,
              postgresql_where=text("source_line_id IS NOT NULL")),
        Index("ix_stock_movements_organization_id_created_at", "organization_id", "created_at"),
        Index("ix_stock_movements_organization_id_product_id_created_at", "organization_id", "product_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()")
    )
    operation_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    product_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    movement_type: Mapped[str] = mapped_column(String(20), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    balance_after: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)  # the product's stock right after this movement
    reason: Mapped[str] = mapped_column(String(255), nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    created_by_email: Mapped[str] = mapped_column(String(320), nullable=False)  # snapshot: survives account changes
    source_type: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)  # 'goods_receipt', 'client_dispatch' or None
    source_reference: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # e.g. the receipt number GR-000001 or the dispatch number DS-000001
    source_line_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)  # the receipt / dispatch line in the other service
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ProductIdentifier(TenantOwnedMixin, Base):
    """A scannable code that resolves to one product of one organization.

    kind 'generated'    the Impex code printed on labels (QR and Code 128). Random, so it is independent of the SKU.
    kind 'manufacturer' / 'supplier'   a barcode that already exists on the goods (EAN, UPC, Code 128, ...).

    `value` is stored normalized (upper case, no spaces) and is UNIQUE per organization, so one code can never mean two
    products. A code is retired (is_active = false), never deleted or re-pointed; a trigger enforces both, so a code
    cannot silently move to another product.
    """

    __tablename__ = "product_identifiers"
    __table_args__ = (
        UniqueConstraint("organization_id", "value", name="uq_product_identifiers_organization_id_value"),
        ForeignKeyConstraint(["organization_id", "product_id"], ["products.organization_id", "products.id"],
                             name="fk_product_identifiers_product_same_organization", ondelete="RESTRICT"),
        CheckConstraint("kind IN ('generated', 'manufacturer', 'supplier')", name="kind_valid"),
        CheckConstraint("value ~ '^[A-Z0-9][A-Z0-9._:/+-]{0,63}$'", name="value_format"),
        Index("ix_product_identifiers_organization_id_product_id", "organization_id", "product_id"),
        # at most one generated code per product (so "generate" is repeatable and stable)
        Index("uq_product_identifiers_one_generated_per_product", "organization_id", "product_id", unique=True,
              postgresql_where=text("kind = 'generated'")),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()")
    )
    product_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    value: Mapped[str] = mapped_column(String(64), nullable=False)
    label: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # e.g. the supplier's name
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))
    created_by_email: Mapped[str] = mapped_column(String(320), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    retired_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
