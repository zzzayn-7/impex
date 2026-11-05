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


class Client(TenantOwnedMixin, Base):
    """A customer of the organization. Deactivated (never deleted) once delivery lists refer to it."""

    __tablename__ = "clients"
    __table_args__ = (
        # "Acme Ltd" and "acme  ltd" are the same client. Two organizations may have a client of the same name.
        UniqueConstraint("organization_id", "name_key", name="uq_clients_organization_id_name_key"),
        # Target of the same-organization composite foreign key of delivery_lists.
        UniqueConstraint("organization_id", "id", name="uq_clients_organization_id_id"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    name_key: Mapped[str] = mapped_column(String(255), nullable=False)  # normalized name, for the uniqueness rule
    contact_person: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    address: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class DeliveryListCounter(TenantOwnedMixin, Base):
    """The last delivery-list number handed out to an organization (one row per organization)."""

    __tablename__ = "delivery_list_counters"
    __table_args__ = (UniqueConstraint("organization_id", name="uq_delivery_list_counters_organization_id"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    last_number: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))


class DeliveryList(TenantOwnedMixin, Base):
    """Products promised to a client, waiting for delivery.

    A delivery list does NOT touch inventory: saving it, marking it Ready or cancelling it never deducts or reserves
    stock. Stock is deducted only when a DISPATCH against the list is confirmed (see Dispatch), which moves the list on to
    Partially Dispatched / Dispatched. Once any dispatch exists the list can no longer be reopened for editing.
    """

    __tablename__ = "delivery_lists"
    __table_args__ = (
        UniqueConstraint("organization_id", "number", name="uq_delivery_lists_organization_id_number"),
        UniqueConstraint("organization_id", "id", name="uq_delivery_lists_organization_id_id"),
        # Same-organization guarantee: the client must belong to this row's organization.
        ForeignKeyConstraint(["organization_id", "client_id"], ["clients.organization_id", "clients.id"],
                             name="fk_delivery_lists_client_same_organization", ondelete="RESTRICT"),
        CheckConstraint("status IN ('draft', 'ready', 'partially_dispatched', 'dispatched', 'cancelled')", name="status_valid"),
        Index("ix_delivery_lists_organization_id_client_id", "organization_id", "client_id"),
        Index("ix_delivery_lists_organization_id_status", "organization_id", "status"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    client_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    number: Mapped[str] = mapped_column(String(32), nullable=False)  # DL-000001, unique per organization
    external_reference: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", server_default=text("'draft'"))
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    created_by_email: Mapped[str] = mapped_column(String(320), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class DeliveryListItem(TenantOwnedMixin, Base):
    """One product line of a delivery list. At most one line per product (database-enforced).

    product_id refers to the Inventory Service's product (a different database, so no foreign key); it is revalidated
    against that service whenever it is added or used. SKU, name and unit are SNAPSHOTS taken from the Inventory Service
    for display, never values sent by the browser.
    """

    __tablename__ = "delivery_list_items"
    __table_args__ = (
        UniqueConstraint("organization_id", "delivery_list_id", "product_id", name="uq_delivery_list_items_list_product"),
        UniqueConstraint("organization_id", "id", name="uq_delivery_list_items_organization_id_id"),
        ForeignKeyConstraint(["organization_id", "delivery_list_id"], ["delivery_lists.organization_id", "delivery_lists.id"],
                             name="fk_delivery_list_items_delivery_list_same_organization", ondelete="CASCADE"),
        CheckConstraint("quantity > 0", name="quantity_positive"),
        Index("ix_delivery_list_items_organization_id_delivery_list_id", "organization_id", "delivery_list_id"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    delivery_list_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    product_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    product_sku: Mapped[str] = mapped_column(String(64), nullable=False)
    product_name: Mapped[str] = mapped_column(String(255), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    unit: Mapped[str] = mapped_column(String(20), nullable=False)
    planned_warehouse_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    planned_warehouse_code: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)  # snapshot, for display
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class DispatchCounter(TenantOwnedMixin, Base):
    """The last dispatch number handed out to an organization (one row per organization)."""

    __tablename__ = "dispatch_counters"
    __table_args__ = (UniqueConstraint("organization_id", name="uq_dispatch_counters_organization_id"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    last_number: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))


class Dispatch(TenantOwnedMixin, Base):
    """Goods leaving for a client against a delivery list: prepared as a draft, then confirmed. Several per list.

    draft -> posting -> confirmed        (or draft -> cancelled; posting -> draft after a definitive rejection by Inventory)

    * draft: freely editable; changes NO stock.
    * posting: the intent to deduct stock is saved (and the list's dispatchable quantity is reserved) BEFORE the Inventory
      Service is called, with the stable Idempotency-Key `posting_key`. It stays here if the outcome is unknown (timeout,
      crash, outage); a retry uses the same key, so the goods are deducted at most once.
    * confirmed: the Inventory Service's answer was verified and every line carries its movement id. Immutable.
    The database enforces these moves and the immutability (see migration 0002), not just this application.
    """

    __tablename__ = "dispatches"
    __table_args__ = (
        UniqueConstraint("organization_id", "number", name="uq_dispatches_organization_id_number"),
        UniqueConstraint("organization_id", "id", name="uq_dispatches_organization_id_id"),
        UniqueConstraint("organization_id", "posting_key", name="uq_dispatches_organization_id_posting_key"),
        ForeignKeyConstraint(["organization_id", "delivery_list_id"], ["delivery_lists.organization_id", "delivery_lists.id"],
                             name="fk_dispatches_delivery_list_same_organization", ondelete="RESTRICT"),
        ForeignKeyConstraint(["organization_id", "client_id"], ["clients.organization_id", "clients.id"],
                             name="fk_dispatches_client_same_organization", ondelete="RESTRICT"),
        CheckConstraint("status IN ('draft', 'posting', 'confirmed', 'cancelled')", name="status_valid"),
        CheckConstraint("posting_key = 'dispatch-' || CAST(id AS text)", name="posting_key_from_id"),
        CheckConstraint("posting_attempts >= 0", name="posting_attempts_non_negative"),
        CheckConstraint(
            "(status = 'confirmed') = (inventory_operation_id IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_by_email IS NOT NULL)",
            name="confirmed_only_when_posted",
        ),
        CheckConstraint("status = 'confirmed' OR (inventory_operation_id IS NULL AND confirmed_at IS NULL AND confirmed_by_email IS NULL)",
                        name="nothing_confirmed_before_confirmation"),
        CheckConstraint("status <> 'cancelled' OR cancelled_at IS NOT NULL", name="cancelled_has_time"),
        CheckConstraint("status <> 'posting' OR posting_started_at IS NOT NULL", name="posting_has_intent_time"),
        Index("ix_dispatches_organization_id_delivery_list_id", "organization_id", "delivery_list_id"),
        Index("ix_dispatches_organization_id_client_id", "organization_id", "client_id"),
        Index("ix_dispatches_organization_id_status", "organization_id", "status"),
        Index("ix_dispatches_organization_id_dispatch_date", "organization_id", "dispatch_date"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    delivery_list_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    client_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)  # always the client of the delivery list (database-checked)
    number: Mapped[str] = mapped_column(String(32), nullable=False)  # DS-000001, unique per organization
    dispatch_date: Mapped[date] = mapped_column(Date, nullable=False)
    delivery_address: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    transport_details: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    tracking_reference: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", server_default=text("'draft'"))
    posting_key: Mapped[str] = mapped_column(String(100), nullable=False)  # 'dispatch-<id>': the Inventory Idempotency-Key
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


class DispatchRequest(TenantOwnedMixin, Base):
    """One create-dispatch REQUEST (by Idempotency-Key): a double click returns the same draft instead of a second one."""

    __tablename__ = "dispatch_requests"
    __table_args__ = (
        UniqueConstraint("organization_id", "idempotency_key", name="uq_dispatch_requests_organization_id_idempotency_key"),
        ForeignKeyConstraint(["organization_id", "dispatch_id"], ["dispatches.organization_id", "dispatches.id"],
                             name="fk_dispatch_requests_dispatch_same_organization", ondelete="RESTRICT"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    idempotency_key: Mapped[str] = mapped_column(String(100), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    dispatch_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class DispatchLine(TenantOwnedMixin, Base):
    """A quantity of one delivery-list item leaving one warehouse. An item may be dispatched from several warehouses (one line each).
    Product, SKU, name and unit are copied from the item and can never differ from it (database-enforced)."""

    __tablename__ = "dispatch_lines"
    __table_args__ = (
        UniqueConstraint("organization_id", "dispatch_id", "delivery_list_item_id", "warehouse_id", name="uq_dispatch_lines_dispatch_item_warehouse"),
        ForeignKeyConstraint(["organization_id", "dispatch_id"], ["dispatches.organization_id", "dispatches.id"],
                             name="fk_dispatch_lines_dispatch_same_organization", ondelete="RESTRICT"),
        ForeignKeyConstraint(["organization_id", "delivery_list_item_id"], ["delivery_list_items.organization_id", "delivery_list_items.id"],
                             name="fk_dispatch_lines_delivery_list_item_same_organization", ondelete="RESTRICT"),
        CheckConstraint("quantity > 0", name="quantity_positive"),
        Index("ix_dispatch_lines_organization_id_dispatch_id", "organization_id", "dispatch_id"),
        Index("ix_dispatch_lines_organization_id_delivery_list_item_id", "organization_id", "delivery_list_item_id"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    dispatch_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    delivery_list_item_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    product_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    product_sku: Mapped[str] = mapped_column(String(64), nullable=False)
    product_name: Mapped[str] = mapped_column(String(255), nullable=False)
    unit: Mapped[str] = mapped_column(String(20), nullable=False)
    warehouse_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    warehouse_code: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)  # snapshot, for display
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    inventory_movement_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)  # set when the posting is verified
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
