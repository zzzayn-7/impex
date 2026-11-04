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
    stock movement (receiving goods is a later step). Once it is Ordered its commercial details are frozen by the
    database itself; a Cancelled order stays for history.
    """

    __tablename__ = "purchase_orders"
    __table_args__ = (
        UniqueConstraint("organization_id", "number", name="uq_purchase_orders_organization_id_number"),
        UniqueConstraint("organization_id", "id", name="uq_purchase_orders_organization_id_id"),
        ForeignKeyConstraint(["organization_id", "supplier_id"], ["suppliers.organization_id", "suppliers.id"],
                             name="fk_purchase_orders_supplier_same_organization", ondelete="RESTRICT"),
        CheckConstraint("status IN ('draft', 'ordered', 'cancelled')", name="status_valid"),
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
    planned_warehouse_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    planned_warehouse_code: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)  # snapshot, for display
    notes: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
