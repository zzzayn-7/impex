"""Goods receiving: what arrived against a purchase order, and how it becomes stock.

The rules that matter most:

  * Drafting, scanning, reviewing and saving a receipt NEVER change stock. Stock changes only when a receipt is confirmed, and only
    through the Inventory Service's own audited, idempotent operation (see InventoryGateway.post_goods_receipt). Only the
    ACCEPTED quantity is added; a rejected quantity is a note. Prices are never sent, so a catalog price can never be overwritten.
  * Confirming is a DURABLE two-service workflow:
        1. (short transaction)  the intent is saved: draft -> posting. The quantities are now reserved against the order, so a
                                 second receipt cannot take them, and the receipt is frozen.
        2. (NO transaction)     the Inventory Service is asked, with the stable Idempotency-Key  goods-receipt-<receipt id>.
        3. (short transaction)  only when its answer is VERIFIED (the right operation, one movement per accepted line, the right
                                 product / quantity) does the receipt become confirmed, and the order Partially
                                 Received / Received.
    If anything is uncertain - timeout, outage, crash, garbled answer - the receipt STAYS `posting`. Retrying confirm (from any
    process, after any restart) asks again with the same key: the Inventory Service replays the first result instead of adding the
    goods twice. A receipt is never called confirmed on hope.
  * No over-receipt: accepted quantities of confirmed + posting receipts can never exceed the ordered quantity (checked under a
    lock on the order, and again by a database trigger). Two people receiving at once cannot both take the last units.
  * Units are never converted: a receipt line has the unit of its order line, and the Inventory Service refuses a product whose
    unit changed since.
  * Confirmed receipts are immutable and are never deleted (database-enforced).
"""
import hashlib
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.auth import TenantContext, refuse_unless_recovering
from app.inventory import InventoryGateway, InventoryUnavailable, PostingOutcome, ProductInfo, unavailable_error
from app.models import (
    GoodsReceipt,
    GoodsReceiptCounter,
    GoodsReceiptLine,
    GoodsReceiptRequest,
    PurchaseOrder,
    PurchaseOrderLine,
    Supplier,
)
from app.orders import conflict, get_order_or_404, human, list_lines
from app.schemas import (
    OrderRef,
    PostingInfo,
    ReceiptDetail,
    ReceiptLineInput,
    ReceiptLineResponse,
    ReceiptSummary,
    SupplierRef,
)
from app.tenancy import scoped_select

ZERO = Decimal("0.0000")
CENT = Decimal("0.0001")
RECEIVABLE_ORDER_STATUSES = ("ordered", "partially_received")


def _user_id(tenant: TenantContext) -> uuid.UUID:
    try:
        return uuid.UUID(tenant.user_id)
    except ValueError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Organization administrator permission required")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _database_refusal(exc: DBAPIError) -> HTTPException:
    """The database rules are the last line of defence; if one fires, say why in the words the rule was written in."""
    message = str(exc.orig).splitlines()[0] if exc.orig is not None else "the database refused the change"
    return conflict(f"That change is not allowed: {message}.")


# --- numbering ------------------------------------------------------------------------------------------------------------------
def next_number(db: Session, tenant: TenantContext) -> str:
    """GR-000001, GR-000002, ... per organization, from an atomically incremented counter inside the creating transaction."""
    row = db.execute(
        pg_insert(GoodsReceiptCounter)
        .values(organization_id=tenant.organization_id, last_number=1)
        .on_conflict_do_update(index_elements=["organization_id"], set_={"last_number": GoodsReceiptCounter.last_number + 1})
        .returning(GoodsReceiptCounter.last_number)
    ).one()
    return f"GR-{row[0]:06d}"


# --- loading --------------------------------------------------------------------------------------------------------------------
def get_receipt_or_404(db: Session, tenant: TenantContext, receipt_id: uuid.UUID, *, lock: bool = False) -> GoodsReceipt:
    query = scoped_select(GoodsReceipt, tenant).where(GoodsReceipt.id == receipt_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    found = db.scalar(query)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Goods receipt not found.")
    return found


def receipt_lines(db: Session, tenant: TenantContext, receipt_id: uuid.UUID) -> List[GoodsReceiptLine]:
    return list(
        db.scalars(
            scoped_select(GoodsReceiptLine, tenant)
            .where(GoodsReceiptLine.goods_receipt_id == receipt_id)
            .order_by(GoodsReceiptLine.created_at, GoodsReceiptLine.product_name, GoodsReceiptLine.id)
        )
    )


def received_quantities(
    db: Session, tenant: TenantContext, order_line_ids: Iterable[uuid.UUID], exclude_receipt: Optional[uuid.UUID] = None
) -> Dict[uuid.UUID, Tuple[Decimal, Decimal]]:
    """order line id -> (confirmed accepted, pending accepted) over the order's receipts, optionally leaving one receipt out.
    "Pending" is what receipts in the `posting` state have reserved."""
    ids = list(order_line_ids)
    totals: Dict[uuid.UUID, List[Decimal]] = {i: [ZERO, ZERO] for i in ids}
    if not ids:
        return {}
    query = (
        select(GoodsReceiptLine.purchase_order_line_id, GoodsReceipt.status, func.coalesce(func.sum(GoodsReceiptLine.accepted_quantity), 0))
        .join(GoodsReceipt, and_(GoodsReceipt.organization_id == GoodsReceiptLine.organization_id, GoodsReceipt.id == GoodsReceiptLine.goods_receipt_id))
        .where(
            GoodsReceiptLine.organization_id == tenant.organization_id,
            GoodsReceiptLine.purchase_order_line_id.in_(ids),
            GoodsReceipt.status.in_(("confirmed", "posting")),
        )
        .group_by(GoodsReceiptLine.purchase_order_line_id, GoodsReceipt.status)
    )
    if exclude_receipt is not None:
        query = query.where(GoodsReceipt.id != exclude_receipt)
    for line_id, receipt_status, total in db.execute(query).all():
        totals[line_id][0 if receipt_status == "confirmed" else 1] = Decimal(total).quantize(CENT)
    return {i: (v[0], v[1]) for i, v in totals.items()}


def order_quantities(db: Session, tenant: TenantContext, lines: List[PurchaseOrderLine]) -> Dict[uuid.UUID, Tuple[Decimal, Decimal]]:
    return received_quantities(db, tenant, [l.id for l in lines])


# --- order status ----------------------------------------------------------------------------------------------------------------
def explain_order_not_receivable(order: PurchaseOrder) -> HTTPException:
    reasons = {
        "draft": f"{order.number} is still a draft. Place the order before receiving goods against it.",
        "cancelled": f"{order.number} is cancelled. Goods cannot be received against it.",
        "received": f"{order.number} is already fully received. There is nothing left to receive.",
    }
    return conflict(reasons.get(order.status, f"{order.number} is {order.status}; goods cannot be received against it."))


def require_receivable_order(order: PurchaseOrder) -> None:
    if order.status not in RECEIVABLE_ORDER_STATUSES:
        raise explain_order_not_receivable(order)


def recompute_order_status(db: Session, tenant: TenantContext, order: PurchaseOrder) -> None:
    """Called inside the transaction that confirms a receipt (receipt already flushed as confirmed, order row locked): the
    order becomes Received when every line is fully received, otherwise Partially Received. The database re-checks the claim."""
    lines = list_lines(db, tenant, order.id)
    sums = order_quantities(db, tenant, lines)
    received_any = any(sums[l.id][0] > 0 for l in lines)
    everything = all(sums[l.id][0] >= l.quantity for l in lines)
    target = "received" if everything else ("partially_received" if received_any else order.status)
    if target != order.status:
        order.status = target
        db.flush()


# --- views -------------------------------------------------------------------------------------------------------------------------
def _order_ref(order: PurchaseOrder) -> OrderRef:
    return OrderRef(id=order.id, number=order.number, status=order.status)


def _supplier_ref(supplier: Supplier) -> SupplierRef:
    return SupplierRef(id=supplier.id, name=supplier.name, code=supplier.code, is_active=supplier.is_active)


def summaries(db: Session, tenant: TenantContext, receipts: List[GoodsReceipt]) -> List[ReceiptSummary]:
    if not receipts:
        return []
    orders = {o.id: o for o in db.scalars(scoped_select(PurchaseOrder, tenant).where(PurchaseOrder.id.in_({r.purchase_order_id for r in receipts})))}
    suppliers = {s.id: s for s in db.scalars(scoped_select(Supplier, tenant).where(Supplier.id.in_({o.supplier_id for o in orders.values()})))}
    counts = dict(
        db.execute(
            select(GoodsReceiptLine.goods_receipt_id, func.count())
            .where(GoodsReceiptLine.organization_id == tenant.organization_id, GoodsReceiptLine.goods_receipt_id.in_([r.id for r in receipts]))
            .group_by(GoodsReceiptLine.goods_receipt_id)
        ).all()
    )
    out = []
    for r in receipts:
        order = orders[r.purchase_order_id]
        out.append(
            ReceiptSummary(
                id=r.id, number=r.number, status=r.status, purchase_order=_order_ref(order), supplier=_supplier_ref(suppliers[order.supplier_id]),
                supplier_reference=r.supplier_reference, received_date=r.received_date, notes=r.notes, line_count=counts.get(r.id, 0),
                created_by_email=r.created_by_email, created_at=r.created_at, confirmed_at=r.confirmed_at, confirmed_by_email=r.confirmed_by_email,
                cancelled_at=r.cancelled_at, cancelled_by_email=r.cancelled_by_email, updated_at=r.updated_at,
            )
        )
    return out


def detail(db: Session, tenant: TenantContext, receipt: GoodsReceipt) -> ReceiptDetail:
    (summary,) = summaries(db, tenant, [receipt])
    lines = receipt_lines(db, tenant, receipt.id)
    order_lines = {l.id: l for l in db.scalars(scoped_select(PurchaseOrderLine, tenant).where(PurchaseOrderLine.id.in_([l.purchase_order_line_id for l in lines])))} if lines else {}
    elsewhere = received_quantities(db, tenant, order_lines.keys(), exclude_receipt=receipt.id)
    rows = []
    for l in lines:
        ordered = order_lines[l.purchase_order_line_id].quantity
        confirmed, pending = elsewhere.get(l.purchase_order_line_id, (ZERO, ZERO))
        rows.append(
            ReceiptLineResponse(
                id=l.id, purchase_order_line_id=l.purchase_order_line_id, product_id=l.product_id, product_sku=l.product_sku,
                product_name=l.product_name, unit=l.unit, ordered_quantity=ordered, received_elsewhere_quantity=confirmed,
                pending_elsewhere_quantity=pending, receivable_quantity=max(ordered - confirmed - pending, ZERO),
                accepted_quantity=l.accepted_quantity,
                rejected_quantity=l.rejected_quantity, notes=l.notes, inventory_movement_id=l.inventory_movement_id,
            )
        )
    return ReceiptDetail(
        **summary.model_dump(), lines=rows, inventory_operation_id=receipt.inventory_operation_id, editable=receipt.status == "draft",
        posting=PostingInfo(
            attempts=receipt.posting_attempts, started_at=receipt.posting_started_at,
            last_attempt_at=receipt.last_posting_attempt_at, last_error=receipt.last_posting_error,
        ),
    )


def receipts_of_order(db: Session, tenant: TenantContext, order_id: uuid.UUID) -> List[ReceiptSummary]:
    rows = db.scalars(
        scoped_select(GoodsReceipt, tenant).where(GoodsReceipt.purchase_order_id == order_id).order_by(GoodsReceipt.created_at.desc(), GoodsReceipt.number.desc())
    ).all()
    return summaries(db, tenant, list(rows))


# --- checking what a caller asks for -----------------------------------------------------------------------------------------------
class Row:
    """One receipt line, validated, as plain values (no ORM objects, so no database session is needed to hold it)."""

    def __init__(self, line: PurchaseOrderLine, item: ReceiptLineInput):
        self.order_line_id, self.product_id, self.sku, self.name, self.unit = line.id, line.product_id, line.product_sku, line.product_name, line.unit
        self.ordered = line.quantity
        self.accepted, self.rejected = item.accepted_quantity, item.rejected_quantity
        self.notes = item.notes


def local_rows(db: Session, tenant: TenantContext, order: PurchaseOrder, items: List[ReceiptLineInput]) -> List[Row]:
    """Everything that can be judged from our own data. Rows with nothing accepted and nothing rejected are simply not on the receipt."""
    order_lines = {l.id: l for l in list_lines(db, tenant, order.id)}
    seen, rows = set(), []
    for item in items:
        line = order_lines.get(item.purchase_order_line_id)
        if line is None:  # a line of another order or organization looks exactly like one that does not exist
            raise HTTPException(status.HTTP_404_NOT_FOUND, "That product is not on this purchase order.")
        if line.id in seen:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{line.product_name} appears more than once on the receipt.")
        seen.add(line.id)
        if item.accepted_quantity == 0 and item.rejected_quantity == 0:
            continue
        rows.append(Row(line, item))
    return rows


def remote_checks(gateway: InventoryGateway, rows: List[Row]) -> None:
    """Ask the Inventory Service (caller's own token) whether the products can take this. Called with no
    transaction open. Archived or unknown things are refused; a product whose unit is no longer the ordered one is refused."""
    if not rows:
        return
    try:
        products: Dict[uuid.UUID, ProductInfo] = gateway.products([r.product_id for r in rows])
    except InventoryUnavailable:
        raise unavailable_error()
    for r in rows:
        info = products.get(r.product_id)
        if info is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found.")
        if r.accepted > 0 and not info.is_active:
            raise conflict(f"{info.name} is archived. Restore it in Products before receiving it into stock.")
        if info.unit != r.unit:
            raise conflict(
                f"{info.name} is now counted in '{info.unit}' but was ordered in '{r.unit}'. A quantity is never converted between units; "
                "correct the product's unit first."
            )
        if not info.allows_fractions:
            for label, value in (("accepted", r.accepted), ("rejected", r.rejected)):
                if value != value.to_integral_value():
                    raise HTTPException(
                        status.HTTP_422_UNPROCESSABLE_ENTITY, f"The {label} quantity must be a whole number: {info.name} is counted in '{info.unit}'."
                    )


def check_capacity(db: Session, tenant: TenantContext, rows: List[Row], receipt_id: Optional[uuid.UUID]) -> None:
    """Under the order's lock: accepted quantities must fit what is still receivable (ordered - confirmed - being posted elsewhere)."""
    others = received_quantities(db, tenant, [r.order_line_id for r in rows], exclude_receipt=receipt_id)
    for r in rows:
        confirmed, pending = others.get(r.order_line_id, (ZERO, ZERO))
        receivable = r.ordered - confirmed - pending
        if r.accepted > receivable:
            pending_note = f" ({human(pending)} more is being posted on another receipt)" if pending > 0 else ""
            raise conflict(
                f"You cannot receive {human(r.accepted)} {r.unit} of {r.name}: ordered {human(r.ordered)}, already received {human(confirmed)}"
                f"{pending_note}, so at most {human(max(receivable, ZERO))} can still be received.",
                code="over_receipt",
            )


# --- creating (idempotent) -------------------------------------------------------------------------------------------------------------
def _today() -> date:
    return _now().date()


def check_received_date(value) -> None:
    if value > (_now() + timedelta(days=1)).date():  # one day of slack for time zones
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The receiving date cannot be in the future.")


def _request_hash(payload) -> str:
    return hashlib.sha256(json.dumps(payload.model_dump(mode="json"), sort_keys=True).encode()).hexdigest()


def _replay(db: Session, tenant: TenantContext, key: str, request_hash: str) -> GoodsReceipt:
    previous = db.scalar(scoped_select(GoodsReceiptRequest, tenant).where(GoodsReceiptRequest.idempotency_key == key))
    if previous is None or previous.goods_receipt_id is None:
        raise conflict("The request was being processed. Please retry.")
    if previous.request_hash != request_hash:
        raise conflict("This Idempotency-Key was already used for a different request. Use a new key for a new goods receipt.")
    return get_receipt_or_404(db, tenant, previous.goods_receipt_id)


def create_receipt(db: Session, tenant: TenantContext, gateway: InventoryGateway, payload, key: str) -> Tuple[GoodsReceipt, bool]:
    """A DRAFT receipt against an Ordered / Partially Received order, optionally with its lines. Saves no stock change.
    Returns (receipt, replayed): a repeated request with the same key returns the first receipt and creates nothing."""
    request_hash = _request_hash(payload)
    if db.scalar(scoped_select(GoodsReceiptRequest, tenant).where(GoodsReceiptRequest.idempotency_key == key)) is not None:
        return _replay(db, tenant, key, request_hash), True

    order = get_order_or_404(db, tenant, payload.purchase_order_id)  # another organization's order is simply not found
    require_receivable_order(order)
    if payload.received_date:
        check_received_date(payload.received_date)
    rows = local_rows(db, tenant, order, payload.lines)
    order_id = order.id
    db.rollback()
    remote_checks(gateway, rows)  # no transaction is open while the Inventory Service is asked

    claimed = db.execute(
        pg_insert(GoodsReceiptRequest)
        .values(organization_id=tenant.organization_id, idempotency_key=key, request_hash=request_hash)
        .on_conflict_do_nothing(index_elements=["organization_id", "idempotency_key"])
        .returning(GoodsReceiptRequest.id)
    ).first()
    if claimed is None:  # a concurrent duplicate won the race and has committed by now
        db.rollback()
        return _replay(db, tenant, key, request_hash), True
    try:
        order = get_order_or_404(db, tenant, order_id, lock=True)  # the order first, always: one lock order for every receipt operation
        require_receivable_order(order)
        check_capacity(db, tenant, rows, None)
        receipt_id = uuid.uuid4()
        receipt = GoodsReceipt(
            id=receipt_id, organization_id=tenant.organization_id, purchase_order_id=order.id, number=next_number(db, tenant),
            supplier_reference=payload.supplier_reference, received_date=payload.received_date or _today(), notes=payload.notes,
            status="draft", posting_key=f"goods-receipt-{receipt_id}", created_by=_user_id(tenant), created_by_email=tenant.email,
        )
        db.add(receipt)
        db.flush()
        _write_lines(db, tenant, receipt, rows)
        db.execute(GoodsReceiptRequest.__table__.update().where(GoodsReceiptRequest.id == claimed[0]).values(goods_receipt_id=receipt.id))
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()  # the claimed key and the number are released together with everything else
        raise
    db.refresh(receipt)
    return receipt, False


def _write_lines(db: Session, tenant: TenantContext, receipt: GoodsReceipt, rows: List[Row]) -> None:
    db.execute(delete(GoodsReceiptLine).where(GoodsReceiptLine.organization_id == tenant.organization_id, GoodsReceiptLine.goods_receipt_id == receipt.id))
    for r in rows:
        db.add(
            GoodsReceiptLine(
                organization_id=tenant.organization_id, goods_receipt_id=receipt.id, purchase_order_line_id=r.order_line_id,
                product_id=r.product_id, product_sku=r.sku, product_name=r.name, unit=r.unit,
                accepted_quantity=r.accepted, rejected_quantity=r.rejected, notes=r.notes,
            )
        )
    db.flush()


def require_draft(receipt: GoodsReceipt) -> None:
    if receipt.status != "draft":
        explanation = {
            "posting": "is being added to stock; it can no longer be edited. Retry confirming it to finish.",
            "confirmed": "is confirmed. A confirmed receipt is a permanent record and cannot be changed.",
            "cancelled": "is cancelled and is kept for history.",
        }[receipt.status]
        raise conflict(f"{receipt.number} {explanation}")


# --- editing a draft -------------------------------------------------------------------------------------------------------------------
def update_header(db: Session, tenant: TenantContext, receipt_id: uuid.UUID, changes: dict) -> GoodsReceipt:
    if "received_date" in changes:
        check_received_date(changes["received_date"])
    receipt = get_receipt_or_404(db, tenant, receipt_id)
    order = get_order_or_404(db, tenant, receipt.purchase_order_id, lock=True)  # order, then receipt
    receipt = get_receipt_or_404(db, tenant, receipt_id, lock=True)
    require_draft(receipt)
    require_receivable_order(order)
    for field, value in changes.items():
        setattr(receipt, field, value)
    try:
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    db.refresh(receipt)
    return receipt


def save_lines(db: Session, tenant: TenantContext, gateway: InventoryGateway, receipt_id: uuid.UUID, items: List[ReceiptLineInput]) -> GoodsReceipt:
    """Replace the draft's lines with exactly these. Changes no stock."""
    receipt = get_receipt_or_404(db, tenant, receipt_id)
    require_draft(receipt)
    order = get_order_or_404(db, tenant, receipt.purchase_order_id)
    require_receivable_order(order)
    rows = local_rows(db, tenant, order, items)
    order_id = order.id
    db.rollback()
    remote_checks(gateway, rows)

    try:
        order = get_order_or_404(db, tenant, order_id, lock=True)
        receipt = get_receipt_or_404(db, tenant, receipt_id, lock=True)
        require_draft(receipt)  # re-checked under the locks: someone may have started confirming meanwhile
        require_receivable_order(order)
        check_capacity(db, tenant, rows, receipt.id)
        _write_lines(db, tenant, receipt, rows)
        receipt.updated_at = _now()
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(receipt)
    return receipt


def cancel_receipt(db: Session, tenant: TenantContext, receipt_id: uuid.UUID) -> GoodsReceipt:
    """Cancel a DRAFT (kept for history). A receipt that is being posted or confirmed cannot be cancelled: stock may already have moved."""
    receipt = get_receipt_or_404(db, tenant, receipt_id)
    get_order_or_404(db, tenant, receipt.purchase_order_id, lock=True)  # the order first, then the receipt
    receipt = get_receipt_or_404(db, tenant, receipt_id, lock=True)
    if receipt.status == "cancelled":
        db.rollback()
        return receipt  # already there: harmless to repeat
    if receipt.status == "posting":
        raise conflict(f"{receipt.number} is being added to stock and cannot be cancelled. Retry confirming it to finish.")
    if receipt.status == "confirmed":
        raise conflict(f"{receipt.number} is confirmed: its goods are already in stock. A confirmed receipt cannot be cancelled.")
    receipt.status, receipt.cancelled_at, receipt.cancelled_by_email = "cancelled", _now(), tenant.email
    db.commit()
    db.refresh(receipt)
    return receipt


# --- confirming: the durable workflow --------------------------------------------------------------------------------------------------
class Mismatch(Exception):
    """The Inventory Service's answer does not match what was asked for: not trusted."""


def posting_body(receipt: GoodsReceipt, order_number: str, lines: List[GoodsReceiptLine]) -> dict:
    return {
        "receipt_number": receipt.number,
        "purchase_order_number": order_number,
        "lines": [
            {
                "line_id": str(l.id), "product_id": str(l.product_id),
                "quantity": format(l.accepted_quantity, "f"), "unit": l.unit,
            }
            for l in lines
            if l.accepted_quantity > 0  # a rejected quantity is never stock
        ],
    }


def verify_posting(number: str, body: dict, data: Optional[dict]) -> Tuple[uuid.UUID, Dict[uuid.UUID, uuid.UUID]]:
    """Accept the Inventory Service's answer only if it says exactly what we asked for: this receipt, one movement per accepted
    line, each for the right product and quantity. Returns (operation id, receipt line id -> movement id)."""
    try:
        if not isinstance(data, dict) or data.get("receipt_number") != number:
            raise Mismatch()
        operation_id = uuid.UUID(str(data["operation_id"]))
        wanted = {uuid.UUID(l["line_id"]): l for l in body["lines"]}
        movements: Dict[uuid.UUID, uuid.UUID] = {}
        for movement in data["movements"]:
            line_id = uuid.UUID(str(movement["line_id"]))
            expected = wanted.get(line_id)
            if (
                expected is None or line_id in movements
                or str(uuid.UUID(str(movement["product_id"]))) != expected["product_id"]
                or Decimal(str(movement["quantity"])) != Decimal(expected["quantity"])
            ):
                raise Mismatch()
            movements[line_id] = uuid.UUID(str(movement["id"]))
        if set(movements) != set(wanted):
            raise Mismatch()
    except Mismatch:
        raise
    except (KeyError, ValueError, TypeError, ArithmeticError, AttributeError):
        raise Mismatch()
    return operation_id, movements


def _record_attempt_failure(db: Session, tenant: TenantContext, receipt_id: uuid.UUID, message: str) -> None:
    receipt = get_receipt_or_404(db, tenant, receipt_id, lock=True)
    if receipt.status == "posting":
        receipt.last_posting_error = message[:500]
        db.commit()
    else:
        db.rollback()


def _finish(db: Session, tenant: TenantContext, order_id: uuid.UUID, receipt_id: uuid.UUID, operation_id: uuid.UUID, movements: Dict[uuid.UUID, uuid.UUID]) -> GoodsReceipt:
    """The verified answer is in: record the movements, confirm the receipt and move the order on - one transaction."""
    try:
        order = get_order_or_404(db, tenant, order_id, lock=True)
        receipt = get_receipt_or_404(db, tenant, receipt_id, lock=True)
        if receipt.status == "confirmed":  # another request finished first: nothing more to do
            db.rollback()
            return receipt
        if receipt.status != "posting":
            raise conflict(f"{receipt.number} is {receipt.status} and cannot be confirmed now.")
        for line in receipt_lines(db, tenant, receipt.id):
            if line.accepted_quantity > 0:
                line.inventory_movement_id = movements[line.id]
        db.flush()
        receipt.status, receipt.inventory_operation_id = "confirmed", operation_id
        receipt.confirmed_at, receipt.confirmed_by_email, receipt.last_posting_error = _now(), tenant.email, None
        db.flush()
        recompute_order_status(db, tenant, order)
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(receipt)
    return receipt


def _return_to_draft(db: Session, tenant: TenantContext, receipt_id: uuid.UUID, order_id: uuid.UUID, message: str) -> None:
    get_order_or_404(db, tenant, order_id, lock=True)
    receipt = get_receipt_or_404(db, tenant, receipt_id, lock=True)
    if receipt.status == "posting":
        receipt.status, receipt.last_posting_error = "draft", message[:500]
        db.commit()
    else:
        db.rollback()


def confirm_receipt(db: Session, tenant: TenantContext, gateway: InventoryGateway, receipt_id: uuid.UUID) -> Tuple[GoodsReceipt, bool]:
    """Returns (receipt, confirmed). confirmed=False means the posting could not be verified yet: the receipt stays `posting`
    and confirming it again (the same call) finishes the job without ever adding the goods twice."""
    receipt = get_receipt_or_404(db, tenant, receipt_id)
    refuse_unless_recovering(tenant, receipt.status)  # module switched off: only a receipt already `posting` may be finished
    if receipt.status == "confirmed":
        db.rollback()
        return receipt, True  # confirming twice is harmless
    if receipt.status == "cancelled":
        raise conflict(f"{receipt.number} is cancelled and cannot be confirmed.")
    order_id = receipt.purchase_order_id

    # -- 0. a draft is checked against the Inventory Service first (no locks, no transaction), so an obvious problem
    #       - an archived product, a changed unit - is explained BEFORE anything is reserved
    if receipt.status == "draft":
        order = get_order_or_404(db, tenant, order_id)
        require_receivable_order(order)
        ordered = {l.id: l.quantity for l in list_lines(db, tenant, order_id)}
        rows = [row_from_line(l, ordered[l.purchase_order_line_id]) for l in receipt_lines(db, tenant, receipt.id)]
        db.rollback()
        remote_checks(gateway, rows)

    # -- 1. save the INTENT (short transaction). From here the quantities are reserved and the receipt is frozen.
    try:
        order = get_order_or_404(db, tenant, order_id, lock=True)  # the order first, then the receipt: one lock order everywhere
        receipt = get_receipt_or_404(db, tenant, receipt_id, lock=True)
        refuse_unless_recovering(tenant, receipt.status)
        if receipt.status == "confirmed":
            db.rollback()
            return receipt, True
        if receipt.status == "cancelled":
            raise conflict(f"{receipt.number} is cancelled and cannot be confirmed.")
        lines = receipt_lines(db, tenant, receipt.id)
        if receipt.status == "draft":
            require_receivable_order(order)
            accepted = [l for l in lines if l.accepted_quantity > 0]
            if not accepted:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Nothing is accepted on this receipt, so there is nothing to add to stock. Enter an accepted quantity, or cancel the receipt.",
                )
            ordered = {l.id: l.quantity for l in list_lines(db, tenant, order_id)}
            check_capacity(db, tenant, [row_from_line(l, ordered[l.purchase_order_line_id]) for l in accepted], receipt.id)
            receipt.status, receipt.posting_started_at = "posting", _now()
        receipt.posting_attempts += 1
        receipt.last_posting_attempt_at = _now()
        body = posting_body(receipt, order.number, lines)
        key, number = receipt.posting_key, receipt.number
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise

    # -- 2. ask the Inventory Service. NO database transaction is open here (the commit above ended it).
    outcome: PostingOutcome = gateway.post_goods_receipt(key, body)
    data, problem = (outcome.data if outcome.kind == "posted" else None), outcome.message

    if outcome.kind == "rejected":
        # Definitive, but we do not take its word for "nothing happened" without asking: the same key may have been used before.
        lookup = gateway.posting_by_key(key)
        if lookup.kind == "absent":
            _return_to_draft(db, tenant, receipt_id, order_id, f"The inventory service refused the receipt: {problem}")
            raise conflict(f"The inventory service refused to add this receipt to stock: {problem} Nothing was added. Fix it and confirm again.", code="inventory_rejected")
        data = lookup.data if lookup.kind == "found" else None
        problem = problem if lookup.kind != "found" else ""
    elif outcome.kind == "unknown":
        lookup = gateway.posting_by_key(key)  # the request may have been applied even though the answer was lost
        if lookup.kind == "found":
            data, problem = lookup.data, ""

    # -- 3. only a VERIFIED answer confirms the receipt
    if data is not None:
        try:
            operation_id, movements = verify_posting(number, body, data)
        except Mismatch:
            problem = "The inventory service's answer did not match this receipt, so it was not trusted."
        else:
            return _finish(db, tenant, order_id, receipt_id, operation_id, movements), True
    _record_attempt_failure(db, tenant, receipt_id, problem or "The posting could not be verified.")
    receipt = get_receipt_or_404(db, tenant, receipt_id)
    return receipt, False


def row_from_line(line: GoodsReceiptLine, ordered: Decimal) -> "Row":
    row = Row.__new__(Row)
    row.order_line_id, row.product_id, row.sku, row.name, row.unit = line.purchase_order_line_id, line.product_id, line.product_sku, line.product_name, line.unit
    row.accepted, row.rejected, row.notes = line.accepted_quantity, line.rejected_quantity, line.notes
    row.ordered = ordered
    return row


# --- listing -------------------------------------------------------------------------------------------------------------------------------
def search_filter(pattern: str):
    return or_(
        GoodsReceipt.number.ilike(pattern, escape="\\"),
        GoodsReceipt.supplier_reference.ilike(pattern, escape="\\"),
        PurchaseOrder.number.ilike(pattern, escape="\\"),
        Supplier.name.ilike(pattern, escape="\\"),
    )
