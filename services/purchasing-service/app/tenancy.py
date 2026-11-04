"""Tenant isolation helpers (copied from the Organization Service; see docs/multi-tenancy.md).

The rules, in one place:
  1. The tenant (organization_id) comes ONLY from `require_tenant_admin` / `require_active_tenant`.
  2. Every tenant-owned table has `organization_id UUID NOT NULL` (TenantOwnedMixin).
  3. Every query goes through the helpers below so the `organization_id = <tenant>` filter cannot be forgotten.
  4. Another tenant's row looks exactly like a missing row (404 / None).
  5. New rows get their organization_id from the tenant context, never from the request payload.
"""
import uuid
from typing import Any, Optional, Type, TypeVar

from fastapi import HTTPException, status
from sqlalchemy import Select, Uuid, delete, func, select, update
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.auth import TenantContext

T = TypeVar("T")


class TenantOwnedMixin:
    """Add to every model whose rows belong to one organization. Make unique keys per tenant."""

    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)


def scoped_select(model: Type[T], tenant: TenantContext) -> Select:
    """SELECT ... FROM model WHERE organization_id = <tenant>. Add further filters on top of it."""
    return select(model).where(model.organization_id == tenant.organization_id)  # type: ignore[attr-defined]


def scoped_count(model: Type[T], tenant: TenantContext, *filters: Any) -> Select:
    """SELECT count(*) restricted to the tenant (totals and aggregates must be scoped too)."""
    return (
        select(func.count())
        .select_from(model)
        .where(model.organization_id == tenant.organization_id, *filters)  # type: ignore[attr-defined]
    )


def get_scoped(db: Session, model: Type[T], tenant: TenantContext, object_id: Any) -> Optional[T]:
    """One row by id, only if it belongs to the tenant. Another tenant's row is indistinguishable from none."""
    return db.scalar(scoped_select(model, tenant).where(model.id == object_id))  # type: ignore[attr-defined]


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
