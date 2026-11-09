"""Stock changes, balances and the movement ledger.

Guarantees (each is also backed by a database constraint, so a bug here cannot silently break them):

  * A balance never goes negative.      CHECK (quantity >= 0), plus the row is locked while it is read and changed.
  * Every change is in the ledger.      One movement row per change, written in the SAME transaction as the balance.
  * The ledger is append-only.          A trigger rejects UPDATE/DELETE; there is no API for either.
  * Retries are safe.                   Each request carries an Idempotency-Key; a repeat replays the first result.
  * Tenants never mix.                  Every query is tenant-scoped, and composite foreign keys tie a stock row
                                        and its product to the same organization in the database.
  * Quantities are exact decimals, whole numbers for indivisible units (pieces, boxes, ...).
  * Reserved stock is untouchable. Stock booked for a sales order (balance.reserved_quantity) cannot be taken by a manual stock-out or
    by a dispatch that is not that order's own; only a dispatch of the order line itself consumes its reservation, in the same
    transaction (and the database refuses reserved > on hand).
"""
import hashlib
import json
import uuid
from decimal import Decimal
from typing import Dict, List, Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.auth import TenantContext
from app.models import Product, StockBalance, StockMovement, StockOperation, StockReservation
from app.schemas import (
    MovementList,
    MovementResponse,
    DispatchPost,
    DispatchPosting,
    ReceiptMovement,
    ReceiptPost,
    ReceiptPosting,
    StockChange,
    StockOperationResult,
    StockOverview,
    StockProduct,
)
from app.search import like_pattern
from app.tenancy import create_for_tenant, get_scoped_or_404, scoped_count, scoped_select
from app.units import allows_fractions

QUANT = Decimal("0.0001")
ZERO = Decimal("0")
DEFAULT_REASONS = {"opening": "Opening balance", "in": "Stock in", "out": "Stock out", "receipt": "Goods receipt", "dispatch": "Client dispatch"}


# --- small helpers -----------------------------------------------------------------------------------
def _user_id(tenant: TenantContext) -> uuid.UUID:
    try:
        return uuid.UUID(tenant.user_id)
    except ValueError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Organization administrator permission required")


def canonical(value: Decimal) -> str:
    return format(value.quantize(QUANT), "f")


def human(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def fingerprint(kind: str, **fields) -> str:
    """A stable hash of what the request asked for, so a reused key with a DIFFERENT request is detected."""
    body = json.dumps({"kind": kind, **{k: str(v) for k, v in fields.items()}}, sort_keys=True)
    return hashlib.sha256(body.encode()).hexdigest()


def _load_product_locked(db: Session, tenant: TenantContext, product_id: uuid.UUID) -> Product:
    """The tenant's product, with a shared row lock held until the transaction ends.

    The lock makes "change the unit" and "record stock" mutually exclusive: an UPDATE of the product waits for us,
    and (because the row is re-read after the lock is taken) we always see the unit that is really in force.
    """
    product = db.scalar(
        scoped_select(Product, tenant).where(Product.id == product_id).with_for_update(read=True).execution_options(populate_existing=True)
    )
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found.")
    return product


def _require_active(product: Product) -> None:
    if not product.is_active:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{product.name} is archived. Restore it before changing its stock.")


def _check_quantity_for_unit(product: Product, quantity: Decimal) -> None:
    if not allows_fractions(product.unit) and quantity != quantity.to_integral_value():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Quantity must be a whole number: {product.name} is counted in '{product.unit}'.",
        )


def _insufficient(product: Product, available: Decimal, requested: Decimal, reserved: Decimal = ZERO) -> HTTPException:
    if reserved > 0:
        return HTTPException(
            status.HTTP_409_CONFLICT,
            f"Insufficient available stock: {human(available)} {product.unit} of {product.name} available, {human(requested)} requested. "
            f"{human(reserved)} {product.unit} is reserved for sales orders and cannot be taken.",
        )
    return HTTPException(
        status.HTTP_409_CONFLICT,
        f"Insufficient stock: {human(available)} {product.unit} of {product.name} available, {human(requested)} requested.",
    )


# --- movements as the API shows them -------------------------------------------------------------------
def _movement_query(tenant: TenantContext):
    return (
        scoped_select(StockMovement, tenant)
        .add_columns(Product)
        .join(Product, and_(Product.id == StockMovement.product_id, Product.organization_id == StockMovement.organization_id))
    )


def _to_response(movement: StockMovement, product: Product) -> MovementResponse:
    return MovementResponse(
        id=movement.id,
        operation_id=movement.operation_id,
        product_id=product.id,
        product_sku=product.sku,
        product_name=product.name,
        product_unit=product.unit,
        unit_allows_fractions=allows_fractions(product.unit),
        movement_type=movement.movement_type,
        quantity=movement.quantity,
        balance_after=movement.balance_after,
        reason=movement.reason,
        created_by_email=movement.created_by_email,
        source_type=movement.source_type,
        source_reference=movement.source_reference,
        created_at=movement.created_at,
    )


def _result(db: Session, tenant: TenantContext, operation: uuid.UUID, kind: str, replayed: bool) -> StockOperationResult:
    rows = db.execute(
        _movement_query(tenant).where(StockMovement.operation_id == operation).order_by(StockMovement.movement_type.desc(), StockMovement.id)
    ).all()
    return StockOperationResult(operation_id=operation, kind=kind, replayed=replayed, movements=[_to_response(*row) for row in rows])


# --- idempotency -------------------------------------------------------------------------------------
def _start_operation(db: Session, tenant: TenantContext, kind: str, key: str, request_hash: str) -> Optional[uuid.UUID]:
    """Claim the Idempotency-Key. None means the key was already used (the caller replays instead of acting).

    The unique (organization_id, idempotency_key) index makes a concurrent duplicate WAIT for this transaction:
    if it commits the duplicate sees the conflict and replays; if it rolls back the duplicate proceeds on its own.
    """
    statement = (
        pg_insert(StockOperation)
        .values(organization_id=tenant.organization_id, kind=kind, idempotency_key=key, request_hash=request_hash, created_by=_user_id(tenant))
        .on_conflict_do_nothing(index_elements=["organization_id", "idempotency_key"])
        .returning(StockOperation.id)
    )
    row = db.execute(statement).first()
    return row[0] if row else None


def _replay(db: Session, tenant: TenantContext, key: str, kind: str, request_hash: str) -> StockOperationResult:
    operation = db.scalar(scoped_select(StockOperation, tenant).where(StockOperation.idempotency_key == key))
    if operation is None:  # the first attempt rolled back at just the wrong moment: ask the client to retry
        raise HTTPException(status.HTTP_409_CONFLICT, "The request was being processed. Please retry.")
    if operation.request_hash != request_hash or operation.kind != kind:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This Idempotency-Key was already used for a different request. Use a new key for a new request.",
        )
    return _result(db, tenant, operation.id, operation.kind, replayed=True)


# --- balances and the ledger -----------------------------------------------------------------------------
def _lock_balances(db: Session, tenant: TenantContext, product_ids: Sequence[uuid.UUID]) -> Dict[uuid.UUID, StockBalance]:
    """Make sure each product has a balance row, then lock them (in a fixed order, so two postings touching the same goods
    can never deadlock). Nobody else can change these balances until we commit."""
    ordered = sorted(set(product_ids), key=str)
    for product_id in ordered:
        db.execute(
            pg_insert(StockBalance)
            .values(organization_id=tenant.organization_id, product_id=product_id, quantity=0)
            .on_conflict_do_nothing(index_elements=["organization_id", "product_id"])
        )
    rows = db.scalars(
        scoped_select(StockBalance, tenant).where(StockBalance.product_id.in_(ordered)).order_by(StockBalance.product_id).with_for_update()
    ).all()
    return {row.product_id: row for row in rows}


def _add_movement(
    db: Session,
    tenant: TenantContext,
    operation: uuid.UUID,
    product: Product,
    movement_type: str,
    quantity: Decimal,
    balance_after: Decimal,
    reason: str,
    source_reference: Optional[str] = None,
    source_line_id: Optional[uuid.UUID] = None,
    source_type: str = "goods_receipt",
) -> StockMovement:
    movement = create_for_tenant(
        StockMovement,
        tenant,
        operation_id=operation,
        product_id=product.id,
        movement_type=movement_type,
        quantity=quantity,
        balance_after=balance_after,
        reason=reason,
        source_type=source_type if source_line_id is not None else None,
        source_reference=source_reference,
        source_line_id=source_line_id,
        created_by=_user_id(tenant),
        created_by_email=tenant.email,
    )
    db.add(movement)
    db.flush()
    return movement


# --- opening balance, stock in, stock out ----------------------------------------------------------------
def execute_change(db: Session, tenant: TenantContext, kind: str, payload: StockChange, key: str) -> StockOperationResult:
    reason = payload.reason or DEFAULT_REASONS[kind]
    request_hash = fingerprint(kind, product=payload.product_id, quantity=canonical(payload.quantity), reason=reason)
    try:
        operation = _start_operation(db, tenant, kind, key, request_hash)
        if operation is None:
            db.rollback()
            return _replay(db, tenant, key, kind, request_hash)

        product = _load_product_locked(db, tenant, payload.product_id)
        _require_active(product)
        _check_quantity_for_unit(product, payload.quantity)

        balance = _lock_balances(db, tenant, [product.id])[product.id]
        if kind == "opening":
            history = scoped_count(StockMovement, tenant, StockMovement.product_id == product.id)
            if db.scalar(history) > 0:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"{product.name} already has stock history. An opening balance can only be recorded "
                    "before any other movement; use Add stock or Remove stock instead.",
                )
        new_balance = balance.quantity + payload.quantity if kind in ("opening", "in") else balance.quantity - payload.quantity
        if new_balance < balance.reserved_quantity:  # also covers < 0: stock booked for orders cannot be taken
            raise _insufficient(product, balance.quantity - balance.reserved_quantity, payload.quantity, balance.reserved_quantity)

        balance.quantity = new_balance
        _add_movement(db, tenant, operation, product, kind, payload.quantity, new_balance, reason)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return _result(db, tenant, operation, kind, replayed=False)


# --- goods receipt: several accepted quantities of purchased goods, atomically ---------------------------------
def _receipt_fingerprint(payload: ReceiptPost) -> str:
    lines = sorted(
        ({"line": str(l.line_id), "product": str(l.product_id), "quantity": canonical(l.quantity), "unit": l.unit} for l in payload.lines),
        key=lambda item: item["line"],
    )
    body = json.dumps({"kind": "receipt", "receipt": payload.receipt_number, "order": payload.purchase_order_number or "", "lines": lines}, sort_keys=True)
    return hashlib.sha256(body.encode()).hexdigest()


def _receipt_result(db: Session, tenant: TenantContext, operation: uuid.UUID, receipt_number: str, replayed: bool) -> ReceiptPosting:
    rows = db.scalars(
        scoped_select(StockMovement, tenant).where(StockMovement.operation_id == operation).order_by(StockMovement.source_line_id)
    ).all()
    return ReceiptPosting(
        operation_id=operation,
        receipt_number=receipt_number,
        replayed=replayed,
        movements=[
            ReceiptMovement(
                id=m.id, line_id=m.source_line_id, product_id=m.product_id, quantity=m.quantity, balance_after=m.balance_after,
            )
            for m in rows
        ],
    )


def _receipt_number_of(db: Session, tenant: TenantContext, operation: uuid.UUID) -> str:
    return db.scalar(
        select(StockMovement.source_reference)
        .where(StockMovement.organization_id == tenant.organization_id, StockMovement.operation_id == operation)
        .limit(1)
    ) or ""


def execute_receipt(db: Session, tenant: TenantContext, payload: ReceiptPost, key: str) -> ReceiptPosting:
    """Add the accepted quantities of one goods receipt to stock: ALL lines or none, once per Idempotency-Key.

    A receipt line can produce at most one movement ever (unique index), whatever key the caller uses. The product's unit
    must equal the unit on the line - a quantity is never reinterpreted - and archived products are refused.
    """
    request_hash = _receipt_fingerprint(payload)
    try:
        operation = _start_operation(db, tenant, "receipt", key, request_hash)
        if operation is None:
            db.rollback()
            return _replay_receipt(db, tenant, key, request_hash)

        reason = f"{DEFAULT_REASONS['receipt']} {payload.receipt_number}" + (f" ({payload.purchase_order_number})" if payload.purchase_order_number else "")
        # Fixed lock order (by product) so two receipts touching the same goods can never deadlock.
        # The sort is stable: lines for the same product keep the order they were sent in.
        lines = sorted(payload.lines, key=lambda l: str(l.product_id))
        products: Dict[uuid.UUID, Product] = {}
        for line in lines:
            if line.product_id not in products:
                products[line.product_id] = _load_product_locked(db, tenant, line.product_id)
        for line in lines:
            product = products[line.product_id]
            _require_active(product)
            if product.unit != line.unit:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"{product.name} is now counted in '{product.unit}' but the receipt line is in '{line.unit}'. "
                    "A quantity is never converted; correct the unit before receiving.",
                )
            _check_quantity_for_unit(product, line.quantity)

        balances = _lock_balances(db, tenant, list(products))
        for line in lines:
            balance = balances[line.product_id]
            balance.quantity = balance.quantity + line.quantity
            _add_movement(
                db, tenant, operation, products[line.product_id], "in", line.quantity,
                balance.quantity, reason, source_reference=payload.receipt_number, source_line_id=line.line_id,
            )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if "uq_stock_movements_source_line" in str(exc.orig):
            raise HTTPException(status.HTTP_409_CONFLICT, "One of these receipt lines was already added to stock by an earlier posting.")
        raise
    except Exception:
        db.rollback()
        raise
    return _receipt_result(db, tenant, operation, payload.receipt_number, replayed=False)


def _replay_receipt(db: Session, tenant: TenantContext, key: str, request_hash: str) -> ReceiptPosting:
    operation = db.scalar(scoped_select(StockOperation, tenant).where(StockOperation.idempotency_key == key))
    if operation is None:  # the first attempt rolled back at just the wrong moment: it did NOT post. Ask to retry.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The request was being processed. Please retry.", headers={"Retry-After": "1"})
    if operation.request_hash != request_hash or operation.kind != "receipt":
        raise HTTPException(status.HTTP_409_CONFLICT, "This Idempotency-Key was already used for a different request. Use a new key for a new request.")
    return _receipt_result(db, tenant, operation.id, _receipt_number_of(db, tenant, operation.id), replayed=True)


def receipt_by_key(db: Session, tenant: TenantContext, key: str) -> ReceiptPosting:
    """Did the posting with this Idempotency-Key happen? Read-only; 404 means it did not (for this organization)."""
    operation = db.scalar(scoped_select(StockOperation, tenant).where(StockOperation.idempotency_key == key, StockOperation.kind == "receipt"))
    if operation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No goods receipt was posted with this key.")
    return _receipt_result(db, tenant, operation.id, _receipt_number_of(db, tenant, operation.id), replayed=True)


# --- client dispatch: several quantities of goods leaving for a client, atomically ---------------------------------
def _dispatch_fingerprint(payload: DispatchPost) -> str:
    lines = sorted(
        (
            {"line": str(l.line_id), "product": str(l.product_id), "quantity": canonical(l.quantity), "unit": l.unit,
             **({"order_line": str(l.order_line_id)} if l.order_line_id else {})}  # only when present: older postings keep their fingerprint
            for l in payload.lines
        ),
        key=lambda item: item["line"],
    )
    body = json.dumps({"kind": "dispatch", "dispatch": payload.dispatch_number, "list": payload.delivery_list_number or "", "lines": lines}, sort_keys=True)
    return hashlib.sha256(body.encode()).hexdigest()


def _dispatch_result(db: Session, tenant: TenantContext, operation: uuid.UUID, dispatch_number: str, replayed: bool) -> DispatchPosting:
    posting = _receipt_result(db, tenant, operation, dispatch_number, replayed)
    return DispatchPosting(operation_id=posting.operation_id, dispatch_number=dispatch_number, replayed=replayed, movements=posting.movements)


def execute_dispatch(db: Session, tenant: TenantContext, payload: DispatchPost, key: str, trusted: bool = False) -> DispatchPosting:
    """Deduct the dispatched quantities of one client dispatch from stock: ALL lines or none, once per Idempotency-Key.

    Stock never goes negative (the balance rows are locked, in a fixed order, while they are read and changed; the database
    also checks quantity >= 0). A dispatch line can produce at most one movement ever (unique index), whatever key the caller
    uses. The product's unit must equal the unit on the line - a quantity is never reinterpreted - and archived products are
    refused.

    Reservations: a line that names its `order_line_id` (trusted callers only) consumes that order line's reservation - the stock
    leaves and the reservation shrinks in this same transaction, so they can never disagree. Every other line may only take AVAILABLE
    stock (on hand minus reserved), so a dispatch can never eat into stock booked for another order.
    """
    if any(l.order_line_id for l in payload.lines) and not trusted:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the Sales Service can dispatch against an order reservation.")
    request_hash = _dispatch_fingerprint(payload)
    try:
        operation = _start_operation(db, tenant, "dispatch", key, request_hash)
        if operation is None:
            db.rollback()
            return _replay_dispatch(db, tenant, key, request_hash)

        reason = f"{DEFAULT_REASONS['dispatch']} {payload.dispatch_number}" + (f" ({payload.delivery_list_number})" if payload.delivery_list_number else "")
        lines = sorted(payload.lines, key=lambda l: str(l.product_id))  # stable: same goods keep the order sent
        products: Dict[uuid.UUID, Product] = {}
        for line in lines:
            if line.product_id not in products:
                products[line.product_id] = _load_product_locked(db, tenant, line.product_id)
        for line in lines:
            product = products[line.product_id]
            _require_active(product)
            if product.unit != line.unit:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"{product.name} is now counted in '{product.unit}' but the dispatch line is in '{line.unit}'. "
                    "A quantity is never converted; correct the unit before dispatching.",
                )
            _check_quantity_for_unit(product, line.quantity)

        balances = _lock_balances(db, tenant, list(products))
        reservations: Dict[uuid.UUID, StockReservation] = {}
        order_lines = [l.order_line_id for l in lines if l.order_line_id]
        if order_lines:
            reservations = {
                r.source_line_id: r
                for r in db.scalars(
                    scoped_select(StockReservation, tenant).where(StockReservation.source_line_id.in_(order_lines)).order_by(StockReservation.id)
                    .with_for_update().execution_options(populate_existing=True)
                ).all()
            }
        # the order's own lines first (they consume what is booked for them), then everything else against what is still AVAILABLE
        for line in sorted(lines, key=lambda l: 0 if l.order_line_id else 1):
            balance = balances[line.product_id]
            product = products[line.product_id]
            if line.order_line_id:
                reservation = reservations.get(line.order_line_id)
                if reservation is None or reservation.product_id != line.product_id or reservation.status != "active":
                    raise HTTPException(status.HTTP_409_CONFLICT, {"code": "no_reservation", "message": f"No stock is reserved for {product.name} on this order line."})
                if line.quantity > reservation.remaining_quantity:
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        {"code": "exceeds_reservation", "message": f"{human(line.quantity)} {product.unit} of {product.name} cannot be dispatched: only {human(reservation.remaining_quantity)} is reserved for this order line."},
                    )
                reservation.consumed_quantity += line.quantity
                reservation.remaining_quantity -= line.quantity
                reservation.status = "active" if reservation.remaining_quantity > 0 else "fulfilled"
                balance.reserved_quantity -= line.quantity
            elif balance.quantity - balance.reserved_quantity < line.quantity:
                raise _insufficient(product, balance.quantity - balance.reserved_quantity, line.quantity, balance.reserved_quantity)
            balance.quantity = balance.quantity - line.quantity
            _add_movement(
                db, tenant, operation, product, "out", line.quantity,
                balance.quantity, reason, source_reference=payload.dispatch_number, source_line_id=line.line_id, source_type="client_dispatch",
            )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if "uq_stock_movements_source_line" in str(exc.orig):
            raise HTTPException(status.HTTP_409_CONFLICT, "One of these dispatch lines was already deducted from stock by an earlier posting.")
        raise
    except Exception:
        db.rollback()
        raise
    return _dispatch_result(db, tenant, operation, payload.dispatch_number, replayed=False)


def _replay_dispatch(db: Session, tenant: TenantContext, key: str, request_hash: str) -> DispatchPosting:
    operation = db.scalar(scoped_select(StockOperation, tenant).where(StockOperation.idempotency_key == key))
    if operation is None:  # the first attempt rolled back at just the wrong moment: it did NOT post. Ask to retry.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The request was being processed. Please retry.", headers={"Retry-After": "1"})
    if operation.request_hash != request_hash or operation.kind != "dispatch":
        raise HTTPException(status.HTTP_409_CONFLICT, "This Idempotency-Key was already used for a different request. Use a new key for a new request.")
    return _dispatch_result(db, tenant, operation.id, _receipt_number_of(db, tenant, operation.id), replayed=True)


def dispatch_by_key(db: Session, tenant: TenantContext, key: str) -> DispatchPosting:
    """Did the posting with this Idempotency-Key happen? Read-only; 404 means it did not (for this organization)."""
    operation = db.scalar(scoped_select(StockOperation, tenant).where(StockOperation.idempotency_key == key, StockOperation.kind == "dispatch"))
    if operation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No dispatch was posted with this key.")
    return _dispatch_result(db, tenant, operation.id, _receipt_number_of(db, tenant, operation.id), replayed=True)


# --- reading --------------------------------------------------------------------------------------------------
def list_movements(
    db: Session,
    tenant: TenantContext,
    *,
    product_id: Optional[uuid.UUID],
    movement_type: Optional[str],
    limit: int,
    offset: int,
) -> MovementList:
    filters = []
    if product_id:
        filters.append(StockMovement.product_id == product_id)
    if movement_type:
        filters.append(StockMovement.movement_type == movement_type)
    total = db.scalar(scoped_count(StockMovement, tenant, *filters))
    rows = db.execute(
        _movement_query(tenant).where(*filters).order_by(StockMovement.created_at.desc(), StockMovement.movement_type.desc(), StockMovement.id).limit(limit).offset(offset)
    ).all()
    return MovementList(items=[_to_response(*row) for row in rows], total=total, limit=limit, offset=offset)


def stock_items(db: Session, tenant: TenantContext, products: Sequence[Product]) -> List[StockProduct]:
    """What is in stock for the given products (all of them the tenant's), tenant-scoped."""
    quantities: Dict[uuid.UUID, Decimal] = {}
    reserved: Dict[uuid.UUID, Decimal] = {}
    if products:
        for product_id, quantity, held in db.execute(
            select(StockBalance.product_id, StockBalance.quantity, StockBalance.reserved_quantity).where(
                StockBalance.organization_id == tenant.organization_id, StockBalance.product_id.in_([p.id for p in products])
            )
        ).all():
            quantities[product_id] = quantity
            reserved[product_id] = held
    return [
        StockProduct(
            product_id=p.id, sku=p.sku, name=p.name, category=p.category, unit=p.unit,
            unit_allows_fractions=allows_fractions(p.unit), is_active=p.is_active,
            total_quantity=quantities.get(p.id) or ZERO,  # nothing in stock reads "0", whether or not a balance row exists
            reserved_quantity=reserved.get(p.id) or ZERO,
            available_quantity=(quantities.get(p.id) or ZERO) - (reserved.get(p.id) or ZERO),
            selling_price=p.selling_price, currency_code=p.currency_code,
        )
        for p in products
    ]


def stock_overview(
    db: Session,
    tenant: TenantContext,
    *,
    q: Optional[str],
    category: Optional[str],
    product_status: str,
    in_stock_only: bool,
    limit: int,
    offset: int,
) -> StockOverview:
    filters = []
    if q and q.strip():
        pattern = like_pattern(q.strip())
        filters.append(or_(Product.sku.ilike(pattern, escape="\\"), Product.name.ilike(pattern, escape="\\"), Product.category.ilike(pattern, escape="\\")))
    if category and category.strip():
        filters.append(func.lower(Product.category) == category.strip().lower())
    if product_status == "active":
        filters.append(Product.is_active.is_(True))
    elif product_status == "archived":
        filters.append(Product.is_active.is_(False))

    # "has stock", always inside the tenant
    if in_stock_only:
        filters.append(exists().where(and_(StockBalance.organization_id == tenant.organization_id, StockBalance.product_id == Product.id, StockBalance.quantity > 0)))

    total = db.scalar(scoped_count(Product, tenant, *filters))
    products = db.scalars(
        scoped_select(Product, tenant).where(*filters).order_by(Product.name, Product.sku, Product.id).limit(limit).offset(offset)
    ).all()

    items = stock_items(db, tenant, products)
    return StockOverview(items=items, total=total, limit=limit, offset=offset)
