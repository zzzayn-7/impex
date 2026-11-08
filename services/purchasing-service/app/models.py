import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.tenancy import TenantOwnedMixin


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()"))


class Supplier(TenantOwnedMixin, Base):
    """A company the organization buys from. Deactivated (never deleted) once purchase orders refer to it."""

    __tablename__ = "suppliers"
    __table_args__ = (
        # "Acme Ltd" and "acme  ltd" are the same supplier. Two organizations may have a supplier of the same name.
        UniqueConstraint("organization_id", "name_key", name="uq_suppliers_organization_id_name_key"),
        # The optional supplier code is unique per organization (NULLs do not clash).
        UniqueConstraint("organization_id", "code", name="uq_suppliers_organization_id_code"),
        UniqueConstraint("organization_id", "id", name="uq_suppliers_organization_id_id"),
        CheckConstraint("country_code IS NULL OR country_code ~ '^[A-Z]{2}$'", name="country_code_format"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    name_key: Mapped[str] = mapped_column(String(255), nullable=False)
    code: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    contact_person: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    address: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    country_code: Mapped[Optional[str]] = mapped_column(String(2), nullable=True)  # ISO 3166-1 alpha-2
    tax_identifier: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class PurchaseOrderCounter(TenantOwnedMixin, Base):
    """The last purchase-order number handed out to an organization (one row per organization)."""

    __tablename__ = "purchase_order_counters"
    __table_args__ = (UniqueConstraint("organization_id", name="uq_purchase_order_counters_organization_id"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    last_number: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))


class PurchaseOrder(TenantOwnedMixin, Base):
    """An order placed (or being prepared) with a supplier.

    A purchase order does NOT touch inventory: creating, editing, ordering or cancelling it never adds stock or writes a
    stock movement. Stock is added only by a CONFIRMED goods receipt (see GoodsReceipt), which moves the order on to
    Partially Received / Received. Once it is Ordered its commercial details are frozen by the database itself; a Cancelled
    order stays for history.
    """

    __tablename__ = "purchase_orders"
    __table_args__ = (
        UniqueConstraint("organization_id", "number", name="uq_purchase_orders_organization_id_number"),
        UniqueConstraint("organization_id", "id", name="uq_purchase_orders_organization_id_id"),
        ForeignKeyConstraint(["organization_id", "supplier_id"], ["suppliers.organization_id", "suppliers.id"],
                             name="fk_purchase_orders_supplier_same_organization", ondelete="RESTRICT"),
        CheckConstraint("status IN ('draft', 'ordered', 'partially_received', 'received', 'cancelled')", name="status_valid"),
        CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name="currency_code_format"),
        CheckConstraint("expected_delivery_date IS NULL OR expected_delivery_date >= order_date", name="expected_not_before_order"),
        Index("ix_purchase_orders_organization_id_supplier_id", "organization_id", "supplier_id"),
        Index("ix_purchase_orders_organization_id_status", "organization_id", "status"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    supplier_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    number: Mapped[str] = mapped_column(String(32), nullable=False)  # PO-000001, unique per organization
    supplier_reference: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    order_date: Mapped[date] = mapped_column(Date, nullable=False)
    expected_delivery_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", server_default=text("'draft'"))
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    created_by_email: Mapped[str] = mapped_column(String(320), nullable=False)
    ordered_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    ordered_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class PurchaseOrderRequest(TenantOwnedMixin, Base):
    """One create-order REQUEST, identified by its Idempotency-Key. A retry or a double click finds this row and gets the
    same purchase order back instead of creating a second one."""

    __tablename__ = "purchase_order_requests"
    __table_args__ = (
        UniqueConstraint("organization_id", "idempotency_key", name="uq_purchase_order_requests_organization_id_idempotency_key"),
        ForeignKeyConstraint(["organization_id", "purchase_order_id"], ["purchase_orders.organization_id", "purchase_orders.id"],
                             name="fk_purchase_order_requests_purchase_order_same_organization", ondelete="RESTRICT"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    idempotency_key: Mapped[str] = mapped_column(String(100), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    purchase_order_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class PurchaseOrderLine(TenantOwnedMixin, Base):
    """One product line. At most one line per product (database-enforced).

    product_id refers to the Inventory Service's product (another database, so no foreign key); it is revalidated against
    that service whenever it is added, changed or ordered. SKU, name and unit are SNAPSHOTS taken from the Inventory
    Service, never values sent by the browser. line_total is always round(quantity * unit_price, 4): the database checks it.
    """

    __tablename__ = "purchase_order_lines"
    __table_args__ = (
        UniqueConstraint("organization_id", "purchase_order_id", "product_id", name="uq_purchase_order_lines_order_product"),
        UniqueConstraint("organization_id", "id", name="uq_purchase_order_lines_organization_id_id"),
        ForeignKeyConstraint(["organization_id", "purchase_order_id"], ["purchase_orders.organization_id", "purchase_orders.id"],
                             name="fk_purchase_order_lines_purchase_order_same_organization", ondelete="CASCADE"),
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("unit_price >= 0", name="unit_price_non_negative"),
        CheckConstraint("line_total = round(quantity * unit_price, 4)", name="line_total_matches"),
        Index("ix_purchase_order_lines_organization_id_purchase_order_id", "organization_id", "purchase_order_id"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    purchase_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    product_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    product_sku: Mapped[str] = mapped_column(String(64), nullable=False)
    product_name: Mapped[str] = mapped_column(String(255), nullable=False)
    unit: Mapped[str] = mapped_column(String(20), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    line_total: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class GoodsReceiptCounter(TenantOwnedMixin, Base):
    """The last goods-receipt number handed out to an organization (one row per organization)."""

    __tablename__ = "goods_receipt_counters"
    __table_args__ = (UniqueConstraint("organization_id", name="uq_goods_receipt_counters_organization_id"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    last_number: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))


class GoodsReceipt(TenantOwnedMixin, Base):
    """Goods that arrived against a purchase order: a draft is prepared, then confirmed.

    draft -> posting -> confirmed        (or draft -> cancelled; posting -> draft after a definitive rejection by Inventory)

    * draft: freely editable; changes NO stock.
    * posting: the intent to add the accepted quantities to stock is saved (and the order's receivable quantity is reserved)
      BEFORE the Inventory Service is called, with the stable Idempotency-Key `posting_key`. It stays here if the outcome is
      unknown (timeout, crash, outage); a retry uses the same key, so the goods are added at most once.
    * confirmed: the Inventory Service's answer was verified and every accepted line carries its movement id. Immutable.
    The database enforces these moves and the immutability (see migration 0002), not just this application.
    """

    __tablename__ = "goods_receipts"
    __table_args__ = (
        UniqueConstraint("organization_id", "number", name="uq_goods_receipts_organization_id_number"),
        UniqueConstraint("organization_id", "id", name="uq_goods_receipts_organization_id_id"),
        UniqueConstraint("organization_id", "posting_key", name="uq_goods_receipts_organization_id_posting_key"),
        ForeignKeyConstraint(["organization_id", "purchase_order_id"], ["purchase_orders.organization_id", "purchase_orders.id"],
                             name="fk_goods_receipts_purchase_order_same_organization", ondelete="RESTRICT"),
        CheckConstraint("status IN ('draft', 'posting', 'confirmed', 'cancelled')", name="status_valid"),
        CheckConstraint("posting_key = 'goods-receipt-' || CAST(id AS text)", name="posting_key_from_id"),
        CheckConstraint("posting_attempts >= 0", name="posting_attempts_non_negative"),
        CheckConstraint(
            "(status = 'confirmed') = (inventory_operation_id IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_by_email IS NOT NULL)",
            name="confirmed_only_when_posted",
        ),
        CheckConstraint("status = 'confirmed' OR (inventory_operation_id IS NULL AND confirmed_at IS NULL AND confirmed_by_email IS NULL)",
                        name="nothing_confirmed_before_confirmation"),
        CheckConstraint("status <> 'cancelled' OR cancelled_at IS NOT NULL", name="cancelled_has_time"),
        CheckConstraint("status <> 'posting' OR posting_started_at IS NOT NULL", name="posting_has_intent_time"),
        Index("ix_goods_receipts_organization_id_purchase_order_id", "organization_id", "purchase_order_id"),
        Index("ix_goods_receipts_organization_id_status", "organization_id", "status"),
        Index("ix_goods_receipts_organization_id_received_date", "organization_id", "received_date"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    purchase_order_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    number: Mapped[str] = mapped_column(String(32), nullable=False)  # GR-000001, unique per organization
    supplier_reference: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # e.g. the supplier's delivery note
    received_date: Mapped[date] = mapped_column(Date, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", server_default=text("'draft'"))
    posting_key: Mapped[str] = mapped_column(String(100), nullable=False)  # 'goods-receipt-<id>': the Inventory Idempotency-Key
    posting_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    posting_started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_posting_attempt_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_posting_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    inventory_operation_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    created_by_email: Mapped[str] = mapped_column(String(320), nullable=False)
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    confirmed_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class GoodsReceiptRequest(TenantOwnedMixin, Base):
    """One create-receipt REQUEST (by Idempotency-Key): a double click returns the same draft instead of a second one."""

    __tablename__ = "goods_receipt_requests"
    __table_args__ = (
        UniqueConstraint("organization_id", "idempotency_key", name="uq_goods_receipt_requests_organization_id_idempotency_key"),
        ForeignKeyConstraint(["organization_id", "goods_receipt_id"], ["goods_receipts.organization_id", "goods_receipts.id"],
                             name="fk_goods_receipt_requests_goods_receipt_same_organization", ondelete="RESTRICT"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    idempotency_key: Mapped[str] = mapped_column(String(100), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    goods_receipt_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class GoodsReceiptLine(TenantOwnedMixin, Base):
    """What arrived of one purchase-order line: the accepted quantity (the only one that becomes stock), and
    an optional informational rejected quantity (never stock). Product, SKU, name and unit are copied from the order line and
    can never differ from it (database-enforced): a quantity is never converted between units."""

    __tablename__ = "goods_receipt_lines"
    __table_args__ = (
        UniqueConstraint("organization_id", "goods_receipt_id", "purchase_order_line_id", name="uq_goods_receipt_lines_receipt_order_line"),
        ForeignKeyConstraint(["organization_id", "goods_receipt_id"], ["goods_receipts.organization_id", "goods_receipts.id"],
                             name="fk_goods_receipt_lines_goods_receipt_same_organization", ondelete="RESTRICT"),
        ForeignKeyConstraint(["organization_id", "purchase_order_line_id"], ["purchase_order_lines.organization_id", "purchase_order_lines.id"],
                             name="fk_goods_receipt_lines_purchase_order_line_same_organization", ondelete="RESTRICT"),
        CheckConstraint("accepted_quantity >= 0", name="accepted_non_negative"),
        CheckConstraint("rejected_quantity >= 0", name="rejected_non_negative"),
        CheckConstraint("accepted_quantity + rejected_quantity > 0", name="something_received"),
        CheckConstraint("inventory_movement_id IS NULL OR accepted_quantity > 0", name="movement_only_when_accepted"),
        Index("ix_goods_receipt_lines_organization_id_goods_receipt_id", "organization_id", "goods_receipt_id"),
        Index("ix_goods_receipt_lines_organization_id_purchase_order_line_id", "organization_id", "purchase_order_line_id"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    goods_receipt_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    purchase_order_line_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    product_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    product_sku: Mapped[str] = mapped_column(String(64), nullable=False)
    product_name: Mapped[str] = mapped_column(String(255), nullable=False)
    unit: Mapped[str] = mapped_column(String(20), nullable=False)
    accepted_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=0, server_default=text("0"))
    rejected_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=0, server_default=text("0"))
    notes: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    inventory_movement_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)  # set when the posting is verified
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
