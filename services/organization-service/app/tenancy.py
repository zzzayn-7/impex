"""Tenant isolation: the reusable pattern for every service that stores organization-owned data.

Read docs/multi-tenancy.md first. The rules in one place:

  1. The tenant (organization_id) comes ONLY from `require_tenant_admin` (the Auth Service's record of the
     authenticated user). Endpoints must not accept an organization id from the URL, query, headers or body.
  2. Every table that holds organization-owned data has `organization_id UUID NOT NULL` (use TenantOwnedMixin).
  3. Every query goes through the helpers below so the `organization_id = <tenant>` filter cannot be forgotten.
  4. A row that belongs to another tenant must look exactly like a row that does not exist (404 / None).
  5. New rows get their organization_id from the tenant context, never from the request payload.

Future Inventory, Sales and Finance services copy this module's helpers (and `require_tenant_admin` from
app/auth.py) because microservices do not share code at runtime.
"""
import uuid
from typing import Any, Optional, Type, TypeVar

from fastapi import Depends, HTTPException, status
from sqlalchemy import Select, delete, select, update
from sqlalchemy.orm import Mapped, Session, mapped_column
from sqlalchemy import Uuid

from app.auth import TenantContext, require_tenant_admin
from app.database import get_db
from app.models import Organization

T = TypeVar("T")


# --- the organization behind the authenticated tenant ------------------------
def require_tenant_organization(
    tenant: TenantContext = Depends(require_tenant_admin),
    db: Session = Depends(get_db),
) -> Organization:
    """The caller's own organization, which must exist and be active.

    A missing organization and an inactive one produce the same 403, so the answer reveals nothing.
    """
    organization = db.get(Organization, tenant.organization_id)
    if organization is None or not organization.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your organization is not active.")
    return organization


# --- a column every tenant-owned table must have ------------------------------
class TenantOwnedMixin:
    """Add to every model whose rows belong to one organization.

        class Product(TenantOwnedMixin, Base):
            __tablename__ = "products"
            ...

    Also make unique constraints per tenant, e.g. UniqueConstraint("organization_id", "sku").
    """

    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)


# --- query helpers: the ONLY way tenant data should be read or written ---------
def scoped_select(model: Type[T], tenant: TenantContext) -> Select:
    """SELECT ... FROM model WHERE organization_id = <tenant>. Add further filters/joins on top of it."""
    return select(model).where(model.organization_id == tenant.organization_id)  # type: ignore[attr-defined]


def get_scoped(db: Session, model: Type[T], tenant: TenantContext, object_id: Any) -> Optional[T]:
    """One row by id, only if it belongs to the tenant. Another tenant's row is indistinguishable from none."""
    return db.scalar(
        scoped_select(model, tenant).where(model.id == object_id)  # type: ignore[attr-defined]
    )


def get_scoped_or_404(db: Session, model: Type[T], tenant: TenantContext, object_id: Any, what: str = "Item") -> T:
    row = get_scoped(db, model, tenant, object_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{what} not found.")
    return row


def create_for_tenant(model: Type[T], tenant: TenantContext, **fields: Any) -> T:
    """Build a new row owned by the tenant. Passing organization_id yourself is a bug and raises."""
    if "organization_id" in fields:
        raise ValueError("organization_id comes from the tenant context, never from the request")
    return model(organization_id=tenant.organization_id, **fields)  # type: ignore[call-arg]


def update_scoped(db: Session, model: Type[T], tenant: TenantContext, object_id: Any, **values: Any) -> bool:
    """UPDATE one row of the tenant. False if it is not theirs. Rows can never be moved to another tenant."""
    if "organization_id" in values:
        raise ValueError("a row's organization_id can never be changed")
    result = db.execute(
        update(model)  # type: ignore[arg-type]
        .where(model.id == object_id, model.organization_id == tenant.organization_id)  # type: ignore[attr-defined]
        .values(**values)
    )
    return result.rowcount > 0


def delete_scoped(db: Session, model: Type[T], tenant: TenantContext, object_id: Any) -> bool:
    """DELETE one row of the tenant. False if it is not theirs."""
    result = db.execute(
        delete(model).where(model.id == object_id, model.organization_id == tenant.organization_id)  # type: ignore[attr-defined]
    )
    return result.rowcount > 0
