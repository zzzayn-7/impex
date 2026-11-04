"""Purchase orders and their lines. Every route depends on `require_active_tenant`; none accepts an organization id.

NOTHING in this module changes inventory or product prices: see app/orders.py.
"""
import re
import uuid
from datetime import date
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import orders
from app.auth import TenantContext, require_active_tenant
from app.database import get_db
from app.inventory import InventoryGateway, get_gateway
from app.models import PurchaseOrder, Supplier
from app.schemas import (
    LineCreate,
    LineRemoved,
    LineResult,
    LineUpdate,
    PurchaseOrderCreate,
    PurchaseOrderDetail,
    PurchaseOrderPage,
    PurchaseOrderSummary,
    PurchaseOrderUpdate,
)
from app.search import like_pattern
from app.tenancy import scoped_count, scoped_select

router = APIRouter(prefix="/api/v1/purchasing")
Tenant = Depends(require_active_tenant)

IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,100}$")


def idempotency_key(key: Optional[str] = Header(default=None, alias="Idempotency-Key")) -> str:
    """Creating an order must carry a client-generated key, so a double click or a retry can never create it twice."""
    key = (key or "").strip()
    if not key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The Idempotency-Key header is required to create a purchase order.")
    if not IDEMPOTENCY_KEY_RE.match(key):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key must be 8-100 characters: letters, digits and . _ : -")
    return key


@router.post("/purchase-orders", response_model=PurchaseOrderSummary, status_code=status.HTTP_201_CREATED, tags=["Purchase orders"])
def create_purchase_order(
    payload: PurchaseOrderCreate, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)
):
    """Start a DRAFT order with one of your active suppliers. The number (PO-000001, ...) and the owner are assigned here.
    The first request answers 201; a retry with the same Idempotency-Key and body answers 200 with the same order."""
    order, replayed = orders.create_order(db, tenant, payload, key)
    response.status_code = status.HTTP_200_OK if replayed else status.HTTP_201_CREATED
    return orders.summaries(db, tenant, [order])[0]


@router.get("/purchase-orders", response_model=PurchaseOrderPage, tags=["Purchase orders"])
def list_purchase_orders(
    supplier_id: Optional[uuid.UUID] = None,
    status_filter: Optional[Literal["draft", "ordered", "partially_received", "received", "cancelled"]] = Query(default=None, alias="status"),
    q: Optional[str] = Query(default=None, max_length=100, description="Search number, supplier reference or supplier name"),
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    filters = []
    if supplier_id:
        filters.append(PurchaseOrder.supplier_id == supplier_id)
    if status_filter:
        filters.append(PurchaseOrder.status == status_filter)
    if date_from:
        filters.append(PurchaseOrder.order_date >= date_from)
    if date_to:
        filters.append(PurchaseOrder.order_date <= date_to)
    join = (Supplier.id == PurchaseOrder.supplier_id) & (Supplier.organization_id == PurchaseOrder.organization_id)
    if q and q.strip():
        pattern = like_pattern(q.strip())
        filters.append(or_(PurchaseOrder.number.ilike(pattern, escape="\\"), PurchaseOrder.supplier_reference.ilike(pattern, escape="\\"), Supplier.name.ilike(pattern, escape="\\")))
    total = db.scalar(scoped_count(PurchaseOrder, tenant).join(Supplier, join).where(*filters))
    rows = db.scalars(
        scoped_select(PurchaseOrder, tenant).join(Supplier, join).where(*filters)
        .order_by(PurchaseOrder.created_at.desc(), PurchaseOrder.number.desc()).limit(limit).offset(offset)
    ).all()
    return PurchaseOrderPage(items=orders.summaries(db, tenant, list(rows)), total=total, limit=limit, offset=offset)


@router.get("/purchase-orders/{order_id}", response_model=PurchaseOrderDetail, tags=["Purchase orders"])
def get_purchase_order(order_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """The order with its lines and total. The total is calculated here from the lines."""
    return orders.detail(db, tenant, orders.get_order_or_404(db, tenant, order_id))


@router.patch("/purchase-orders/{order_id}", response_model=PurchaseOrderSummary, tags=["Purchase orders"])
def update_purchase_order(order_id: uuid.UUID, payload: PurchaseOrderUpdate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Edit the header of a DRAFT order. An ordered or cancelled order is frozen."""
    order = orders.update_header(db, tenant, order_id, payload.model_dump(exclude_unset=True))
    return orders.summaries(db, tenant, [order])[0]


def _status_route(target: str):
    def handler(order_id: uuid.UUID, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
        order = orders.change_status(db, tenant, gateway, order_id, target)
        return orders.detail(db, tenant, order)

    return handler


for _path, _target, _doc in (
    ("order", "ordered", "Place the order with the supplier: its details and lines are frozen. Does NOT add stock (receiving is a later step)."),
    ("cancel", "cancelled", "Cancel the order. It is kept for history; no stock is involved."),
):
    _handler = _status_route(_target)
    _handler.__doc__ = _doc
    _handler.__name__ = f"mark_{_target}"
    router.add_api_route(f"/purchase-orders/{{order_id}}/{_path}", _handler, methods=["POST"], response_model=PurchaseOrderDetail, tags=["Purchase orders"])


@router.post("/purchase-orders/{order_id}/lines", response_model=LineResult, status_code=status.HTTP_201_CREATED, tags=["Purchase order lines"])
def add_line(order_id: uuid.UUID, payload: LineCreate, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """Add an existing product with the ordered quantity and the unit purchase price. Name, SKU and unit come from the
    Inventory Service; the line total is calculated here. If the product is already on the order the answer is 409."""
    return orders.add_line(db, tenant, gateway, order_id, payload)


@router.patch("/purchase-orders/{order_id}/lines/{line_id}", response_model=LineResult, tags=["Purchase order lines"])
def update_line(order_id: uuid.UUID, line_id: uuid.UUID, payload: LineUpdate, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    return orders.update_line(db, tenant, gateway, order_id, line_id, payload.model_dump(exclude_unset=True))


@router.delete("/purchase-orders/{order_id}/lines/{line_id}", response_model=LineRemoved, tags=["Purchase order lines"])
def remove_line(order_id: uuid.UUID, line_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Remove a line from a draft order; answers the order's new line count and total."""
    return orders.remove_line(db, tenant, order_id, line_id)
