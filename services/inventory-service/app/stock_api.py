"""Warehouse and stock endpoints. Every route depends on `require_active_tenant`, so the organization is always the
authenticated administrator's, an inactive organization is refused, and no route accepts an organization id."""
import re
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import stock
from app.auth import TenantContext, require_active_tenant
from app.database import get_db
from app.models import Warehouse
from app.schemas import (
    MovementList,
    MovementType,
    StockChange,
    StockOperationResult,
    StockOverview,
    StockTransfer,
    WarehouseCreate,
    WarehouseList,
    WarehouseResponse,
    WarehouseUpdate,
)
from app.search import like_pattern
from app.tenancy import create_for_tenant, get_scoped_or_404, scoped_count, scoped_select

router = APIRouter(prefix="/api/v1/inventory")
Tenant = Depends(require_active_tenant)

IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,100}$")


def idempotency_key(key: Optional[str] = Header(default=None, alias="Idempotency-Key")) -> str:
    """Stock changes must carry a client-generated key, so a double click or a retry can never apply twice."""
    key = (key or "").strip()
    if not key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The Idempotency-Key header is required for stock changes.")
    if not IDEMPOTENCY_KEY_RE.match(key):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key must be 8-100 characters: letters, digits and . _ : -")
    return key


# =====================================================================================================
# Warehouses
# =====================================================================================================
def code_conflict(code: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, f"A warehouse with code '{code}' already exists in your organization.")


def _warehouse_response(db: Session, tenant: TenantContext, warehouses) -> list:
    counts = stock.products_in_stock_by_warehouse(db, tenant, [w.id for w in warehouses])
    out = []
    for warehouse in warehouses:
        item = WarehouseResponse.model_validate(warehouse)
        item.products_in_stock = counts.get(warehouse.id, 0)
        out.append(item)
    return out


def _code_taken(db: Session, tenant: TenantContext, code: str, exclude: Optional[uuid.UUID] = None) -> bool:
    query = scoped_count(Warehouse, tenant, Warehouse.code == code)
    if exclude is not None:
        query = query.where(Warehouse.id != exclude)
    return db.scalar(query) > 0


@router.post("/warehouses", response_model=WarehouseResponse, status_code=status.HTTP_201_CREATED, tags=["Warehouses"])
def create_warehouse(payload: WarehouseCreate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    if _code_taken(db, tenant, payload.code):
        raise code_conflict(payload.code)
    warehouse = create_for_tenant(Warehouse, tenant, **payload.model_dump())
    db.add(warehouse)
    try:
        db.commit()
    except IntegrityError:  # two requests with the same code raced past the check above
        db.rollback()
        raise code_conflict(payload.code)
    db.refresh(warehouse)
    return _warehouse_response(db, tenant, [warehouse])[0]


@router.get("/warehouses", response_model=WarehouseList, tags=["Warehouses"])
def list_warehouses(
    q: Optional[str] = Query(default=None, max_length=100),
    status_filter: Literal["active", "archived", "all"] = Query(default="active", alias="status"),
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    filters = []
    if q and q.strip():
        pattern = like_pattern(q.strip())
        filters.append(or_(Warehouse.code.ilike(pattern, escape="\\"), Warehouse.name.ilike(pattern, escape="\\"), Warehouse.address.ilike(pattern, escape="\\")))
    if status_filter == "active":
        filters.append(Warehouse.is_active.is_(True))
    elif status_filter == "archived":
        filters.append(Warehouse.is_active.is_(False))
    total = db.scalar(scoped_count(Warehouse, tenant, *filters))
    rows = db.scalars(scoped_select(Warehouse, tenant).where(*filters).order_by(Warehouse.code, Warehouse.id).limit(limit).offset(offset)).all()
    return WarehouseList(items=_warehouse_response(db, tenant, rows), total=total, limit=limit, offset=offset)


@router.get("/warehouses/{warehouse_id}", response_model=WarehouseResponse, tags=["Warehouses"])
def get_warehouse(warehouse_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return _warehouse_response(db, tenant, [get_scoped_or_404(db, Warehouse, tenant, warehouse_id, "Warehouse")])[0]


@router.patch("/warehouses/{warehouse_id}", response_model=WarehouseResponse, tags=["Warehouses"])
def update_warehouse(warehouse_id: uuid.UUID, payload: WarehouseUpdate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    warehouse = get_scoped_or_404(db, Warehouse, tenant, warehouse_id, "Warehouse")
    changes = payload.model_dump(exclude_unset=True)
    if "code" in changes and changes["code"] != warehouse.code and _code_taken(db, tenant, changes["code"], exclude=warehouse.id):
        raise code_conflict(changes["code"])
    for field, value in changes.items():
        setattr(warehouse, field, value)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise code_conflict(changes.get("code", warehouse.code))
    db.refresh(warehouse)
    return _warehouse_response(db, tenant, [warehouse])[0]


def _set_warehouse_active(db: Session, tenant: TenantContext, warehouse_id: uuid.UUID, active: bool) -> WarehouseResponse:
    warehouse = get_scoped_or_404(db, Warehouse, tenant, warehouse_id, "Warehouse")
    if warehouse.is_active != active:
        warehouse.is_active = active
        db.commit()
        db.refresh(warehouse)
    return _warehouse_response(db, tenant, [warehouse])[0]


@router.post("/warehouses/{warehouse_id}/archive", response_model=WarehouseResponse, tags=["Warehouses"])
def archive_warehouse(warehouse_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Archive (soft delete). A warehouse can never be hard-deleted: it may hold stock and has movement history."""
    return _set_warehouse_active(db, tenant, warehouse_id, False)


@router.post("/warehouses/{warehouse_id}/restore", response_model=WarehouseResponse, tags=["Warehouses"])
def restore_warehouse(warehouse_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return _set_warehouse_active(db, tenant, warehouse_id, True)


# =====================================================================================================
# Stock: reading
# =====================================================================================================
@router.get("/stock", response_model=StockOverview, tags=["Stock"])
def stock_overview(
    q: Optional[str] = Query(default=None, max_length=100),
    category: Optional[str] = Query(default=None, max_length=100),
    warehouse_id: Optional[uuid.UUID] = Query(default=None, description="Only products that have stock in this warehouse"),
    status_filter: Literal["active", "archived", "all"] = Query(default="active", alias="status", description="Product status"),
    in_stock_only: bool = False,
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    return stock.stock_overview(
        db, tenant, q=q, category=category, warehouse_id=warehouse_id, product_status=status_filter,
        in_stock_only=in_stock_only, limit=limit, offset=offset,
    )


@router.get("/stock/movements", response_model=MovementList, tags=["Stock"])
def list_movements(
    product_id: Optional[uuid.UUID] = None,
    warehouse_id: Optional[uuid.UUID] = None,
    movement_type: Optional[MovementType] = Query(default=None, alias="type"),
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    """The stock ledger, newest first. Read-only: there is no way to edit or delete a movement."""
    return stock.list_movements(
        db, tenant, product_id=product_id, warehouse_id=warehouse_id, movement_type=movement_type, limit=limit, offset=offset
    )


# =====================================================================================================
# Stock: changing it (every request needs an Idempotency-Key)
# =====================================================================================================
def _respond(result: StockOperationResult, response: Response) -> StockOperationResult:
    response.status_code = status.HTTP_200_OK if result.replayed else status.HTTP_201_CREATED
    return result


@router.post("/stock/opening", response_model=StockOperationResult, status_code=status.HTTP_201_CREATED, tags=["Stock"])
def opening_balance(payload: StockChange, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Record the starting quantity of a product in a warehouse (only before any other movement there)."""
    return _respond(stock.execute_change(db, tenant, "opening", payload, key), response)


@router.post("/stock/in", response_model=StockOperationResult, status_code=status.HTTP_201_CREATED, tags=["Stock"])
def stock_in(payload: StockChange, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    return _respond(stock.execute_change(db, tenant, "in", payload, key), response)


@router.post("/stock/out", response_model=StockOperationResult, status_code=status.HTTP_201_CREATED, tags=["Stock"])
def stock_out(payload: StockChange, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    return _respond(stock.execute_change(db, tenant, "out", payload, key), response)


@router.post("/stock/transfer", response_model=StockOperationResult, status_code=status.HTTP_201_CREATED, tags=["Stock"])
def stock_transfer(payload: StockTransfer, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Move stock between two warehouses: one outgoing and one incoming movement, committed together."""
    return _respond(stock.execute_transfer(db, tenant, payload, key), response)
