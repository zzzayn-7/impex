"""Stock endpoints. Every route depends on `require_active_tenant`, so the organization is always the
authenticated administrator's, an inactive organization is refused, and no route accepts an organization id."""
import re
import uuid
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app import stock
from app.auth import TenantContext, require_active_tenant
from app.database import get_db
from app.models import Product
from app.schemas import (
    MovementList,
    DispatchPost,
    DispatchPosting,
    MovementType,
    ReceiptPost,
    ReceiptPosting,
    StockChange,
    StockOperationResult,
    StockOverview,
    StockSummary,
)
from app.tenancy import scoped_select

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
# Stock: reading
# =====================================================================================================
@router.get("/stock", response_model=StockOverview, tags=["Stock"])
def stock_overview(
    q: Optional[str] = Query(default=None, max_length=100),
    category: Optional[str] = Query(default=None, max_length=100),
    status_filter: Literal["active", "archived", "all"] = Query(default="active", alias="status", description="Product status"),
    in_stock_only: bool = False,
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    return stock.stock_overview(
        db, tenant, q=q, category=category, product_status=status_filter,
        in_stock_only=in_stock_only, limit=limit, offset=offset,
    )


@router.get("/stock/summary", response_model=StockSummary, tags=["Stock"])
def stock_summary(
    product_id: List[uuid.UUID] = Query(default=[], max_length=100, description="Up to 100 product ids"),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    """Name, SKU, unit, status and stock on hand for specific products.

    This is how other services (e.g. the Sales Service, with the administrator's own token) check that a product exists
    and how much of it is on hand, without trusting what a browser says. A product that does not exist, or belongs to
    another organization, is simply missing from the answer. Read-only.
    """
    if not product_id:
        return StockSummary(items=[])
    products = db.scalars(scoped_select(Product, tenant).where(Product.id.in_(product_id)).order_by(Product.name, Product.sku, Product.id)).all()
    return StockSummary(items=stock.stock_items(db, tenant, products))


@router.get("/stock/movements", response_model=MovementList, tags=["Stock"])
def list_movements(
    product_id: Optional[uuid.UUID] = None,
    movement_type: Optional[MovementType] = Query(default=None, alias="type"),
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    """The stock ledger, newest first. Read-only: there is no way to edit or delete a movement."""
    return stock.list_movements(
        db, tenant, product_id=product_id, movement_type=movement_type, limit=limit, offset=offset
    )


# =====================================================================================================
# Stock: changing it (every request needs an Idempotency-Key)
# =====================================================================================================
def _respond(result: StockOperationResult, response: Response) -> StockOperationResult:
    response.status_code = status.HTTP_200_OK if result.replayed else status.HTTP_201_CREATED
    return result


@router.post("/stock/opening", response_model=StockOperationResult, status_code=status.HTTP_201_CREATED, tags=["Stock"])
def opening_balance(payload: StockChange, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Record the starting quantity of a product (only before any other movement)."""
    return _respond(stock.execute_change(db, tenant, "opening", payload, key), response)


@router.post("/stock/in", response_model=StockOperationResult, status_code=status.HTTP_201_CREATED, tags=["Stock"])
def stock_in(payload: StockChange, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    return _respond(stock.execute_change(db, tenant, "in", payload, key), response)


@router.post("/stock/out", response_model=StockOperationResult, status_code=status.HTTP_201_CREATED, tags=["Stock"])
def stock_out(payload: StockChange, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    return _respond(stock.execute_change(db, tenant, "out", payload, key), response)


# =====================================================================================================
# Goods receipts (Step 16B): called by the Purchasing Service with the administrator's own token
# =====================================================================================================
@router.post("/goods-receipts", response_model=ReceiptPosting, status_code=status.HTTP_201_CREATED, tags=["Stock"])
def post_goods_receipt(payload: ReceiptPost, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Add the accepted quantities of a goods receipt to stock, all lines atomically. 201 the first time, 200 on a replay."""
    result = stock.execute_receipt(db, tenant, payload, key)
    response.status_code = status.HTTP_200_OK if result.replayed else status.HTTP_201_CREATED
    return result


@router.get("/goods-receipts/by-key/{key}", response_model=ReceiptPosting, tags=["Stock"])
def goods_receipt_by_key(key: str, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Read-only check whether the posting made with this Idempotency-Key happened (404 = it did not)."""
    if not IDEMPOTENCY_KEY_RE.match(key):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No goods receipt was posted with this key.")
    return stock.receipt_by_key(db, tenant, key)


# =====================================================================================================
# Client dispatches (Step 17A): called by the Sales Service with the administrator's own token
# =====================================================================================================
@router.post("/dispatches", response_model=DispatchPosting, status_code=status.HTTP_201_CREATED, tags=["Stock"])
def post_dispatch(payload: DispatchPost, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Deduct the quantities of a client dispatch from stock, all lines atomically. 201 the first time, 200 on a replay.
    409 when stock would go negative: nothing at all is deducted."""
    result = stock.execute_dispatch(db, tenant, payload, key)
    response.status_code = status.HTTP_200_OK if result.replayed else status.HTTP_201_CREATED
    return result


@router.get("/dispatches/by-key/{key}", response_model=DispatchPosting, tags=["Stock"])
def dispatch_by_key(key: str, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Read-only check whether the posting made with this Idempotency-Key happened (404 = it did not)."""
    if not IDEMPOTENCY_KEY_RE.match(key):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No dispatch was posted with this key.")
    return stock.dispatch_by_key(db, tenant, key)
