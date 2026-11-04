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
    stock. (Dispatch, which will, is a later step.)
    """

    __tablename__ = "delivery_lists"
    __table_args__ = (
        UniqueConstraint("organization_id", "number", name="uq_delivery_lists_organization_id_number"),
        UniqueConstraint("organization_id", "id", name="uq_delivery_lists_organization_id_id"),
        # Same-organization guarantee: the client must belong to this row's organization.
        ForeignKeyConstraint(["organization_id", "client_id"], ["clients.organization_id", "clients.id"],
                             name="fk_delivery_lists_client_same_organization", ondelete="RESTRICT"),
        CheckConstraint("status IN ('draft', 'ready', 'cancelled')", name="status_valid"),
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
