"""Delivery lists and their items. Every route depends on `require_active_tenant`; none accepts an organization id.

NOTHING in this module changes inventory: see app/delivery.py (stock is deducted only by a confirmed dispatch).
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import or_
from sqlalchemy.orm import Session
from typing import Literal

from app import delivery
from app.auth import TenantContext, require_active_tenant
from app.database import get_db
from app.inventory import InventoryGateway, get_gateway
from app.models import Client, DeliveryList, DeliveryListItem
from app.schemas import (
    DeliveryListCreate,
    DeliveryListDetail,
    DeliveryListPage,
    DeliveryListSummary,
    DeliveryListUpdate,
    ItemCreate,
    ItemIncrease,
    ItemResponse,
    ItemResult,
    ItemUpdate,
)
from app.search import like_pattern
from app.tenancy import scoped_count, scoped_select

router = APIRouter(prefix="/api/v1/sales")
Tenant = Depends(require_active_tenant)


@router.post("/delivery-lists", response_model=DeliveryListSummary, status_code=status.HTTP_201_CREATED, tags=["Delivery lists"])
def create_delivery_list(payload: DeliveryListCreate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Start a draft list for one of your clients. The number (DL-000001, ...) and the owner are assigned here."""
    client = delivery.get_client_or_404(db, tenant, payload.client_id)
    if not client.is_active:
        raise delivery.conflict(f"{client.name} is inactive. Reactivate the client before creating a delivery list for them.")
    created = DeliveryList(
        organization_id=tenant.organization_id,
        client_id=client.id,
        number=delivery.next_number(db, tenant),
        external_reference=payload.external_reference,
        notes=payload.notes,
        status="draft",
        created_by=delivery._user_id(tenant),
        created_by_email=tenant.email,
    )
    db.add(created)
    db.commit()
    db.refresh(created)
    return delivery.summaries(db, tenant, [created])[0]


@router.get("/delivery-lists", response_model=DeliveryListPage, tags=["Delivery lists"])
def list_delivery_lists(
    client_id: Optional[uuid.UUID] = None,
    status_filter: Optional[Literal["draft", "ready", "partially_dispatched", "dispatched", "cancelled"]] = Query(default=None, alias="status"),
    q: Optional[str] = Query(default=None, max_length=100, description="Search number, external reference or client name"),
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    filters = []
    if client_id:
        filters.append(DeliveryList.client_id == client_id)
    if status_filter:
        filters.append(DeliveryList.status == status_filter)
    base = scoped_select(DeliveryList, tenant).join(Client, (Client.id == DeliveryList.client_id) & (Client.organization_id == DeliveryList.organization_id))
    count = scoped_count(DeliveryList, tenant).join(Client, (Client.id == DeliveryList.client_id) & (Client.organization_id == DeliveryList.organization_id))
    if q and q.strip():
        pattern = like_pattern(q.strip())
        filters.append(or_(DeliveryList.number.ilike(pattern, escape="\\"), DeliveryList.external_reference.ilike(pattern, escape="\\"), Client.name.ilike(pattern, escape="\\")))
    total = db.scalar(count.where(*filters))
    rows = db.scalars(base.where(*filters).order_by(DeliveryList.created_at.desc(), DeliveryList.number.desc()).limit(limit).offset(offset)).all()
    return DeliveryListPage(items=delivery.summaries(db, tenant, list(rows)), total=total, limit=limit, offset=offset)


@router.get("/delivery-lists/{list_id}", response_model=DeliveryListDetail, tags=["Delivery lists"])
def get_delivery_list(list_id: uuid.UUID, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """The list, its items and the CURRENT stock of each product (information only: stock is not reserved)."""
    return delivery.detail(db, tenant, gateway, delivery.get_list_or_404(db, tenant, list_id))


@router.patch("/delivery-lists/{list_id}", response_model=DeliveryListSummary, tags=["Delivery lists"])
def update_delivery_list(list_id: uuid.UUID, payload: DeliveryListUpdate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    delivery_list = delivery.get_list_or_404(db, tenant, list_id, lock=True)
    delivery.require_draft(delivery_list)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(delivery_list, field, value)
    db.commit()
    db.refresh(delivery_list)
    return delivery.summaries(db, tenant, [delivery_list])[0]


def _status_route(target: str):
    def handler(list_id: uuid.UUID, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
        delivery_list = delivery.change_status(db, tenant, gateway, list_id, target)
        return delivery.detail(db, tenant, gateway, delivery_list)

    return handler


for _path, _target, _doc in (
    ("ready", "ready", "Mark the list Ready for dispatch. Does NOT deduct or reserve stock."),
    ("cancel", "cancelled", "Cancel the list. Nothing is deleted and no stock is involved."),
    ("reopen", "draft", "Turn a Ready list back into an editable draft."),
):
    _handler = _status_route(_target)
    _handler.__doc__ = _doc
    _handler.__name__ = f"mark_{_target}"
    router.add_api_route(f"/delivery-lists/{{list_id}}/{_path}", _handler, methods=["POST"], response_model=DeliveryListDetail, tags=["Delivery lists"])


@router.post("/delivery-lists/{list_id}/items", response_model=ItemResult, status_code=status.HTTP_201_CREATED, tags=["Delivery list items"])
def add_item(list_id: uuid.UUID, payload: ItemCreate, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """Add a product with an explicit quantity. If it is already on the list the answer is 409 with the existing line:
    nothing is incremented implicitly."""
    item = delivery.add_item(db, tenant, gateway, list_id, payload.product_id, payload.quantity)
    return _result(db, tenant, gateway, list_id, item)


def _result(db: Session, tenant: TenantContext, gateway: InventoryGateway, list_id: uuid.UUID, item: DeliveryListItem) -> ItemResult:
    from app.inventory import InventoryUnavailable

    count = db.scalar(scoped_count(DeliveryListItem, tenant, DeliveryListItem.delivery_list_id == list_id))
    try:
        info = gateway.products([item.product_id]).get(item.product_id)
    except InventoryUnavailable:
        info = None
    return ItemResult(item=delivery.item_response(item, info), item_count=count)


@router.patch("/delivery-lists/{list_id}/items/{item_id}", response_model=ItemResult, tags=["Delivery list items"])
def update_item(list_id: uuid.UUID, item_id: uuid.UUID, payload: ItemUpdate, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """Set the quantity of a line of a draft list."""
    item = delivery.update_item(db, tenant, gateway, list_id, item_id, payload.model_dump(exclude_unset=True))
    return _result(db, tenant, gateway, list_id, item)


@router.post("/delivery-lists/{list_id}/items/{item_id}/increase", response_model=ItemResult, tags=["Delivery list items"])
def increase_item(list_id: uuid.UUID, item_id: uuid.UUID, payload: ItemIncrease, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """Add the given quantity to an existing line - an explicit decision, never a side effect of scanning again."""
    item = delivery.increase_item(db, tenant, gateway, list_id, item_id, payload.quantity)
    return _result(db, tenant, gateway, list_id, item)


@router.delete("/delivery-lists/{list_id}/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["Delivery list items"])
def remove_item(list_id: uuid.UUID, item_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Remove a line from a draft list. (It only ever was a note; no stock is involved.)"""
    delivery.remove_item(db, tenant, list_id, item_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
