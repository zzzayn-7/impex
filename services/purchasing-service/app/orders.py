"""Purchase-order business rules.

The rules that matter most:
  * Nothing here changes inventory, ever. Creating, editing, ordering or cancelling an order never adds stock, writes a
    stock movement or changes a product's prices: this module never calls a write endpoint of the Inventory Service.
  * Product facts (name, SKU, unit, active) always come from the Inventory Service, asked with the caller's own token.
  * Money is exact: line_total = round(quantity * unit_price, 4) with half-up rounding, the order total is the sum of the
    line totals, and everything is calculated here (the database re-checks every line total).
  * A draft can be edited freely. Ordering freezes it: the database refuses any later change to the details or the lines.
  * Creating an order is idempotent per Idempotency-Key, and numbers come from an atomically incremented counter.
"""
import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import TenantContext
from app.inventory import InventoryGateway, InventoryUnavailable, ProductInfo, unavailable_error
from app.models import GoodsReceipt, PurchaseOrder, PurchaseOrderCounter, PurchaseOrderLine, PurchaseOrderRequest, Supplier
from app.schemas import (
    LineRemoved,
    LineResponse,
    LineResult,
    PurchaseOrderDetail,
    PurchaseOrderSummary,
    SupplierRef,
)
from app.tenancy import get_scoped, get_scoped_or_404, scoped_select

logger = logging.getLogger("impex.purchasing")
ZERO = Decimal("0")
CENT = Decimal("0.0001")
MAX_LINES = 500
LIMIT = Decimal(10) ** 14  # what fits a NUMERIC(18,4) column
# Placing and cancelling are the only moves a user asks for. Partially Received / Received are reached only by confirming goods receipts.
TRANSITIONS = {("draft", "ordered"): "ordered", ("draft", "cancelled"): "cancelled", ("ordered", "cancelled"): "cancelled"}


def conflict(message: str, **extra) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, {"message": message, **extra} if extra else message)


def human(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _user_id(tenant: TenantContext) -> uuid.UUID:
    try:
        return uuid.UUID(tenant.user_id)
    except ValueError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Organization administrator permission required")


# --- money ----------------------------------------------------------------------------------------------------------------
def line_total(quantity: Decimal, unit_price: Decimal) -> Decimal:
    """quantity x unit price, rounded half-up to 4 decimals - identical to PostgreSQL's round(quantity * unit_price, 4)."""
    with localcontext() as context:  # two 18-digit numbers multiplied need more than Python's default 28 digits
        context.prec = 80
        total = (quantity * unit_price).quantize(CENT, rounding=ROUND_HALF_UP)
    if total >= LIMIT:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That line total is too large. Check the quantity and the price.")
    return total


def order_total(db: Session, tenant: TenantContext, order_id: uuid.UUID) -> Decimal:
    return db.scalar(
        select(func.coalesce(func.sum(PurchaseOrderLine.line_total), 0)).where(
            PurchaseOrderLine.organization_id == tenant.organization_id, PurchaseOrderLine.purchase_order_id == order_id
        )
    )


# --- numbering ---------------------------------------------------------------------------------------------------------------
def next_number(db: Session, tenant: TenantContext) -> str:
    """PO-000001, PO-000002, ... per organization. The counter row is incremented atomically inside the creating
    transaction, so two requests at the same moment never get the same number and a failed creation leaves no gap."""
    row = db.execute(
        pg_insert(PurchaseOrderCounter)
        .values(organization_id=tenant.organization_id, last_number=1)
        .on_conflict_do_update(index_elements=["organization_id"], set_={"last_number": PurchaseOrderCounter.last_number + 1})
        .returning(PurchaseOrderCounter.last_number)
    ).one()
    return f"PO-{row[0]:06d}"


# --- loading ---------------------------------------------------------------------------------------------------------------------
def get_supplier_or_404(db: Session, tenant: TenantContext, supplier_id: uuid.UUID) -> Supplier:
    return get_scoped_or_404(db, Supplier, tenant, supplier_id, "Supplier")


def get_order_or_404(db: Session, tenant: TenantContext, order_id: uuid.UUID, *, lock: bool = False) -> PurchaseOrder:
    query = scoped_select(PurchaseOrder, tenant).where(PurchaseOrder.id == order_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    found = db.scalar(query)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Purchase order not found.")
    return found


def require_draft(order: PurchaseOrder) -> None:
    if order.status != "draft":
        raise conflict(
            f"{order.number} is {order.status}. Only a draft purchase order can be changed; an ordered one is frozen"
            + (" and a cancelled one is kept for history." if order.status == "cancelled" else ".")
        )


def require_active_supplier(db: Session, tenant: TenantContext, order: PurchaseOrder) -> Supplier:
    supplier = get_supplier_or_404(db, tenant, order.supplier_id)
    if not supplier.is_active:
        raise conflict(f"{supplier.name} is inactive. Reactivate the supplier before changing or placing this order.")
    return supplier


def list_lines(db: Session, tenant: TenantContext, order_id: uuid.UUID) -> List[PurchaseOrderLine]:
    return list(
        db.scalars(
            scoped_select(PurchaseOrderLine, tenant)
            .where(PurchaseOrderLine.purchase_order_id == order_id)
            .order_by(PurchaseOrderLine.created_at, PurchaseOrderLine.id)
        )
    )


# --- summaries and details -------------------------------------------------------------------------------------------------------
def summaries(db: Session, tenant: TenantContext, orders: List[PurchaseOrder]) -> List[PurchaseOrderSummary]:
    if not orders:
        return []
    suppliers = {s.id: s for s in db.scalars(scoped_select(Supplier, tenant).where(Supplier.id.in_({o.supplier_id for o in orders})))}
    aggregates = {
        order_id: (count, total)
        for order_id, count, total in db.execute(
            select(PurchaseOrderLine.purchase_order_id, func.count(), func.coalesce(func.sum(PurchaseOrderLine.line_total), 0))
            .where(PurchaseOrderLine.organization_id == tenant.organization_id, PurchaseOrderLine.purchase_order_id.in_([o.id for o in orders]))
            .group_by(PurchaseOrderLine.purchase_order_id)
        ).all()
    }
    out = []
    for o in orders:
        supplier = suppliers[o.supplier_id]
        count, total = aggregates.get(o.id, (0, ZERO))
        out.append(
            PurchaseOrderSummary(
                id=o.id, number=o.number, supplier=SupplierRef(id=supplier.id, name=supplier.name, code=supplier.code, is_active=supplier.is_active),
                supplier_reference=o.supplier_reference, order_date=o.order_date, expected_delivery_date=o.expected_delivery_date,
                currency_code=o.currency_code, notes=o.notes, status=o.status, line_count=count, total_amount=total,
                created_by_email=o.created_by_email, ordered_at=o.ordered_at, ordered_by_email=o.ordered_by_email,
                cancelled_at=o.cancelled_at, cancelled_by_email=o.cancelled_by_email, created_at=o.created_at, updated_at=o.updated_at,
            )
        )
    return out


def detail(db: Session, tenant: TenantContext, order: PurchaseOrder) -> PurchaseOrderDetail:
    from app import receipts  # imported here: receipts builds on this module

    (summary,) = summaries(db, tenant, [order])
    stored = list_lines(db, tenant, order.id)
    sums = receipts.order_quantities(db, tenant, stored)
    lines = []
    for l in stored:
        received, pending = sums[l.id]
        lines.append(
            LineResponse.model_validate(l).model_copy(
                update={"received_quantity": received, "pending_quantity": pending, "remaining_quantity": max(l.quantity - received - pending, Decimal("0.0000"))}
            )
        )
    can_receive = order.status in receipts.RECEIVABLE_ORDER_STATUSES and any(l.remaining_quantity > 0 for l in lines)
    return PurchaseOrderDetail(
        **summary.model_dump(), lines=lines, frozen=order.status != "draft",
        receipts=receipts.receipts_of_order(db, tenant, order.id), can_receive=can_receive,
    )


# --- creating (idempotent) ------------------------------------------------------------------------------------------------------------
def create_order(db: Session, tenant: TenantContext, payload, key: str):
    """Returns (order, replayed). A repeated request with the same key returns the first order and creates nothing."""
    fields = payload.model_dump(mode="json")
    request_hash = hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()
    claimed = db.execute(
        pg_insert(PurchaseOrderRequest)
        .values(organization_id=tenant.organization_id, idempotency_key=key, request_hash=request_hash)
        .on_conflict_do_nothing(index_elements=["organization_id", "idempotency_key"])
        .returning(PurchaseOrderRequest.id)
    ).first()
    if claimed is None:  # this key was used before: replay (a concurrent duplicate waited for the first to commit)
        db.rollback()
        previous = db.scalar(scoped_select(PurchaseOrderRequest, tenant).where(PurchaseOrderRequest.idempotency_key == key))
        if previous is None or previous.purchase_order_id is None:
            raise conflict("The request was being processed. Please retry.")
        if previous.request_hash != request_hash:
            raise conflict("This Idempotency-Key was already used for a different request. Use a new key for a new order.")
        return get_order_or_404(db, tenant, previous.purchase_order_id), True

    try:
        supplier = get_supplier_or_404(db, tenant, payload.supplier_id)
        if not supplier.is_active:
            raise conflict(f"{supplier.name} is inactive. Reactivate the supplier before creating a purchase order for them.")
        order_date = payload.order_date or datetime.now(timezone.utc).date()
        if payload.expected_delivery_date and payload.expected_delivery_date < order_date:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The expected delivery date cannot be before the order date.")
        order = PurchaseOrder(
            organization_id=tenant.organization_id, supplier_id=supplier.id, number=next_number(db, tenant),
            supplier_reference=payload.supplier_reference, order_date=order_date, expected_delivery_date=payload.expected_delivery_date,
            currency_code=payload.currency_code, notes=payload.notes, status="draft", created_by=_user_id(tenant), created_by_email=tenant.email,
        )
        db.add(order)
        db.flush()
        db.execute(
            PurchaseOrderRequest.__table__.update()
            .where(PurchaseOrderRequest.id == claimed[0])
            .values(purchase_order_id=order.id)
        )
        db.commit()
    except Exception:
        db.rollback()  # the claimed key and the number are released together with everything else
        raise
    db.refresh(order)
    return order, False


# --- editing the header ---------------------------------------------------------------------------------------------------------------------
def update_header(db: Session, tenant: TenantContext, order_id: uuid.UUID, changes: dict) -> PurchaseOrder:
    order = get_order_or_404(db, tenant, order_id, lock=True)
    require_draft(order)
    if "supplier_id" in changes and changes["supplier_id"] != order.supplier_id:
        supplier = get_supplier_or_404(db, tenant, changes["supplier_id"])
        if not supplier.is_active:
            raise conflict(f"{supplier.name} is inactive. Choose an active supplier.")
    else:
        require_active_supplier(db, tenant, order)
    if "currency_code" in changes and changes["currency_code"] != order.currency_code and list_lines(db, tenant, order.id):
        raise conflict("The currency cannot be changed once the order has lines: the prices would silently change meaning. Remove the lines first.")
    order_date = changes.get("order_date", order.order_date)
    expected = changes["expected_delivery_date"] if "expected_delivery_date" in changes else order.expected_delivery_date
    if expected is not None and expected < order_date:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The expected delivery date cannot be before the order date.")
    for field, value in changes.items():
        setattr(order, field, value)
    db.commit()
    db.refresh(order)
    return order


# --- validating what a caller asks for -------------------------------------------------------------------------------------------------------------
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
            status.HTTP_422_UNPROCESSABLE_ENTITY, f"Quantity must be a whole number: {info.name} is counted in '{info.unit}'."
        )


def require_active_product(info: ProductInfo) -> None:
    if not info.is_active:
        raise conflict(f"{info.name} is archived and cannot be ordered. Restore it in Products first.")


# --- line operations -------------------------------------------------------------------------------------------------------------------------------
def find_line(db: Session, tenant: TenantContext, order_id: uuid.UUID, line_id: uuid.UUID) -> PurchaseOrderLine:
    line = get_scoped(db, PurchaseOrderLine, tenant, line_id)
    if line is None or line.purchase_order_id != order_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Line not found.")
    return line


def duplicate_error(line: PurchaseOrderLine) -> HTTPException:
    return conflict(
        f"{line.product_name} ({line.product_sku}) is already on this order: {human(line.quantity)} {line.unit} at {human(line.unit_price)}. "
        "Edit that line instead of adding the product again.",
        code="duplicate_line",
        line={"id": str(line.id), "quantity": format(line.quantity, "f"), "unit": line.unit, "unit_price": format(line.unit_price, "f"), "product_name": line.product_name},
    )


def result(db: Session, tenant: TenantContext, order: PurchaseOrder, line: PurchaseOrderLine) -> LineResult:
    count = db.scalar(select(func.count()).select_from(PurchaseOrderLine).where(PurchaseOrderLine.organization_id == tenant.organization_id, PurchaseOrderLine.purchase_order_id == order.id))
    return LineResult(line=LineResponse.model_validate(line), line_count=count, total_amount=order_total(db, tenant, order.id), currency_code=order.currency_code)


def add_line(db: Session, tenant: TenantContext, gateway: InventoryGateway, order_id: uuid.UUID, payload) -> LineResult:
    require_draft(get_order_or_404(db, tenant, order_id))  # fail fast, before asking another service anything (re-checked under the lock below)
    db.rollback()
    info = fetch_product(gateway, payload.product_id)
    require_active_product(info)
    check_quantity(info, payload.quantity)
    total = line_total(payload.quantity, payload.unit_price)

    order = get_order_or_404(db, tenant, order_id, lock=True)  # serializes concurrent edits of the same order
    require_draft(order)
    require_active_supplier(db, tenant, order)
    existing = db.scalar(scoped_select(PurchaseOrderLine, tenant).where(PurchaseOrderLine.purchase_order_id == order_id, PurchaseOrderLine.product_id == payload.product_id))
    if existing is not None:
        db.rollback()
        raise duplicate_error(existing)
    if db.scalar(select(func.count()).select_from(PurchaseOrderLine).where(PurchaseOrderLine.organization_id == tenant.organization_id, PurchaseOrderLine.purchase_order_id == order_id)) >= MAX_LINES:
        raise conflict(f"An order can have at most {MAX_LINES} lines.")
    line = PurchaseOrderLine(
        organization_id=tenant.organization_id, purchase_order_id=order_id, product_id=info.id, product_sku=info.sku, product_name=info.name,
        unit=info.unit, quantity=payload.quantity, unit_price=payload.unit_price, line_total=total, notes=payload.notes,
    )
    db.add(line)
    try:
        db.commit()
    except IntegrityError:  # the unique (order, product) constraint caught a race
        db.rollback()
        existing = db.scalar(scoped_select(PurchaseOrderLine, tenant).where(PurchaseOrderLine.purchase_order_id == order_id, PurchaseOrderLine.product_id == payload.product_id))
        if existing is not None:
            raise duplicate_error(existing)
        raise
    db.refresh(line)
    return result(db, tenant, order, line)


def update_line(db: Session, tenant: TenantContext, gateway: InventoryGateway, order_id: uuid.UUID, line_id: uuid.UUID, changes: dict) -> LineResult:
    order = get_order_or_404(db, tenant, order_id, lock=True)
    require_draft(order)
    line = find_line(db, tenant, order_id, line_id)
    quantity = changes.get("quantity", line.quantity)
    unit_price = changes.get("unit_price", line.unit_price)
    if "quantity" in changes:
        info = fetch_product(gateway, line.product_id)
        require_active_product(info)
        check_quantity(info, quantity)
    if "notes" in changes:
        line.notes = changes["notes"]
    line.quantity, line.unit_price, line.line_total = quantity, unit_price, line_total(quantity, unit_price)
    db.commit()
    db.refresh(line)
    return result(db, tenant, order, line)


def remove_line(db: Session, tenant: TenantContext, order_id: uuid.UUID, line_id: uuid.UUID) -> LineRemoved:
    order = get_order_or_404(db, tenant, order_id, lock=True)
    require_draft(order)
    line = find_line(db, tenant, order_id, line_id)
    db.delete(line)  # a line of a draft is only a note: no stock or price was ever involved
    db.commit()
    count = db.scalar(select(func.count()).select_from(PurchaseOrderLine).where(PurchaseOrderLine.organization_id == tenant.organization_id, PurchaseOrderLine.purchase_order_id == order_id))
    return LineRemoved(line_count=count, total_amount=order_total(db, tenant, order_id), currency_code=order.currency_code)


# --- delete ------------------------------------------------------------------------------------------------------------------------------------------
def delete_order(db: Session, tenant: TenantContext, order_id: uuid.UUID) -> None:
    """Delete a purchase order FOR GOOD (the organization's administrator asked for it, having been shown a confirmation).

    Allowed while no goods were ever received against it: a draft, a placed (ordered) or a cancelled order that has NO goods receipt of any kind. Its lines go with it, and so do
    the remembered create-requests (so the Idempotency-Key is free again). Refused (409) when the order is partially received or received, or has any goods receipt:
    the goods arrived, stock moved and Finance may have posted it, and receipts are never deleted, so the order they name must stay. The database refuses the same
    cases on its own, and only lets a delete through inside this one transaction. It never touches inventory, stock or prices. The order number is NOT reused.
    """
    order = get_order_or_404(db, tenant, order_id, lock=True)
    if order.status in ("partially_received", "received"):
        raise conflict(f"{order.number} has goods received against it, so it cannot be deleted: the goods arrived and the receipts stay as the record.")
    receipts = db.scalar(select(func.count()).select_from(GoodsReceipt).where(GoodsReceipt.organization_id == tenant.organization_id, GoodsReceipt.purchase_order_id == order.id))
    if receipts:
        raise conflict(
            f"{order.number} has goods receipts ({receipts}), so it cannot be deleted: receipts are never deleted, so the order they name stays."
            + ("" if order.status == "cancelled" else " You can cancel the order instead.")
        )
    number = order.number
    db.execute(text("SET LOCAL app.deleting_purchase_order = 'on'"))  # for this transaction only; the database checks the rules above again
    db.execute(delete(PurchaseOrderLine).where(PurchaseOrderLine.organization_id == tenant.organization_id, PurchaseOrderLine.purchase_order_id == order.id))
    db.execute(delete(PurchaseOrderRequest).where(PurchaseOrderRequest.organization_id == tenant.organization_id, PurchaseOrderRequest.purchase_order_id == order.id))
    db.execute(delete(PurchaseOrder).where(PurchaseOrder.organization_id == tenant.organization_id, PurchaseOrder.id == order.id))
    db.commit()
    logger.info("purchase order %s (%s) deleted by %s", number, order_id, tenant.email)


# --- status ------------------------------------------------------------------------------------------------------------------------------------------
def change_status(db: Session, tenant: TenantContext, gateway: InventoryGateway, order_id: uuid.UUID, target: str) -> PurchaseOrder:
    order = get_order_or_404(db, tenant, order_id, lock=True)
    if order.status == target:
        db.rollback()
        return order  # already there: harmless to repeat
    if (order.status, target) not in TRANSITIONS:
        if target == "cancelled" and order.status in ("partially_received", "received"):
            raise conflict(
                f"{order.number} already has goods received against it, so it cannot be cancelled: a cancellation would hide that "
                "the goods arrived. The receipts stay as the record."
            )
        raise conflict(f"{order.number} is {order.status} and cannot become {target}.")
    if target == "cancelled" and order.status == "ordered":
        from app.models import GoodsReceipt

        receipts = list(db.scalars(scoped_select(GoodsReceipt, tenant).where(GoodsReceipt.purchase_order_id == order.id)))
        if any(r.status in ("posting", "confirmed") for r in receipts):
            raise conflict(
                f"{order.number} has goods received (or being received) against it, so it cannot be cancelled: "
                "a cancellation would hide that the goods arrived."
            )
        for draft in (r for r in receipts if r.status == "draft"):  # unfinished drafts of a cancelled order are cancelled with it
            draft.status, draft.cancelled_at, draft.cancelled_by_email = "cancelled", datetime.now(timezone.utc), tenant.email
        db.flush()
    now = datetime.now(timezone.utc)
    if target == "ordered":
        require_active_supplier(db, tenant, order)
        lines = list_lines(db, tenant, order_id)
        if not lines:
            raise conflict("Add at least one product before placing the order.")
        try:
            infos = gateway.products(l.product_id for l in lines)
        except InventoryUnavailable:
            raise unavailable_error()
        missing = [f"{l.product_name} ({l.product_sku})" for l in lines if l.product_id not in infos or not infos[l.product_id].is_active]
        if missing:
            raise conflict("These products are no longer available (archived or missing): " + ", ".join(missing) + ". Remove them first.")
        for l in lines:  # the order is frozen with the facts as they are NOW, from the Inventory Service
            info = infos[l.product_id]
            if not info.allows_fractions and l.quantity != l.quantity.to_integral_value():
                raise conflict(f"{info.name} is now counted in '{info.unit}', which needs a whole number, but the order has {human(l.quantity)}. Change the quantity first.")
            l.product_sku, l.product_name, l.unit = info.sku, info.name, info.unit
        db.flush()  # the snapshots are written while the order is still a draft; only then does it become Ordered
        order.ordered_at, order.ordered_by_email = now, tenant.email
    else:
        order.cancelled_at, order.cancelled_by_email = now, tenant.email
    order.status = target
    db.commit()
    db.refresh(order)
    return order
