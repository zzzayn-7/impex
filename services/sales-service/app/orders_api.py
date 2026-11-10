"""Sales order endpoints. Every route depends on `require_active_tenant`; none accepts an organization id.

Saving an order books its stock in the Inventory Service (see app/orders.py for the workflow and its guarantees). Nothing here deducts
stock, invoices or posts anything to Finance: that happens only when a dispatch is confirmed, and later through the invoice.
"""
import re
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app import delivery, order_invoice, orders
from app.auth import TenantContext, require_active_tenant
from app.database import get_db
from app.inventory import InventoryGateway, get_gateway
from app.schemas import DeliveryListDetail, GeneratedInvoice, OrderCancel, OrderCreate, OrderDetail, OrderPage, OrderUpdate

router = APIRouter(prefix="/api/v1/sales")
Tenant = Depends(require_active_tenant)

IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,100}$")


def idempotency_key(key: Optional[str] = Header(default=None, alias="Idempotency-Key")) -> str:
    key = (key or "").strip()
    if not key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The Idempotency-Key header is required to save an order.")
    if not IDEMPOTENCY_KEY_RE.match(key):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key must be 8-100 characters: letters, digits and . _ : -")
    return key


def _failure(outcome: orders.Outcome) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        {"message": outcome.message, "code": outcome.code or "inventory_rejected", **({"shortages": outcome.shortages} if outcome.shortages else {})},
    )


def _answer(db: Session, tenant: TenantContext, gateway: InventoryGateway, order_id: uuid.UUID, outcome: orders.Outcome, response: Response, created: bool = False) -> OrderDetail:
    """Render the order after an operation: a definitive refusal is a 409 with the reason; a booking that is not confirmed yet is a 202
    (the order exists, it is NOT booked, and asking again finishes it without booking twice)."""
    if outcome.kind == "rejected":
        raise _failure(outcome)
    order = orders.get_order_or_404(db, tenant, order_id)
    if outcome.kind == "pending":
        response.status_code = status.HTTP_202_ACCEPTED
        return orders.detail(db, tenant, gateway, order, message="The inventory service has not confirmed the stock booking yet. Nothing is treated as booked until it does; retry to finish it.")
    if created:
        response.status_code = status.HTTP_201_CREATED
    return orders.detail(db, tenant, gateway, order)


@router.post("/orders", response_model=OrderDetail, status_code=status.HTTP_201_CREATED, tags=["Sales orders"])
def create_order(
    payload: OrderCreate, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key),
    gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db),
):
    """Save an order for one of your clients: the products and quantities required. The stock is BOOKED immediately (all lines or none),
    an order number (SO-000001) and a linked delivery list (DL-000001, Ready at once) are generated. Physical stock is not touched.
    201 the first time; a retry with the same Idempotency-Key answers 200 with the same order and books nothing twice; 202 means the
    booking is not confirmed yet (the order is saved but not active)."""
    order, replayed, outcome = orders.create_order(db, tenant, gateway, payload, key)
    result = _answer(db, tenant, gateway, order.id, outcome, response, created=not replayed)
    if replayed and response.status_code != status.HTTP_202_ACCEPTED:
        response.status_code = status.HTTP_200_OK
    return result


@router.get("/orders", response_model=OrderPage, tags=["Sales orders"])
def list_orders(
    view: Literal["active", "delivered"] = Query(default="active", description="active: still to be delivered. delivered: completed within the last 24 hours."),
    q: Optional[str] = Query(default=None, max_length=100, description="Search order number, delivery list number or client name"),
    client_id: Optional[uuid.UUID] = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    gateway: InventoryGateway = Depends(get_gateway),
    db: Session = Depends(get_db),
):
    items, total = orders.list_orders(db, tenant, gateway, view=view, q=q, client_id=client_id, limit=limit, offset=offset)
    return OrderPage(items=items, total=total, limit=limit, offset=offset)


@router.get("/orders/{order_id}", response_model=OrderDetail, tags=["Sales orders"])
def get_order(order_id: uuid.UUID, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """The order with its lines (ordered / dispatched / remaining) and the live physical, reserved and available stock of each product."""
    order = orders.get_order_or_404(db, tenant, order_id)
    if order.pending_action is not None:  # a booking left half way is finished before it is shown
        try:
            orders.reconcile(db, tenant, gateway, order_id)
        except HTTPException:
            raise
        except Exception:
            db.rollback()
        order = orders.get_order_or_404(db, tenant, order_id)
    return orders.detail(db, tenant, gateway, order)


@router.patch("/orders/{order_id}", response_model=OrderDetail, tags=["Sales orders"])
def update_order(order_id: uuid.UUID, payload: OrderUpdate, response: Response, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """Change an active order to exactly the given lines. The reservation is adjusted by the difference (released, or booked only if the
    extra units are available), all or nothing, and only then does the order change. Refused while a dispatch is being posted, and for
    quantities below what was already dispatched."""
    order, outcome = orders.edit_order(db, tenant, gateway, order_id, payload)
    return _answer(db, tenant, gateway, order.id, outcome, response)


@router.post("/orders/{order_id}/cancel", response_model=OrderDetail, tags=["Sales orders"])
def cancel_order(order_id: uuid.UUID, response: Response, payload: Optional[OrderCancel] = None, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """Cancel an order nothing was dispatched from: its delivery list is cancelled and every reserved unit is released. Repeating it is
    harmless. A minimal record is kept (nothing is deleted)."""
    order, outcome = orders.cancel_order(db, tenant, gateway, order_id, payload.version if payload else None)
    return _answer(db, tenant, gateway, order.id, outcome, response)


@router.post("/orders/{order_id}/cancel-remaining", response_model=OrderDetail, tags=["Sales orders"])
def cancel_remaining(order_id: uuid.UUID, response: Response, payload: Optional[OrderCancel] = None, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """After a partial delivery: cancel what has not been delivered. Confirmed quantities and dispatches are untouched; the outstanding
    reservation is released and the order is closed."""
    order, outcome = orders.cancel_remaining(db, tenant, gateway, order_id, payload.version if payload else None)
    return _answer(db, tenant, gateway, order.id, outcome, response)


@router.post("/orders/{order_id}/reconcile", response_model=OrderDetail, tags=["Sales orders"])
def reconcile_order(order_id: uuid.UUID, response: Response, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """Finish a booking or change that was left half way (timeout, outage, crash) by asking the Inventory Service again with the same key."""
    orders.get_order_or_404(db, tenant, order_id)
    outcome = orders.reconcile(db, tenant, gateway, order_id)
    return _answer(db, tenant, gateway, order_id, outcome, response)


@router.post("/orders/{order_id}/invoice", response_model=GeneratedInvoice, status_code=status.HTTP_201_CREATED, tags=["Sales orders"])
def generate_order_invoice(order_id: uuid.UUID, response: Response, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """Generate Invoice for a dispatched order: a DRAFT invoice for its client from the goods that were dispatched, priced with the products' current
    selling price (see app/order_invoice.py). Changes no stock. Repeating it returns the invoice the order already has (200) instead of a second one."""
    invoice, created = order_invoice.generate(db, tenant, gateway, order_id)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return GeneratedInvoice(invoice=invoice, created=created)


@router.get("/orders/{order_id}/delivery-list", response_model=DeliveryListDetail, tags=["Sales orders"])
def order_delivery_list(order_id: uuid.UUID, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """The delivery list generated for this order."""
    order = orders.get_order_or_404(db, tenant, order_id)
    return delivery.detail(db, tenant, gateway, delivery.get_list_or_404(db, tenant, order.delivery_list_id))


@router.post("/delivery-lists/{list_id}/book", response_model=OrderDetail, tags=["Delivery lists"])
def book_delivery_list(list_id: uuid.UUID, response: Response, tenant: TenantContext = Tenant, gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db)):
    """Book an older delivery list (one made before stock reservations existed): its quantities are reserved atomically and it becomes a
    sales order. The same thing marking a draft list Ready does."""
    order, outcome = orders.book_list(db, tenant, gateway, list_id)
    return _answer(db, tenant, gateway, order.id, outcome, response)
