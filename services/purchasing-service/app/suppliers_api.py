"""Supplier directory. Every route depends on `require_active_tenant`: the organization is always the authenticated
administrator's, an inactive organization is refused, and no route accepts an organization id."""
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import TenantContext, require_active_tenant
from app.database import get_db
from app.models import Supplier
from app.schemas import SupplierCreate, SupplierList, SupplierResponse, SupplierUpdate
from app.search import like_pattern
from app.tenancy import create_for_tenant, get_scoped_or_404, scoped_count, scoped_select

router = APIRouter(prefix="/api/v1/purchasing")
Tenant = Depends(require_active_tenant)


def name_key(name: str) -> str:
    return " ".join(name.split()).casefold()


def name_conflict(name: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, f"A supplier named '{name}' already exists in your directory.")


def code_conflict(code: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, f"The supplier code '{code}' is already used by another supplier.")


def _taken(db: Session, tenant: TenantContext, column, value, exclude: Optional[uuid.UUID] = None) -> bool:
    query = scoped_count(Supplier, tenant, column == value)
    if exclude is not None:
        query = query.where(Supplier.id != exclude)
    return db.scalar(query) > 0


def _integrity_conflict(exc: IntegrityError, name: str, code: Optional[str]) -> HTTPException:
    return code_conflict(code) if code and "code" in str(exc.orig) else name_conflict(name)


@router.post("/suppliers", response_model=SupplierResponse, status_code=status.HTTP_201_CREATED, tags=["Suppliers"])
def create_supplier(payload: SupplierCreate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    key = name_key(payload.name)
    if _taken(db, tenant, Supplier.name_key, key):
        raise name_conflict(payload.name)
    if payload.code and _taken(db, tenant, Supplier.code, payload.code):
        raise code_conflict(payload.code)
    supplier = create_for_tenant(Supplier, tenant, name_key=key, **payload.model_dump())
    db.add(supplier)
    try:
        db.commit()
    except IntegrityError as exc:  # two requests raced past the checks; the database is the final judge
        db.rollback()
        raise _integrity_conflict(exc, payload.name, payload.code)
    db.refresh(supplier)
    return supplier


@router.get("/suppliers", response_model=SupplierList, tags=["Suppliers"])
def list_suppliers(
    q: Optional[str] = Query(default=None, max_length=100, description="Search name, code, contact person, e-mail, phone, tax id"),
    status_filter: Literal["active", "inactive", "all"] = Query(default="active", alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    filters = []
    if q and q.strip():
        pattern = like_pattern(q.strip())
        columns = (Supplier.name, Supplier.code, Supplier.contact_person, Supplier.email, Supplier.phone, Supplier.tax_identifier)
        filters.append(or_(*(column.ilike(pattern, escape="\\") for column in columns)))
    if status_filter == "active":
        filters.append(Supplier.is_active.is_(True))
    elif status_filter == "inactive":
        filters.append(Supplier.is_active.is_(False))
    total = db.scalar(scoped_count(Supplier, tenant, *filters))
    rows = db.scalars(scoped_select(Supplier, tenant).where(*filters).order_by(Supplier.name_key, Supplier.id).limit(limit).offset(offset)).all()
    return SupplierList(items=rows, total=total, limit=limit, offset=offset)


@router.get("/suppliers/{supplier_id}", response_model=SupplierResponse, tags=["Suppliers"])
def get_supplier(supplier_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return get_scoped_or_404(db, Supplier, tenant, supplier_id, "Supplier")


@router.patch("/suppliers/{supplier_id}", response_model=SupplierResponse, tags=["Suppliers"])
def update_supplier(supplier_id: uuid.UUID, payload: SupplierUpdate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    supplier = get_scoped_or_404(db, Supplier, tenant, supplier_id, "Supplier")
    changes = payload.model_dump(exclude_unset=True)
    if "name" in changes:
        key = name_key(changes["name"])
        if key != supplier.name_key and _taken(db, tenant, Supplier.name_key, key, exclude=supplier.id):
            raise name_conflict(changes["name"])
        supplier.name_key = key
    if changes.get("code") and changes["code"] != supplier.code and _taken(db, tenant, Supplier.code, changes["code"], exclude=supplier.id):
        raise code_conflict(changes["code"])
    for field, value in changes.items():
        setattr(supplier, field, value)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise _integrity_conflict(exc, changes.get("name", supplier.name), changes.get("code"))
    db.refresh(supplier)
    return supplier


def _set_active(db: Session, tenant: TenantContext, supplier_id: uuid.UUID, active: bool) -> Supplier:
    supplier = get_scoped_or_404(db, Supplier, tenant, supplier_id, "Supplier")
    if supplier.is_active != active:
        supplier.is_active = active
        db.commit()
        db.refresh(supplier)
    return supplier


@router.post("/suppliers/{supplier_id}/deactivate", response_model=SupplierResponse, tags=["Suppliers"])
def deactivate_supplier(supplier_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Deactivate (never delete): the supplier stays on its existing orders but gets no new ones until reactivated."""
    return _set_active(db, tenant, supplier_id, False)


@router.post("/suppliers/{supplier_id}/activate", response_model=SupplierResponse, tags=["Suppliers"])
def activate_supplier(supplier_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return _set_active(db, tenant, supplier_id, True)
