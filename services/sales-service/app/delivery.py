"""Delivery-list business rules.

The rules that matter most:
  * Nothing here changes inventory, ever. A list is a promise-to-deliver note: adding items, editing them, marking the
    list Ready or cancelling it never deducts or reserves stock (there is no code path that could: this module never
    calls a write endpoint of the Inventory Service).
  * Product facts (name, SKU, unit, active, stock) always come from the Inventory Service, asked with the caller's token.
  * A product appears at most once per list. Adding it again is refused with the existing line, so the caller can
    EXPLICITLY set or increase its quantity; quantities are never incremented implicitly.
  * Items can be changed only while the list is a draft.
  * Stock is deducted only by a CONFIRMED dispatch (app/dispatches.py). Once any dispatch exists the list can no longer be
    reopened for editing, and a list with goods dispatched (or being dispatched) can never be cancelled.
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import TenantContext
from app.inventory import InventoryGateway, InventoryUnavailable, ProductInfo, unavailable_error
from app.models import Client, DeliveryList, DeliveryListCounter, DeliveryListItem
from app.schemas import (
    ClientRef,
    DeliveryListDetail,
    DeliveryListSummary,
    ItemResponse,
    ItemStock,
)
from app.tenancy import get_scoped, get_scoped_or_404, scoped_select

ZERO = Decimal("0")
# Only the moves a user asks for. Partially Dispatched / Dispatched are reached only by confirming dispatches.
TRANSITIONS = {
    ("draft", "ready"): "ready",
    ("draft", "cancelled"): "cancelled",
    ("ready", "cancelled"): "cancelled",
    ("ready", "draft"): "draft",  # reopen for editing: still no stock effect
}


def conflict(message: str, **extra) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, {"message": message, **extra} if extra else message)


def _user_id(tenant: TenantContext) -> uuid.UUID:
    try:
        return uuid.UUID(tenant.user_id)
    except ValueError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Organization administrator permission required")


def human(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


# --- numbering --------------------------------------------------------------------------------------------
def next_number(db: Session, tenant: TenantContext) -> str:
    """DL-000001, DL-000002, ... per organization. The counter row is incremented atomically, so two requests at the same
    moment can never get the same number (and the UNIQUE constraint on (organization_id, number) backs that up)."""
    row = db.execute(
        pg_insert(DeliveryListCounter)
        .values(organization_id=tenant.organization_id, last_number=1)
        .on_conflict_do_update(
            index_elements=["organization_id"], set_={"last_number": DeliveryListCounter.last_number + 1}
        )
        .returning(DeliveryListCounter.last_number)
    ).one()
    return f"DL-{row[0]:06d}"


# --- loading ------------------------------------------------------------------------------------------------
def get_client_or_404(db: Session, tenant: TenantContext, client_id: uuid.UUID) -> Client:
    return get_scoped_or_404(db, Client, tenant, client_id, "Client")


def get_list_or_404(db: Session, tenant: TenantContext, list_id: uuid.UUID, *, lock: bool = False) -> DeliveryList:
    query = scoped_select(DeliveryList, tenant).where(DeliveryList.id == list_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    found = db.scalar(query)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Delivery list not found.")
    return found


def require_draft(delivery_list: DeliveryList) -> None:
    if delivery_list.status != "draft":
        raise conflict(
            f"{delivery_list.number} is {delivery_list.status}. Only a draft list can be changed"
            + (" (reopen it first)." if delivery_list.status == "ready" else ".")
        )


def require_active_client(db: Session, tenant: TenantContext, delivery_list: DeliveryList) -> Client:
    client = get_client_or_404(db, tenant, delivery_list.client_id)
    if not client.is_active:
        raise conflict(f"{client.name} is inactive. Reactivate the client before adding products or marking the list Ready.")
    return client


# --- summaries and details ---------------------------------------------------------------------------------------
def summaries(db: Session, tenant: TenantContext, lists: List[DeliveryList]) -> List[DeliveryListSummary]:
    if not lists:
        return []
    clients = {c.id: c for c in db.scalars(scoped_select(Client, tenant).where(Client.id.in_({l.client_id for l in lists})))}
    counts = dict(
        db.execute(
            select(DeliveryListItem.delivery_list_id, func.count())
            .where(DeliveryListItem.organization_id == tenant.organization_id, DeliveryListItem.delivery_list_id.in_([l.id for l in lists]))
            .group_by(DeliveryListItem.delivery_list_id)
        ).all()
    )
    return [
        DeliveryListSummary(
            id=l.id, number=l.number, client=ClientRef(id=clients[l.client_id].id, name=clients[l.client_id].name, is_active=clients[l.client_id].is_active),
            external_reference=l.external_reference, status=l.status, notes=l.notes, item_count=counts.get(l.id, 0),
            created_by_email=l.created_by_email, created_at=l.created_at, updated_at=l.updated_at,
        )
        for l in lists
    ]


def list_items(db: Session, tenant: TenantContext, list_id: uuid.UUID) -> List[DeliveryListItem]:
    return list(
        db.scalars(
            scoped_select(DeliveryListItem, tenant)
            .where(DeliveryListItem.delivery_list_id == list_id)
            .order_by(DeliveryListItem.created_at, DeliveryListItem.id)
        )
    )


def item_stock(item: DeliveryListItem, info: Optional[ProductInfo]) -> Optional[ItemStock]:
    if info is None:
        return None
    shortfall = max(item.quantity - info.total, ZERO)
    return ItemStock(
        total_quantity=info.total, product_active=info.is_active,
        unit_allows_fractions=info.allows_fractions, exceeds_available=item.quantity > info.total, shortfall=shortfall,
    )


def item_response(item: DeliveryListItem, info: Optional[ProductInfo]) -> ItemResponse:
    response = ItemResponse.model_validate(item)
    response.stock = item_stock(item, info)
    return response


def detail(db: Session, tenant: TenantContext, gateway: InventoryGateway, delivery_list: DeliveryList) -> DeliveryListDetail:
    """The list with its items and LIVE stock. If the Inventory Service cannot be asked, the list is still shown (it is
    our own data) with stock_status = 'unavailable' instead of failing."""
    from app import dispatches  # imported here: dispatches builds on this module

    items = list_items(db, tenant, delivery_list.id)
    infos: Dict[uuid.UUID, ProductInfo] = {}
    stock_status = "ok"
    if items:
        try:
            infos = gateway.products(i.product_id for i in items)
        except InventoryUnavailable:
            stock_status = "unavailable"
    sums = dispatches.list_quantities(db, tenant, items)
    rendered = []
    for i in items:
        response = item_response(i, infos.get(i.product_id))
        done, pending = sums[i.id]
        response.dispatched_quantity, response.pending_quantity = done, pending
        response.remaining_quantity = max(i.quantity - done - pending, Decimal("0.0000"))
        rendered.append(response)
    (summary,) = summaries(db, tenant, [delivery_list])
    return DeliveryListDetail(
        **summary.model_dump(),
        items=rendered,
        stock_status=stock_status,
        items_exceeding_stock=sum(1 for r in rendered if r.stock and r.stock.exceeds_available),
        dispatches=dispatches.dispatches_of_list(db, tenant, delivery_list.id),
        can_dispatch=delivery_list.status in dispatches.DISPATCHABLE_LIST_STATUSES and any(r.remaining_quantity > 0 for r in rendered),
    )


# --- validating what a caller asks for -------------------------------------------------------------------------------
def fetch_product(gateway: InventoryGateway, product_id: uuid.UUID) -> ProductInfo:
    try:
        found = gateway.products([product_id])
    except InventoryUnavailable:
        raise unavailable_error()
    info = found.get(product_id)
    if info is None:  # does not exist, or belongs to another organization: the same answer
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found.")
    return info


def check_quantity(info: ProductInfo, quantity: Decimal) -> None:
    if not info.allows_fractions and quantity != quantity.to_integral_value():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Quantity must be a whole number: {info.name} is counted in '{info.unit}'.",
        )


def require_active_product(info: ProductInfo) -> None:
    if not info.is_active:
        raise conflict(f"{info.name} is archived and cannot be added to a delivery list. Restore it in Products first.")


# --- item operations -----------------------------------------------------------------------------------------------
def find_item(db: Session, tenant: TenantContext, list_id: uuid.UUID, item_id: uuid.UUID) -> DeliveryListItem:
    item = get_scoped(db, DeliveryListItem, tenant, item_id)
    if item is None or item.delivery_list_id != list_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
    return item


def duplicate_error(item: DeliveryListItem) -> HTTPException:
    return conflict(
        f"{item.product_name} ({item.product_sku}) is already on this list with a quantity of {human(item.quantity)} {item.unit}. "
        "Edit that line, or increase its quantity explicitly; scanning the product again never adds to it by itself.",
        code="duplicate_item",
        item={"id": str(item.id), "quantity": format(item.quantity, "f"), "unit": item.unit, "product_name": item.product_name},
    )


def add_item(db: Session, tenant: TenantContext, gateway: InventoryGateway, list_id: uuid.UUID, product_id: uuid.UUID,
             quantity: Decimal) -> DeliveryListItem:
    info = fetch_product(gateway, product_id)
    require_active_product(info)
    check_quantity(info, quantity)

    delivery_list = get_list_or_404(db, tenant, list_id, lock=True)  # serializes concurrent adds to the same list
    require_draft(delivery_list)
    require_active_client(db, tenant, delivery_list)
    existing = db.scalar(scoped_select(DeliveryListItem, tenant).where(DeliveryListItem.delivery_list_id == list_id, DeliveryListItem.product_id == product_id))
    if existing is not None:
        db.rollback()
        raise duplicate_error(existing)
    item = DeliveryListItem(
        organization_id=tenant.organization_id, delivery_list_id=list_id, product_id=info.id, product_sku=info.sku,
        product_name=info.name, quantity=quantity, unit=info.unit,
    )
    db.add(item)
    try:
        db.commit()
    except IntegrityError:  # the unique (list, product) constraint caught a race
        db.rollback()
        existing = db.scalar(scoped_select(DeliveryListItem, tenant).where(DeliveryListItem.delivery_list_id == list_id, DeliveryListItem.product_id == product_id))
        if existing is not None:
            raise duplicate_error(existing)
        raise
    db.refresh(item)
    return item


def update_item(db: Session, tenant: TenantContext, gateway: InventoryGateway, list_id: uuid.UUID, item_id: uuid.UUID, changes: dict) -> DeliveryListItem:
    delivery_list = get_list_or_404(db, tenant, list_id, lock=True)
    require_draft(delivery_list)
    item = find_item(db, tenant, list_id, item_id)
    if "quantity" in changes:
        info = fetch_product(gateway, item.product_id)
        require_active_product(info)
        check_quantity(info, changes["quantity"])
        item.quantity = changes["quantity"]
    db.commit()
    db.refresh(item)
    return item


def increase_item(db: Session, tenant: TenantContext, gateway: InventoryGateway, list_id: uuid.UUID, item_id: uuid.UUID, amount: Decimal) -> DeliveryListItem:
    delivery_list = get_list_or_404(db, tenant, list_id, lock=True)
    require_draft(delivery_list)
    item = find_item(db, tenant, list_id, item_id)
    info = fetch_product(gateway, item.product_id)
    require_active_product(info)
    new_quantity = item.quantity + amount
    check_quantity(info, new_quantity)
    if new_quantity >= Decimal(10) ** 14:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That quantity is too large.")
    item.quantity = new_quantity
    db.commit()
    db.refresh(item)
    return item


def remove_item(db: Session, tenant: TenantContext, list_id: uuid.UUID, item_id: uuid.UUID) -> None:
    delivery_list = get_list_or_404(db, tenant, list_id, lock=True)
    require_draft(delivery_list)
    item = find_item(db, tenant, list_id, item_id)
    db.delete(item)  # only a line of a draft note: no stock was ever involved
    try:
        db.commit()
    except IntegrityError:  # a cancelled dispatch still refers to it: the history stays
        db.rollback()
        raise conflict(f"{item.product_name} cannot be removed: it appears in the dispatch history of this list.")


# --- status -------------------------------------------------------------------------------------------------------------
def change_status(db: Session, tenant: TenantContext, gateway: InventoryGateway, list_id: uuid.UUID, target: str) -> DeliveryList:
    delivery_list = get_list_or_404(db, tenant, list_id, lock=True)
    if delivery_list.status == target:
        db.rollback()
        return delivery_list  # already there: harmless to repeat
    if (delivery_list.status, target) not in TRANSITIONS:
        if target == "cancelled" and delivery_list.status in ("partially_dispatched", "dispatched"):
            raise conflict(
                f"{delivery_list.number} already has goods dispatched against it, so it cannot be cancelled: a cancellation would hide that "
                "the goods were delivered. The dispatches stay as the record."
            )
        if target == "draft" and delivery_list.status in ("partially_dispatched", "dispatched"):
            raise conflict(f"{delivery_list.number} has goods dispatched against it and can no longer be reopened for editing.")
        raise conflict(f"{delivery_list.number} is {delivery_list.status} and cannot become {target}.")
    if target in ("cancelled", "draft") and delivery_list.status == "ready":
        from app.models import Dispatch

        dispatch_rows = list(db.scalars(scoped_select(Dispatch, tenant).where(Dispatch.delivery_list_id == list_id)))
        if any(d.status in ("posting", "confirmed") for d in dispatch_rows):
            raise conflict(
                f"{delivery_list.number} has goods dispatched (or being dispatched) against it, so it cannot be "
                + ("cancelled: a cancellation would hide that the goods left." if target == "cancelled" else "reopened for editing.")
            )
        for draft in (d for d in dispatch_rows if d.status == "draft"):  # unfinished drafts go with the cancellation / reopening
            draft.status, draft.cancelled_at, draft.cancelled_by_email = "cancelled", datetime.now(timezone.utc), tenant.email
        db.flush()
    if target == "ready":
        require_active_client(db, tenant, delivery_list)
        items = list_items(db, tenant, list_id)
        if not items:
            raise conflict("Add at least one product before marking the list Ready.")
        try:
            infos = gateway.products(i.product_id for i in items)
        except InventoryUnavailable:
            raise unavailable_error()
        problems = [f"{i.product_name} ({i.product_sku})" for i in items if i.product_id not in infos or not infos[i.product_id].is_active]
        if problems:
            raise conflict("These products are no longer available (archived or missing): " + ", ".join(problems) + ". Remove them first.")
    delivery_list.status = target
    db.commit()
    db.refresh(delivery_list)
    return delivery_list
