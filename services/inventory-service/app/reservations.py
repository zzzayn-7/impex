"""Stock reservations: stock booked for sales orders. The Inventory Service is the ONLY owner of this fact.

Definitions (per product, per organization):
    on hand    = stock_balances.quantity            the physical stock
    reserved   = stock_balances.reserved_quantity   the sum of the remaining quantity of the product's active reservations
    available  = on hand - reserved                 what a new order, a manual stock-out or a scanner can still take

Guarantees (each one is also a database constraint, so a bug here cannot silently break it):
  * Never over-booked.   CHECK 0 <= reserved <= on hand on the balance row; and the check below runs while the balance row is LOCKED, so
                         two orders that arrive together cannot both take the last units.
  * All or nothing.      One request reserves every line of an order, or nothing. Balances are locked in a fixed order (by product id), so
                         two multi-product orders can never deadlock.
  * Totals, not deltas.  A request states the COMPLETE desired quantity of every line of the order (lines left out are released), so
                         applying it twice changes nothing the second time. Together with the Idempotency-Key and the stored first answer, a
                         retry after a timeout or a crash replays exactly what was decided the first time.
  * One reservation per order line (unique source), original = consumed + released + remaining (CHECK).
  * Dispatches consume. A confirmed dispatch shrinks the reservation of its order line in the SAME transaction that deducts the stock
                         (see stock.execute_dispatch); nothing here ever deducts stock.

Callers: only the Sales Service, which proves itself with the shared secret (X-Internal-Key) AND the administrator's own token. The
organization always comes from the token, never from the request.
"""
import uuid
from decimal import Decimal
from typing import Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import TenantContext
from app.models import Product, StockBalance, StockOperation, StockReservation
from app.schemas import ReservationLine, ReservationList, ReservationRelease, ReservationResult, ReservationSet, ReservationState
from app.stock import (
    QUANT,
    ZERO,
    _check_quantity_for_unit,
    _load_product_locked,
    _lock_balances,
    _require_active,
    _start_operation,
    canonical,
    fingerprint,
    human,
)
from app.tenancy import scoped_select

SOURCE_TYPE = "sales_order"


def shortage(product: Product, balance: StockBalance, wanted: Decimal, own_remaining: Decimal) -> dict:
    """What a refused booking looks like, in numbers the caller can show: how much is physically there, how much is booked for OTHER
    orders (this order's own booking is not "somebody else's"), and so how much is available to this order."""
    reserved_elsewhere = balance.reserved_quantity - own_remaining
    available_to_order = balance.quantity - reserved_elsewhere
    return {
        "product_id": str(product.id), "sku": product.sku, "name": product.name, "unit": product.unit,
        "requested": canonical(wanted), "on_hand": canonical(balance.quantity), "reserved_elsewhere": canonical(reserved_elsewhere),
        "available": canonical(max(available_to_order, ZERO)),
        "free": canonical(max(balance.quantity - balance.reserved_quantity, ZERO)),  # on hand minus ALL reserved: what is still unbooked
    }


def shortage_message(item: dict) -> str:
    text = f"Only {human(Decimal(item['available']))} {item['unit']} of {item['name']} {'is' if Decimal(item['available']) == 1 else 'are'} available"
    reserved = Decimal(item["reserved_elsewhere"])
    if reserved > 0:
        text += f": {human(reserved)} {item['unit']} {'is' if reserved == 1 else 'are'} already reserved for other orders"
        on_hand = Decimal(item["on_hand"])
        if on_hand > 0:
            text += f" ({human(on_hand)} on hand)"
    return text + f". {human(Decimal(item['requested']))} {item['unit']} requested."


def _state(r: StockReservation) -> ReservationState:
    q = lambda value: Decimal(value).quantize(QUANT)  # always four decimals, whether or not the row was reloaded
    return ReservationState(
        line_id=r.source_line_id, product_id=r.product_id, original_quantity=q(r.original_quantity), consumed_quantity=q(r.consumed_quantity),
        released_quantity=q(r.released_quantity), remaining_quantity=q(r.remaining_quantity), status=r.status,
    )


def _result_json(operation: uuid.UUID, kind: str, source_id: uuid.UUID, number: str, rows: List[StockReservation]) -> dict:
    result = ReservationResult(
        operation_id=operation, kind=kind, source_id=source_id, source_reference=number, replayed=False,
        lines=[_state(r) for r in sorted(rows, key=lambda r: str(r.source_line_id))],
    )
    return result.model_dump(mode="json")


def _settle(reservation: StockReservation) -> None:
    """Keep status in step with the numbers (the database re-checks the claim)."""
    reservation.remaining_quantity = reservation.original_quantity - reservation.consumed_quantity - reservation.released_quantity
    if reservation.remaining_quantity > 0:
        reservation.status = "active"
    else:
        reservation.status = "fulfilled" if reservation.consumed_quantity > 0 else "released"


def _lock_reservations(db: Session, tenant: TenantContext, source_id: uuid.UUID) -> Dict[uuid.UUID, StockReservation]:
    rows = db.scalars(
        scoped_select(StockReservation, tenant)
        .where(StockReservation.source_type == SOURCE_TYPE, StockReservation.source_id == source_id)
        .order_by(StockReservation.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    return {r.source_line_id: r for r in rows}


def _hash(kind: str, source_id: uuid.UUID, number: str, lines: List[ReservationLine]) -> str:
    return fingerprint(
        kind, source=source_id, number=number,
        lines=";".join(sorted(f"{l.line_id}:{l.product_id}:{canonical(l.quantity)}:{l.unit}" for l in lines)),
    )


def _replay(db: Session, tenant: TenantContext, key: str, kind: str, request_hash: str) -> ReservationResult:
    operation = db.scalar(scoped_select(StockOperation, tenant).where(StockOperation.idempotency_key == key))
    if operation is None or operation.result is None:  # the first attempt rolled back at just the wrong moment: it did NOT happen
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The request was being processed. Please retry.", headers={"Retry-After": "1"})
    if operation.request_hash != request_hash or operation.kind != kind:
        raise HTTPException(status.HTTP_409_CONFLICT, "This Idempotency-Key was already used for a different request. Use a new key for a new request.")
    return ReservationResult(**{**operation.result, "replayed": True})


def _apply(db: Session, tenant: TenantContext, kind: str, key: str, source_id: uuid.UUID, number: str, lines: List[ReservationLine]) -> ReservationResult:
    request_hash = _hash(kind, source_id, number, lines)
    try:
        operation = _start_operation(db, tenant, kind, key, request_hash)
        if operation is None:
            db.rollback()
            return _replay(db, tenant, key, kind, request_hash)

        # Fixed lock order, always: products (shared), balances (by product id), then this order's reservations.
        ordered = sorted(lines, key=lambda l: (str(l.product_id), str(l.line_id)))
        products: Dict[uuid.UUID, Product] = {}
        for line in ordered:
            if line.product_id not in products:
                products[line.product_id] = _load_product_locked(db, tenant, line.product_id)
        existing_for_lock = _peek_reservations(db, tenant, source_id)  # unlocked peek: which products the order already holds
        for product_id in existing_for_lock:
            if product_id not in products:
                products[product_id] = _load_product_locked(db, tenant, product_id)
        balances = _lock_balances(db, tenant, list(products))
        reservations = _lock_reservations(db, tenant, source_id)

        wanted = {l.line_id: l for l in ordered}
        problems: List[dict] = []
        touched: List[StockReservation] = []

        # 1. releases first (lines the order no longer has, and reductions): they can only make more stock available
        for line_id, r in sorted(reservations.items(), key=lambda kv: (str(kv[1].product_id), str(kv[0]))):
            target = wanted.get(line_id)
            if target is not None and target.product_id != r.product_id:
                raise HTTPException(status.HTTP_409_CONFLICT, "An order line cannot be re-pointed at another product.")
            desired_remaining = ZERO if target is None else target.quantity - r.consumed_quantity
            if target is not None and desired_remaining < ZERO:
                product = products[r.product_id]
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {"code": "below_dispatched", "message": f"{product.name}: {human(r.consumed_quantity)} {product.unit} was already dispatched, so the order cannot be reduced below that."},
                )
            if desired_remaining < r.remaining_quantity:
                give_back = r.remaining_quantity - desired_remaining
                balances[r.product_id].reserved_quantity -= give_back
                r.released_quantity += give_back
                _settle(r)
                touched.append(r)

        # 2. then bookings (new lines and increases), each checked against the AVAILABLE stock while the balance is locked
        for line in ordered:
            r = reservations.get(line.line_id)
            consumed = r.consumed_quantity if r is not None else ZERO
            desired_remaining = line.quantity - consumed
            own_remaining = r.remaining_quantity if r is not None else ZERO
            more = desired_remaining - own_remaining
            if more <= ZERO:
                continue
            product, balance = products[line.product_id], balances[line.product_id]
            _require_active(product)
            if product.unit != line.unit:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"{product.name} is now counted in '{product.unit}' but the order line is in '{line.unit}'. A quantity is never converted; correct the unit first.",
                )
            _check_quantity_for_unit(product, line.quantity)
            if balance.quantity - balance.reserved_quantity < more:
                problems.append(shortage(product, balance, more if r is None else line.quantity, own_remaining))
                continue
            balance.reserved_quantity += more
            if r is None:
                r = StockReservation(
                    organization_id=tenant.organization_id, product_id=line.product_id, source_type=SOURCE_TYPE, source_id=source_id,
                    source_reference=number, source_line_id=line.line_id, original_quantity=more, consumed_quantity=ZERO,
                    released_quantity=ZERO, remaining_quantity=more, status="active",
                )
                db.add(r)
                reservations[line.line_id] = r
            else:
                r.original_quantity += more
                _settle(r)
            touched.append(r)

        if problems:  # nothing is kept: the whole request rolls back, so no line of the order is booked
            first = problems[0]
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {"code": "insufficient_available", "message": " ".join(shortage_message(p) for p in problems), "shortages": problems, "first": first},
            )

        db.flush()
        operation_row = db.get(StockOperation, operation)
        operation_row.result = _result_json(operation, kind, source_id, number, list(reservations.values()))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return ReservationResult(**{**operation_row.result, "replayed": False})


def _peek_reservations(db: Session, tenant: TenantContext, source_id: uuid.UUID) -> List[uuid.UUID]:
    """Products this order already holds stock of (read without a lock; the locked read that follows is the one that counts)."""
    return list(
        db.scalars(
            select(StockReservation.product_id).where(
                StockReservation.organization_id == tenant.organization_id, StockReservation.source_type == SOURCE_TYPE, StockReservation.source_id == source_id
            )
        ).all()
    )


def reserve(db: Session, tenant: TenantContext, payload: ReservationSet, key: str) -> ReservationResult:
    """Make the order's reservations EXACTLY these totals (book more, release less), all lines or none."""
    return _apply(db, tenant, "reserve", key, payload.source_id, payload.source_reference, list(payload.lines))


def release(db: Session, tenant: TenantContext, payload: ReservationRelease, key: str) -> ReservationResult:
    """Give back everything the order still holds. What was already dispatched stays dispatched."""
    return _apply(db, tenant, "release", key, payload.source_id, payload.source_reference, [])


def by_key(db: Session, tenant: TenantContext, key: str) -> ReservationResult:
    """Did the request made with this Idempotency-Key happen? Read-only; 404 means it did not (for this organization)."""
    operation = db.scalar(scoped_select(StockOperation, tenant).where(StockOperation.idempotency_key == key, StockOperation.kind.in_(("reserve", "release"))))
    if operation is None or operation.result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No reservation was made with this key.")
    return ReservationResult(**{**operation.result, "replayed": True})


def of_source(db: Session, tenant: TenantContext, source_id: uuid.UUID) -> ReservationList:
    rows = db.scalars(
        scoped_select(StockReservation, tenant)
        .where(StockReservation.source_type == SOURCE_TYPE, StockReservation.source_id == source_id)
        .order_by(StockReservation.created_at, StockReservation.id)
    ).all()
    return ReservationList(source_id=source_id, lines=[_state(r) for r in rows])


def reserved_totals(db: Session, tenant: TenantContext, product_ids: List[uuid.UUID]) -> Dict[uuid.UUID, Decimal]:
    """The sum of the active reservations per product, read from the reservations themselves (used to verify the balance column)."""
    if not product_ids:
        return {}
    return {
        pid: total
        for pid, total in db.execute(
            select(StockReservation.product_id, func.coalesce(func.sum(StockReservation.remaining_quantity), 0))
            .where(StockReservation.organization_id == tenant.organization_id, StockReservation.product_id.in_(product_ids), StockReservation.status == "active")
            .group_by(StockReservation.product_id)
        ).all()
    }
