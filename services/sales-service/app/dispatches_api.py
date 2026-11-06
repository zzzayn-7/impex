"""Dispatches. Every route depends on `require_active_tenant`; none accepts an organization id.

Preparing, editing and reviewing a dispatch NEVER changes stock. Only POST .../confirm can, and only through the Inventory
Service's audited operation: see app/dispatches.py for the workflow and its guarantees.
"""
import re
import uuid
from datetime import date
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy import exists
from sqlalchemy.orm import Session

from app import dispatches
from app.auth import TenantContext, require_active_tenant, require_active_tenant_for_recovery
from app.database import get_db
from app.inventory import InventoryGateway, get_gateway
from app.models import Client, DeliveryList, Dispatch, DispatchLine
from app.schemas import DispatchCreate, DispatchDetail, DispatchLines, DispatchPage, DispatchUpdate
from app.search import like_pattern
from app.tenancy import scoped_count, scoped_select

router = APIRouter(prefix="/api/v1/sales")
Tenant = Depends(require_active_tenant)
# Confirming is the one route that must still work for a dispatch that is already `posting` when Sales is switched off (see app/auth.py).
Recovery = Depends(require_active_tenant_for_recovery)

IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,100}$")


def idempotency_key(key: Optional[str] = Header(default=None, alias="Idempotency-Key")) -> str:
    key = (key or "").strip()
    if not key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The Idempotency-Key header is required to create a dispatch.")
    if not IDEMPOTENCY_KEY_RE.match(key):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key must be 8-100 characters: letters, digits and . _ : -")
    return key


@router.post("/dispatches", response_model=DispatchDetail, status_code=status.HTTP_201_CREATED, tags=["Dispatches"])
def create_dispatch(
    payload: DispatchCreate, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key),
    gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db),
):
    """Start a DRAFT dispatch against a Ready / Partially Dispatched delivery list, optionally with its lines. Changes no stock.
    The first request answers 201; a retry with the same Idempotency-Key and body answers 200 with the same dispatch."""
    dispatch, replayed = dispatches.create_dispatch(db, tenant, gateway, payload, key)
    response.status_code = status.HTTP_200_OK if replayed else status.HTTP_201_CREATED
    return dispatches.detail(db, tenant, gateway, dispatch)


@router.get("/dispatches", response_model=DispatchPage, tags=["Dispatches"])
def list_dispatches(
    delivery_list_id: Optional[uuid.UUID] = None,
    client_id: Optional[uuid.UUID] = None,
    status_filter: Optional[Literal["draft", "posting", "confirmed", "cancelled"]] = Query(default=None, alias="status"),
    warehouse_id: Optional[uuid.UUID] = None,
    product_id: Optional[uuid.UUID] = None,
    q: Optional[str] = Query(default=None, max_length=100, description="Search dispatch number, delivery list number, tracking reference or client name"),
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    filters = []
    if delivery_list_id:
        filters.append(Dispatch.delivery_list_id == delivery_list_id)
    if client_id:
        filters.append(Dispatch.client_id == client_id)
    if status_filter:
        filters.append(Dispatch.status == status_filter)
    if date_from:
        filters.append(Dispatch.dispatch_date >= date_from)
    if date_to:
        filters.append(Dispatch.dispatch_date <= date_to)
    for column, value in ((DispatchLine.warehouse_id, warehouse_id), (DispatchLine.product_id, product_id)):
        if value:
            filters.append(exists().where(DispatchLine.organization_id == Dispatch.organization_id, DispatchLine.dispatch_id == Dispatch.id, column == value))
    if q and q.strip():
        filters.append(dispatches.search_filter(like_pattern(q.strip())))
    list_join = (DeliveryList.id == Dispatch.delivery_list_id) & (DeliveryList.organization_id == Dispatch.organization_id)
    client_join = (Client.id == Dispatch.client_id) & (Client.organization_id == Dispatch.organization_id)
    total = db.scalar(scoped_count(Dispatch, tenant).join(DeliveryList, list_join).join(Client, client_join).where(*filters))
    rows = db.scalars(
        scoped_select(Dispatch, tenant).join(DeliveryList, list_join).join(Client, client_join).where(*filters)
        .order_by(Dispatch.dispatch_date.desc(), Dispatch.created_at.desc(), Dispatch.number.desc()).limit(limit).offset(offset)
    ).all()
    return DispatchPage(items=dispatches.summaries(db, tenant, list(rows)), total=total, limit=limit, offset=offset)


@router.get("/dispatches/{dispatch_id}", response_model=DispatchDetail, tags=["Dispatches"])
def get_dispatch(dispatch_id: uuid.UUID, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """The dispatch, its lines (with the live stock of each warehouse while it is a draft) and its posting bookkeeping."""
    return dispatches.detail(db, tenant, gateway, dispatches.get_dispatch_or_404(db, tenant, dispatch_id))


@router.patch("/dispatches/{dispatch_id}", response_model=DispatchDetail, tags=["Dispatches"])
def update_dispatch(dispatch_id: uuid.UUID, payload: DispatchUpdate, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """Edit the date, address, transport details, tracking reference or notes of a DRAFT dispatch."""
    dispatch = dispatches.update_header(db, tenant, dispatch_id, payload.model_dump(exclude_unset=True))
    return dispatches.detail(db, tenant, gateway, dispatch)


@router.put("/dispatches/{dispatch_id}/lines", response_model=DispatchDetail, tags=["Dispatches"])
def save_dispatch_lines(dispatch_id: uuid.UUID, payload: DispatchLines, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """Replace the lines of a DRAFT dispatch with exactly these. Changes no stock."""
    dispatch = dispatches.save_lines(db, tenant, gateway, dispatch_id, payload.lines)
    return dispatches.detail(db, tenant, gateway, dispatch)


@router.post("/dispatches/{dispatch_id}/confirm", response_model=DispatchDetail, tags=["Dispatches"])
def confirm_dispatch(dispatch_id: uuid.UUID, response: Response, tenant: TenantContext = Recovery, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """Deduct the dispatched quantities from stock through the Inventory Service and mark the dispatch confirmed.

    200: confirmed (also when it already was: repeating this call never deducts stock twice).
    202: the dispatch is `posting` and the Inventory Service's answer could not be verified yet (it may be down, slow, or its
         answer was lost). Nothing is lost: call this endpoint again later - the same Idempotency-Key is used for the Inventory
         Service, which replays the first result instead of deducting the goods a second time.
    409 (code inventory_rejected / insufficient_stock): nothing was deducted and the dispatch is still a draft."""
    dispatch, confirmed = dispatches.confirm_dispatch(db, tenant, gateway, dispatch_id)
    response.status_code = status.HTTP_200_OK if confirmed else status.HTTP_202_ACCEPTED
    return dispatches.detail(db, tenant, gateway, dispatch)


@router.post("/dispatches/{dispatch_id}/cancel", response_model=DispatchDetail, tags=["Dispatches"])
def cancel_dispatch(dispatch_id: uuid.UUID, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """Cancel a DRAFT dispatch (kept for history). A dispatch that is being posted or confirmed cannot be cancelled."""
    return dispatches.detail(db, tenant, gateway, dispatches.cancel_dispatch(db, tenant, dispatch_id))
