import uuid
from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import Boolean, CheckConstraint, DateTime, Index, Numeric, String, Text, UniqueConstraint, Uuid, func, text
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
        CheckConstraint("cost_price >= 0", name="cost_price_non_negative"),
        CheckConstraint("selling_price >= 0", name="selling_price_non_negative"),
        Index("ix_products_organization_id_category", "organization_id", "category"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()")
    )
    sku: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    category: Mapped[str] = mapped_column(String(100), nullable=False)
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
