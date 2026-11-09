"""Sales orders: a customer order that BOOKS stock and owns an automatically generated delivery list.

    Create Order -> Reserve stock -> Delivery list (Ready) -> Edit / View / Cancel -> Dispatch -> Deduct stock and consume the reservation
    -> Invoice -> Payment

The rules that matter most:

  * The Inventory Service owns reservations. Sales never keeps a stock counter of its own: it asks the Inventory Service to book, change or
    release the order's quantities, and believes only an answer that matches exactly what it asked for (`verify_reservation`).
  * An order is ACTIVE only after the booking is verified. Until then it is `pending_reservation` and the list is a draft: an unbooked order
    can never be dispatched, and if the Inventory Service is unreachable nothing is accepted on hope.
  * Every step that needs the Inventory Service is DURABLE. The intent (create / edit / cancel / close, with a stable Idempotency-Key and the
    complete desired lines) is saved first (`pending_*`); the Inventory Service is asked with NO transaction open; only a verified answer is
    applied to our own records, in one transaction. A timeout or a crash leaves the intent in place, and asking again (same key) finishes the
    job: the Inventory Service replays its first answer instead of booking twice (`drive`).
  * Order lines are the delivery-list items of the order's list: one authoritative record, so the order, its list and the dispatches can never
    disagree. The list is generated with the order, is Ready at once (no manual step) and never expires.
  * Nothing here changes physical stock, invoices, payments or Finance: stock leaves only when a dispatch is CONFIRMED (dispatches.py).
  * Lock order, everywhere: the delivery list first, then the order. Edits are refused while a dispatch is being posted, and a dispatch is
    refused while a change to the order is being applied.
  * Delivered History is a VISIBILITY rule: a finished order is listed for 24 hours after `completed_at` (server UTC clock, see clock.py) and
    then simply stops matching the query. Nothing is deleted; dispatches, movements, invoices and payments are untouched.
"""
import hashlib
import json
import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

from app import clock, delivery
from app.auth import TenantContext
from app.delivery import conflict, get_list_or_404, human, list_items
from app.inventory import InventoryGateway, InventoryUnavailable, ProductInfo, unavailable_error
from app.models import Client, DeliveryList, DeliveryListItem, Dispatch, DispatchLine, SalesOrder, SalesOrderCounter, SalesOrderRequest
from app.schemas import (
    ClientRef,
    OrderDetail,
    OrderLineResponse,
    OrderListRef,
    OrderStock,
    OrderSummary,
)
from app.tenancy import scoped_select

ZERO = Decimal("0.0000")
QUANT = Decimal("0.0001")
HISTORY_WINDOW = timedelta(hours=24)
FINISHED = ("delivered", "closed")


def canonical(value: Decimal) -> str:
    return format(Decimal(value).quantize(QUANT), "f")


def _user_id(tenant: TenantContext) -> uuid.UUID:
    try:
        return uuid.UUID(tenant.user_id)
    except ValueError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Organization administrator permission required")


def _database_refusal(exc: DBAPIError) -> HTTPException:
    message = str(exc.orig).splitlines()[0] if exc.orig is not None else "the database refused the change"
    return conflict(f"That change is not allowed: {message}.")


class Mismatch(Exception):
    """The Inventory Service's answer does not say what we asked for: not trusted."""


# --- numbering ----------------------------------------------------------------------------------------------------------------
def next_number(db: Session, tenant: TenantContext) -> str:
    """SO-000001, SO-000002, ... per organization, from an atomically incremented counter inside the creating transaction."""
    row = db.execute(
        pg_insert(SalesOrderCounter)
        .values(organization_id=tenant.organization_id, last_number=1)
        .on_conflict_do_update(index_elements=["organization_id"], set_={"last_number": SalesOrderCounter.last_number + 1})
        .returning(SalesOrderCounter.last_number)
    ).one()
    return f"SO-{row[0]:06d}"


# --- loading ---------------------------------------------------------------------------------------------------------------------
def get_order_or_404(db: Session, tenant: TenantContext, order_id: uuid.UUID, *, lock: bool = False) -> SalesOrder:
    query = scoped_select(SalesOrder, tenant).where(SalesOrder.id == order_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    found = db.scalar(query)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    return found


def order_for_list(db: Session, tenant: TenantContext, list_id: uuid.UUID, *, lock: bool = False) -> Optional[SalesOrder]:
    query = scoped_select(SalesOrder, tenant).where(SalesOrder.delivery_list_id == list_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    return db.scalar(query)


def lock_pair(db: Session, tenant: TenantContext, order_id: uuid.UUID) -> Tuple[DeliveryList, SalesOrder]:
    """The list first, then the order: the one lock order of every order operation (and of the dispatch operations)."""
    order = get_order_or_404(db, tenant, order_id)
    delivery_list = get_list_or_404(db, tenant, order.delivery_list_id, lock=True)
    return delivery_list, get_order_or_404(db, tenant, order_id, lock=True)


def _dispatch_rows(db: Session, tenant: TenantContext, list_id: uuid.UUID) -> List[Dispatch]:
    return list(db.scalars(scoped_select(Dispatch, tenant).where(Dispatch.delivery_list_id == list_id)))


def _confirmed_totals(db: Session, tenant: TenantContext, list_id: uuid.UUID) -> Dict[uuid.UUID, Decimal]:
    """item id -> quantity on CONFIRMED dispatches."""
    rows = db.execute(
        select(DispatchLine.delivery_list_item_id, func.coalesce(func.sum(DispatchLine.quantity), 0))
        .join(Dispatch, and_(Dispatch.organization_id == DispatchLine.organization_id, Dispatch.id == DispatchLine.dispatch_id))
        .where(DispatchLine.organization_id == tenant.organization_id, Dispatch.delivery_list_id == list_id, Dispatch.status == "confirmed")
        .group_by(DispatchLine.delivery_list_item_id)
    ).all()
    return {item_id: Decimal(total).quantize(QUANT) for item_id, total in rows}


def _items_with_any_dispatch_line(db: Session, tenant: TenantContext, list_id: uuid.UUID) -> set:
    rows = db.execute(
        select(DispatchLine.delivery_list_item_id)
        .join(Dispatch, and_(Dispatch.organization_id == DispatchLine.organization_id, Dispatch.id == DispatchLine.dispatch_id))
        .where(DispatchLine.organization_id == tenant.organization_id, Dispatch.delivery_list_id == list_id)
    ).all()
    return {r[0] for r in rows}


# --- what the Inventory Service is asked / what we trust -----------------------------------------------------------------------------
def line_rows(items: List[DeliveryListItem]) -> List[dict]:
    return [
        {"item_id": str(i.id), "product_id": str(i.product_id), "sku": i.product_sku, "name": i.product_name, "unit": i.unit, "quantity": canonical(i.quantity)}
        for i in items
    ]


def reservation_body(order: SalesOrder, rows: List[dict]) -> dict:
    return {
        "source_id": str(order.id),
        "source_reference": order.number,
        "lines": [{"line_id": r["item_id"], "product_id": r["product_id"], "quantity": r["quantity"], "unit": r["unit"]} for r in rows],
    }


def verify_reservation(data: Optional[dict], order_id: uuid.UUID, rows: List[dict], *, released: bool = False) -> None:
    """Accept the Inventory Service's answer only if it says exactly what we asked for: this order, and for every line the right product and
    a booking whose dispatched + still-reserved quantities add up to the quantity we asked for (nothing at all remains after a release)."""
    try:
        if not isinstance(data, dict) or str(data.get("source_id")) != str(order_id):
            raise Mismatch()
        states = {uuid.UUID(str(s["line_id"])): s for s in data["lines"]}
        wanted = {uuid.UUID(r["item_id"]): r for r in rows}
        for line_id, state in states.items():
            if released or line_id not in wanted:
                if Decimal(str(state["remaining_quantity"])) != 0:
                    raise Mismatch()
        if released:
            return
        for line_id, r in wanted.items():
            state = states.get(line_id)
            if state is None or str(uuid.UUID(str(state["product_id"]))) != r["product_id"]:
                raise Mismatch()
            if Decimal(str(state["consumed_quantity"])) + Decimal(str(state["remaining_quantity"])) != Decimal(r["quantity"]):
                raise Mismatch()
    except Mismatch:
        raise
    except (KeyError, ValueError, TypeError, ArithmeticError, AttributeError):
        raise Mismatch()


# --- validating what a caller asks for -----------------------------------------------------------------------------------------------------
def _shortage_text(info: ProductInfo, wanted: Decimal) -> str:
    text = f"Only {human(max(info.available, ZERO))} {info.unit} of {info.name} {'is' if info.available == 1 else 'are'} available"
    if info.reserved > 0:
        text += f": {human(info.reserved)} {info.unit} {'is' if info.reserved == 1 else 'are'} already reserved for other orders"
    return text + f". {human(wanted)} {info.unit} requested."


def validate_new_lines(gateway: InventoryGateway, lines) -> Dict[uuid.UUID, ProductInfo]:
    """Every product exists, is active and takes the quantity (whole numbers for pieces, boxes ...), and its AVAILABLE stock covers it.
    (A first look so a plain shortage is explained before anything is created; the Inventory Service re-checks it authoritatively.)"""
    try:
        infos = gateway.products([l.product_id for l in lines])
    except InventoryUnavailable:
        raise unavailable_error()
    shortages = []
    for line in lines:
        info = infos.get(line.product_id)
        if info is None:  # does not exist, or belongs to another organization: the same answer
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found.")
        delivery.require_active_product(info)
        delivery.check_quantity(info, line.quantity)
        if info.available < line.quantity:
            shortages.append((info, line.quantity))
    if shortages:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"code": "insufficient_available", "message": " ".join(_shortage_text(i, q) for i, q in shortages),
             "shortages": [{"product_id": str(i.id), "name": i.name, "unit": i.unit, "requested": canonical(q), "available": canonical(max(i.available, ZERO)),
                            "on_hand": canonical(i.total), "reserved_elsewhere": canonical(i.reserved)} for i, q in shortages]},
        )
    return infos


# --- the durable workflow: drive a pending intent to its end ---------------------------------------------------------------------------------
class Outcome:
    """kind: done (applied), rejected (the Inventory Service definitively refused: nothing was booked/changed), pending (not yet known)."""

    def __init__(self, kind: str, message: str = "", shortages: Optional[list] = None, code: Optional[str] = None):
        self.kind, self.message, self.shortages, self.code = kind, message, shortages, code


def _intent_rows(order: SalesOrder) -> List[dict]:
    return list(order.pending_lines or [])


def drive(db: Session, tenant: TenantContext, gateway: InventoryGateway, order_id: uuid.UUID) -> Outcome:
    """Carry the order's saved intent as far as it can go: ask the Inventory Service (no transaction open, stable key), and apply our side
    only for a VERIFIED answer. Safe to call again and again, from any process, after any crash."""
    order = get_order_or_404(db, tenant, order_id)
    action = order.pending_action
    if action is None:
        db.rollback()
        return Outcome("done")
    key, rows = order.pending_key, _intent_rows(order)
    if action == "create" and not rows:
        rows = line_rows(list_items(db, tenant, order.delivery_list_id))
    released = action == "cancel"
    body = reservation_body(order, rows)
    if released:
        body.pop("lines")  # a release names only the order: the Inventory Service refuses anything else
    db.rollback()  # no transaction is open while the Inventory Service is asked

    call = gateway.release if released else gateway.reserve
    outcome = call(key, body)
    data, problem, shortages, code = (outcome.data if outcome.kind == "applied" else None), outcome.message, outcome.shortages, outcome.code
    if outcome.kind in ("rejected", "unknown"):
        # we do not take either answer on faith: the same key may have been applied earlier even though a reply was lost
        lookup = gateway.reservation_by_key(key)
        if lookup.kind == "found":
            data, problem = lookup.data, ""
        elif outcome.kind == "rejected" and lookup.kind == "absent":
            _rejected(db, tenant, order_id, action, problem, shortages)
            return Outcome("rejected", message=_edit_message(action, problem, shortages), shortages=shortages, code=code)
    if data is not None:
        try:
            verify_reservation(data, order_id, rows, released=released)
        except Mismatch:
            problem = "The inventory service's answer did not match this order, so it was not trusted."
        else:
            _apply(db, tenant, order_id, action, key)
            return Outcome("done")
    _note_attempt_failure(db, tenant, order_id, problem or "The booking could not be verified yet.")
    return Outcome("pending", message=problem or "The booking could not be verified yet.")


def _edit_message(action: str, problem: str, shortages: Optional[list]) -> str:
    if action == "edit" and shortages:
        first = shortages[0]
        try:
            return f"Cannot increase {first['name']} to {human(Decimal(first['requested']))}. Only {human(Decimal(first['free']))} additional {first['unit']} {'is' if Decimal(first['free']) == 1 else 'are'} currently available."
        except (KeyError, ArithmeticError):
            return problem
    return problem


def _note_attempt_failure(db: Session, tenant: TenantContext, order_id: uuid.UUID, message: str) -> None:
    order = get_order_or_404(db, tenant, order_id, lock=True)
    if order.pending_action is not None:
        order.last_error = message[:500]
        db.commit()
    else:
        db.rollback()


def _rejected(db: Session, tenant: TenantContext, order_id: uuid.UUID, action: str, message: str, shortages: Optional[list]) -> None:
    """Definitive refusal: nothing was booked or changed in the Inventory Service."""
    try:
        order = get_order_or_404(db, tenant, order_id)
        delivery_list = get_list_or_404(db, tenant, order.delivery_list_id, lock=True)
        order = get_order_or_404(db, tenant, order_id, lock=True)
        if order.pending_action is None:
            db.rollback()
            return
        text = _edit_message(action, message, shortages)[:500]
        if action == "create":  # never activated: a failed order (its draft list is cancelled with it)
            delivery_list.status = "cancelled"
            db.flush()
            order.status, order.reservation_status = "failed", "none"
        else:  # the order simply stays as it was
            order.reservation_status = "reserved"
        order.pending_action = order.pending_key = order.pending_lines = order.pending_since = None
        order.last_error = text
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise


def _apply(db: Session, tenant: TenantContext, order_id: uuid.UUID, action: str, key: str) -> None:
    """The verified answer is in: change our own records - one transaction, the list first, then the order."""
    from app import dispatches  # imported here: dispatches builds on this module's neighbours

    try:
        order = get_order_or_404(db, tenant, order_id)
        delivery_list = get_list_or_404(db, tenant, order.delivery_list_id, lock=True)
        order = get_order_or_404(db, tenant, order_id, lock=True)
        if order.pending_action != action or order.pending_key != key:  # another request finished (or replaced) this intent first
            db.rollback()
            return
        rows = _intent_rows(order)
        now = clock.now()
        if action == "create":
            if delivery_list.status == "draft":
                delivery_list.status = "ready"
                db.flush()
            order.status, order.reservation_status, order.version = "active", "reserved", 1
        elif action in ("edit", "close"):
            _write_lines(db, tenant, delivery_list, rows)
            order.version += 1
            if action == "close":
                dispatches.recompute_list_status(db, tenant, delivery_list)
                order.status, order.reservation_status, order.completed_at, order.cancelled_at, order.cancelled_by_email = "closed", "released", now, now, tenant.email
            else:
                order.reservation_status = "reserved"
                dispatches.recompute_list_status(db, tenant, delivery_list)
                if delivery_list.status == "dispatched":  # the edit left nothing undelivered
                    order.status, order.reservation_status, order.completed_at = "delivered", "consumed", now
        elif action == "cancel":
            for draft in (d for d in _dispatch_rows(db, tenant, delivery_list.id) if d.status == "draft"):  # unfinished drafts go with the order
                draft.status, draft.cancelled_at, draft.cancelled_by_email = "cancelled", now, tenant.email
            db.flush()
            delivery_list.status = "cancelled"
            db.flush()
            order.status, order.reservation_status, order.cancelled_at, order.cancelled_by_email = "cancelled", "released", now, tenant.email
        order.pending_action = order.pending_key = order.pending_lines = order.pending_since = None
        order.last_error = None
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise


def _write_lines(db: Session, tenant: TenantContext, delivery_list: DeliveryList, rows: List[dict]) -> None:
    """Make the list's items exactly these lines: change quantities, add products, remove lines nothing was dispatched from."""
    existing = {i.id: i for i in list_items(db, tenant, delivery_list.id)}
    wanted = {uuid.UUID(r["item_id"]): r for r in rows}
    for item_id, item in existing.items():
        if item_id not in wanted:
            db.delete(item)
    db.flush()
    for item_id, r in wanted.items():
        item = existing.get(item_id)
        if item is not None:
            item.quantity = Decimal(r["quantity"])
        else:
            db.add(DeliveryListItem(
                id=item_id, organization_id=tenant.organization_id, delivery_list_id=delivery_list.id, product_id=uuid.UUID(r["product_id"]),
                product_sku=r["sku"], product_name=r["name"], unit=r["unit"], quantity=Decimal(r["quantity"]),
            ))
    db.flush()


def complete_if_delivered(db: Session, tenant: TenantContext, delivery_list: DeliveryList) -> None:
    """Called inside the transaction that confirms a dispatch, after the list's status was recomputed (list row locked): when the list is
    fully dispatched its order is Delivered, and `completed_at` (server UTC) starts the 24-hour Delivered History window."""
    if delivery_list.status != "dispatched":
        return
    order = order_for_list(db, tenant, delivery_list.id, lock=True)
    if order is not None and order.status == "active":
        order.status, order.reservation_status, order.completed_at = "delivered", "consumed", clock.now()
        db.flush()


# --- creating ---------------------------------------------------------------------------------------------------------------------------------
def _request_hash(payload) -> str:
    body = {"client": str(payload.client_id), "notes": payload.notes or "", "lines": sorted(f"{l.product_id}:{canonical(l.quantity)}" for l in payload.lines)}
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


def _replay(db: Session, tenant: TenantContext, gateway: InventoryGateway, key: str, request_hash: str) -> SalesOrder:
    previous = db.scalar(scoped_select(SalesOrderRequest, tenant).where(SalesOrderRequest.idempotency_key == key))
    if previous is None or previous.order_id is None:
        raise conflict("The request was being processed. Please retry.")
    if previous.request_hash != request_hash:
        raise conflict("This Idempotency-Key was already used for a different request. Use a new key for a new order.")
    order_id = previous.order_id
    order = get_order_or_404(db, tenant, order_id)
    if order.pending_action is not None:
        drive(db, tenant, gateway, order_id)  # a retry finishes a booking that was left half way
    return get_order_or_404(db, tenant, order_id)


def create_order(db: Session, tenant: TenantContext, gateway: InventoryGateway, payload, key: str) -> Tuple[SalesOrder, bool, Outcome]:
    """Save an order: validate, record it as pending, book the stock, then activate it (list Ready) - or fail without booking anything.
    Returns (order, replayed, outcome). Saving the same request twice (same key) returns the first order and books nothing twice."""
    request_hash = _request_hash(payload)
    if db.scalar(scoped_select(SalesOrderRequest, tenant).where(SalesOrderRequest.idempotency_key == key)) is not None:
        return _replay(db, tenant, gateway, key, request_hash), True, Outcome("done")

    client = delivery.get_client_or_404(db, tenant, payload.client_id)
    if not client.is_active:
        raise conflict(f"{client.name} is inactive. Reactivate the client before creating an order for them.")
    db.rollback()
    infos = validate_new_lines(gateway, payload.lines)  # no transaction is open while the Inventory Service is asked

    claimed = db.execute(
        pg_insert(SalesOrderRequest)
        .values(organization_id=tenant.organization_id, idempotency_key=key, request_hash=request_hash)
        .on_conflict_do_nothing(index_elements=["organization_id", "idempotency_key"])
        .returning(SalesOrderRequest.id)
    ).first()
    if claimed is None:  # a concurrent duplicate won the race and has committed by now
        db.rollback()
        return _replay(db, tenant, gateway, key, request_hash), True, Outcome("done")
    try:
        client = delivery.get_client_or_404(db, tenant, payload.client_id)
        if not client.is_active:
            raise conflict(f"{client.name} is inactive. Reactivate the client before creating an order for them.")
        list_id, order_id = uuid.uuid4(), uuid.uuid4()
        number = next_number(db, tenant)
        delivery_list = DeliveryList(
            id=list_id, organization_id=tenant.organization_id, client_id=client.id, number=delivery.next_number(db, tenant), status="draft",
            notes=f"Generated by sales order {number}", created_by=_user_id(tenant), created_by_email=tenant.email,
        )
        db.add(delivery_list)
        db.flush()
        items = []
        for line in payload.lines:
            info = infos[line.product_id]
            items.append(DeliveryListItem(
                id=uuid.uuid4(), organization_id=tenant.organization_id, delivery_list_id=list_id, product_id=info.id, product_sku=info.sku,
                product_name=info.name, quantity=line.quantity, unit=info.unit,
            ))
        db.add_all(items)
        db.flush()
        order = SalesOrder(
            id=order_id, organization_id=tenant.organization_id, number=number, client_id=client.id, delivery_list_id=list_id, status="pending_reservation",
            reservation_status="pending", origin="order", version=1, pending_action="create", pending_key=f"order-{order_id}-v1",
            pending_lines=line_rows(items), pending_since=clock.now(), notes=payload.notes, created_by=_user_id(tenant), created_by_email=tenant.email,
        )
        db.add(order)
        db.flush()
        db.execute(SalesOrderRequest.__table__.update().where(SalesOrderRequest.id == claimed[0]).values(order_id=order_id))
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()  # the claimed key and the numbers are released together with everything else
        raise
    outcome = drive(db, tenant, gateway, order_id)
    return get_order_or_404(db, tenant, order_id), False, outcome


# --- booking an OLDER list (made before reservations existed) -------------------------------------------------------------------
def book_list(db: Session, tenant: TenantContext, gateway: InventoryGateway, list_id: uuid.UUID) -> Tuple[SalesOrder, Outcome]:
    """Turn a delivery list that has no order into a booked one: reserve ALL its quantities atomically, then it is Ready. Used when a
    draft list is marked Ready, and to book an older Ready list. A list that already has goods dispatched cannot be converted (what is
    still undelivered cannot be told apart from what was never booked): it needs reconciliation by hand."""
    delivery_list = get_list_or_404(db, tenant, list_id)
    existing = order_for_list(db, tenant, list_id)
    if existing is not None:
        stuck = existing.pending_action is not None
        db.rollback()
        if stuck:  # a booking that was left half way is finished by asking again with the same key
            outcome = drive(db, tenant, gateway, existing.id)
            return get_order_or_404(db, tenant, existing.id), outcome
        return existing, Outcome("done")
    if delivery_list.status not in ("draft", "ready"):
        raise conflict(f"{delivery_list.number} is {delivery_list.status} and cannot be booked.")
    client_id = delivery.require_active_client(db, tenant, delivery_list).id
    items = list_items(db, tenant, list_id)
    if not items:
        raise conflict("Add at least one product before marking the list Ready.")
    if any(d.status in ("posting", "confirmed") for d in _dispatch_rows(db, tenant, list_id)):
        raise conflict(f"{delivery_list.number} already has goods dispatched against it from before stock was reserved. It cannot be booked automatically; finish it with its existing dispatches.")
    wanted = [(i.product_id, i.quantity) for i in items]
    db.rollback()

    class _Line:  # validate_new_lines wants objects with product_id / quantity
        def __init__(self, product_id, quantity):
            self.product_id, self.quantity = product_id, quantity

    validate_new_lines(gateway, [_Line(p, q) for p, q in wanted])
    try:
        delivery_list = get_list_or_404(db, tenant, list_id, lock=True)
        if order_for_list(db, tenant, list_id) is not None:
            db.rollback()
            return order_for_list(db, tenant, list_id), Outcome("done")
        items = list_items(db, tenant, list_id)
        order_id = uuid.uuid4()
        order = SalesOrder(
            id=order_id, organization_id=tenant.organization_id, number=next_number(db, tenant), client_id=client_id, delivery_list_id=list_id,
            status="pending_reservation", reservation_status="pending", origin="list", version=1, pending_action="create",
            pending_key=f"order-{order_id}-v1", pending_lines=line_rows(items), pending_since=clock.now(), created_by=_user_id(tenant),
            created_by_email=tenant.email,
        )
        db.add(order)
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except IntegrityError:
        db.rollback()
        raise
    outcome = drive(db, tenant, gateway, order_id)
    return get_order_or_404(db, tenant, order_id), outcome


# --- editing --------------------------------------------------------------------------------------------------------------------------------------
def _require_changeable(delivery_list: DeliveryList, order: SalesOrder, dispatch_rows: List[Dispatch], *, for_what: str) -> None:
    if order.status != "active":
        raise conflict(f"{order.number} is {order.status.replace('_', ' ')}: it cannot be {for_what}.", code="order_not_active")
    if order.pending_action is not None or order.reservation_status != "reserved":
        raise conflict(f"A change to {order.number} is being applied right now. Please try again in a moment.", code="order_busy")
    if any(d.status == "posting" for d in dispatch_rows):
        raise conflict(f"A dispatch of {order.number} is being posted to stock right now. Finish it (confirm it again) before the order can be {for_what}.", code="dispatch_posting")


def edit_order(db: Session, tenant: TenantContext, gateway: InventoryGateway, order_id: uuid.UUID, payload) -> Tuple[SalesOrder, Outcome]:
    """Change an active order to EXACTLY these lines: quantities up or down, products added, lines nothing was dispatched from removed.
    The reservation is adjusted by the difference (released, or booked only if the extra units are available) - all or nothing - and only then
    does the order change. Confirmed dispatch history is never touched: a line cannot go below what was dispatched."""
    get_order_or_404(db, tenant, order_id)  # 404 before anything else
    db.rollback()
    try:
        infos: Dict[uuid.UUID, ProductInfo] = gateway.products([l.product_id for l in payload.lines])  # no transaction is open while it is asked
    except InventoryUnavailable:
        raise unavailable_error()

    try:
        delivery_list, order = lock_pair(db, tenant, order_id)
        dispatch_rows = _dispatch_rows(db, tenant, delivery_list.id)
        _require_changeable(delivery_list, order, dispatch_rows, for_what="changed")
        if payload.version != order.version:
            raise conflict(f"{order.number} was changed by someone else since you opened it. Reload it and make your change again.", code="stale_order")
        items = {i.product_id: i for i in list_items(db, tenant, delivery_list.id)}
        confirmed = _confirmed_totals(db, tenant, delivery_list.id)
        with_history = _items_with_any_dispatch_line(db, tenant, delivery_list.id)
        rows: List[dict] = []
        changed = False
        for line in payload.lines:
            info = infos.get(line.product_id)
            existing = items.get(line.product_id)
            if info is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found.")
            delivery.check_quantity(info, line.quantity)
            if existing is None:
                delivery.require_active_product(info)
                rows.append({"item_id": str(uuid.uuid4()), "product_id": str(info.id), "sku": info.sku, "name": info.name, "unit": info.unit, "quantity": canonical(line.quantity)})
                changed = True
                continue
            if info.unit != existing.unit:
                raise conflict(f"{info.name} is now counted in '{info.unit}' but the order line is in '{existing.unit}'. A quantity is never converted; correct the unit first.")
            done = confirmed.get(existing.id, ZERO)
            if line.quantity < done:
                raise conflict(f"{existing.product_name}: {human(done)} {existing.unit} was already dispatched, so the quantity cannot go below that.", code="below_dispatched")
            if line.quantity != existing.quantity:
                changed = True
            rows.append({"item_id": str(existing.id), "product_id": str(existing.product_id), "sku": existing.product_sku, "name": existing.product_name, "unit": existing.unit, "quantity": canonical(line.quantity)})
        wanted_products = {l.product_id for l in payload.lines}
        for product_id, existing in items.items():
            if product_id not in wanted_products:
                if existing.id in with_history:
                    raise conflict(f"{existing.product_name} cannot be removed: it appears in the dispatch history of this order. Lower its quantity to what was dispatched instead.", code="has_dispatch_history")
                changed = True
        if "notes" in payload.model_fields_set and (payload.notes or None) != (order.notes or None):
            order.notes = payload.notes
        if not changed:  # nothing to book or release: just the note (if any)
            db.commit()
            return get_order_or_404(db, tenant, order_id), Outcome("done")
        order.pending_action, order.pending_key = "edit", f"order-{order.id}-v{order.version + 1}"
        order.pending_lines, order.pending_since, order.reservation_status, order.last_error = rows, clock.now(), "updating", None
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    outcome = drive(db, tenant, gateway, order_id)
    return get_order_or_404(db, tenant, order_id), outcome


# --- cancelling -------------------------------------------------------------------------------------------------------------------------------------
def cancel_order(db: Session, tenant: TenantContext, gateway: InventoryGateway, order_id: uuid.UUID, version: Optional[int] = None) -> Tuple[SalesOrder, Outcome]:
    """Cancel an order nothing was dispatched from: its list is cancelled, everything it reserved is released, it leaves the active list.
    Repeating it is harmless. An order that already has goods dispatched cannot be cancelled (see cancel_remaining)."""
    try:
        delivery_list, order = lock_pair(db, tenant, order_id)
        if order.status == "cancelled":
            db.rollback()
            return order, Outcome("done")  # already there: harmless to repeat
        if order.status == "pending_reservation":
            raise conflict(f"{order.number} is still being booked. Wait for the booking to finish (or retry it) before cancelling.", code="order_busy")
        if order.status != "active":
            raise conflict(f"{order.number} is {order.status.replace('_', ' ')} and cannot be cancelled.", code="order_not_active")
        if order.pending_action == "cancel":
            db.rollback()
            outcome = drive(db, tenant, gateway, order_id)  # finish the cancellation that was started
            return get_order_or_404(db, tenant, order_id), outcome
        _require_changeable(delivery_list, order, _dispatch_rows(db, tenant, delivery_list.id), for_what="cancelled")
        if version is not None and version != order.version:
            raise conflict(f"{order.number} was changed by someone else since you opened it. Reload it first.", code="stale_order")
        if any(d.status == "confirmed" for d in _dispatch_rows(db, tenant, delivery_list.id)):
            raise conflict(
                f"{order.number} already has goods dispatched, so it cannot be cancelled: the dispatches stay as the record. "
                "You can cancel the remaining quantity instead.", code="has_dispatches",
            )
        order.pending_action, order.pending_key, order.pending_lines = "cancel", f"release-{order.id}", None
        order.pending_since, order.reservation_status, order.last_error = clock.now(), "updating", None
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    outcome = drive(db, tenant, gateway, order_id)
    return get_order_or_404(db, tenant, order_id), outcome


def cancel_remaining(db: Session, tenant: TenantContext, gateway: InventoryGateway, order_id: uuid.UUID, version: Optional[int] = None) -> Tuple[SalesOrder, Outcome]:
    """After a PARTIAL delivery: cancel what has not been delivered. Confirmed quantities and their dispatches are untouched; the
    outstanding reservation is released and the order is closed (it appears in Delivered History like a delivered one)."""
    try:
        delivery_list, order = lock_pair(db, tenant, order_id)
        if order.status == "closed":
            db.rollback()
            return order, Outcome("done")
        if order.pending_action == "close":
            db.rollback()
            outcome = drive(db, tenant, gateway, order_id)
            return get_order_or_404(db, tenant, order_id), outcome
        _require_changeable(delivery_list, order, _dispatch_rows(db, tenant, delivery_list.id), for_what="closed")
        if version is not None and version != order.version:
            raise conflict(f"{order.number} was changed by someone else since you opened it. Reload it first.", code="stale_order")
        items = list_items(db, tenant, delivery_list.id)
        confirmed = _confirmed_totals(db, tenant, delivery_list.id)
        if not any(confirmed.get(i.id, ZERO) > 0 for i in items):
            raise conflict(f"Nothing of {order.number} was dispatched yet. Cancel the whole order instead.", code="nothing_dispatched")
        with_history = _items_with_any_dispatch_line(db, tenant, delivery_list.id)
        rows = []
        for i in items:
            done = confirmed.get(i.id, ZERO)
            if done > 0:
                rows.append({"item_id": str(i.id), "product_id": str(i.product_id), "sku": i.product_sku, "name": i.product_name, "unit": i.unit, "quantity": canonical(done)})
            elif i.id in with_history:
                raise conflict(f"{i.product_name} cannot be removed: it appears on an earlier (cancelled) dispatch draft, which is kept for history. Dispatch it or leave the order open.", code="has_dispatch_history")
        order.pending_action, order.pending_key = "close", f"order-{order.id}-v{order.version + 1}"
        order.pending_lines, order.pending_since, order.reservation_status, order.last_error = rows, clock.now(), "updating", None
        for draft in (d for d in _dispatch_rows(db, tenant, delivery_list.id) if d.status == "draft"):  # drafts of the cancelled remainder go with it
            draft.status, draft.cancelled_at, draft.cancelled_by_email = "cancelled", clock.now(), tenant.email
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    outcome = drive(db, tenant, gateway, order_id)
    return get_order_or_404(db, tenant, order_id), outcome


def reconcile(db: Session, tenant: TenantContext, gateway: InventoryGateway, order_id: uuid.UUID) -> Outcome:
    """Finish an intent that was left half way (a timeout, a crash, an outage): ask the Inventory Service again with the same key."""
    return drive(db, tenant, gateway, order_id)


# --- dispatch integration -----------------------------------------------------------------------------------------------------------------------
def require_orderly_dispatch(db: Session, tenant: TenantContext, delivery_list: DeliveryList) -> Optional[SalesOrder]:
    """Goods may be dispatched only against a list whose order is ACTIVE with a verified booking and no change in flight. A list that has
    no order is an older one (see book_list): it is dispatched against AVAILABLE stock only. Returns the order, if any."""
    order = order_for_list(db, tenant, delivery_list.id)
    if order is None:
        return None
    if order.status == "pending_reservation":
        raise conflict(f"{order.number} is not booked yet: goods cannot be dispatched against it until the Inventory Service has confirmed its stock booking.", code="not_booked")
    if order.status != "active":
        raise conflict(f"{order.number} is {order.status.replace('_', ' ')}: goods cannot be dispatched against it.")
    if order.pending_action is not None or order.reservation_status != "reserved":
        raise conflict(f"A change to {order.number} is being applied right now. Please try again in a moment.", code="order_busy")
    return order


# --- views --------------------------------------------------------------------------------------------------------------------------------------------
def history_cutoff() -> datetime:
    return clock.now() - HISTORY_WINDOW


def _client_refs(db: Session, tenant: TenantContext, orders: List[SalesOrder]) -> Dict[uuid.UUID, Client]:
    return {c.id: c for c in db.scalars(scoped_select(Client, tenant).where(Client.id.in_({o.client_id for o in orders})))}


def summaries(db: Session, tenant: TenantContext, orders: List[SalesOrder]) -> List[OrderSummary]:
    if not orders:
        return []
    clients = _client_refs(db, tenant, orders)
    lists = {l.id: l for l in db.scalars(scoped_select(DeliveryList, tenant).where(DeliveryList.id.in_({o.delivery_list_id for o in orders})))}
    counts = dict(
        db.execute(
            select(DeliveryListItem.delivery_list_id, func.count())
            .where(DeliveryListItem.organization_id == tenant.organization_id, DeliveryListItem.delivery_list_id.in_(list(lists)))
            .group_by(DeliveryListItem.delivery_list_id)
        ).all()
    )
    out = []
    for o in orders:
        c, l = clients[o.client_id], lists[o.delivery_list_id]
        out.append(OrderSummary(
            id=o.id, number=o.number, client=ClientRef(id=c.id, name=c.name, is_active=c.is_active),
            delivery_list=OrderListRef(id=l.id, number=l.number, status=l.status), status=o.status, reservation_status=o.reservation_status,
            origin=o.origin, version=o.version, product_count=counts.get(l.id, 0), created_by_email=o.created_by_email, created_at=o.created_at,
            updated_at=o.updated_at, completed_at=o.completed_at, cancelled_at=o.cancelled_at,
            history_expires_at=(o.completed_at + HISTORY_WINDOW) if o.completed_at else None, pending_action=o.pending_action,
            last_error=o.last_error, notes=o.notes,
        ))
    return out


def detail(db: Session, tenant: TenantContext, gateway: InventoryGateway, order: SalesOrder, message: Optional[str] = None) -> OrderDetail:
    """The order with its lines: ordered / dispatched / remaining, and the LIVE physical, reserved and available stock of each product.
    If the Inventory Service cannot be asked the order is still shown (it is our own data) with stock_status = 'unavailable'."""
    from app import dispatches

    delivery_list = get_list_or_404(db, tenant, order.delivery_list_id)
    items = list_items(db, tenant, delivery_list.id)
    infos: Dict[uuid.UUID, ProductInfo] = {}
    stock_status = "ok"
    if items and order.status in ("pending_reservation", "active"):
        try:
            infos = gateway.products(i.product_id for i in items)
        except InventoryUnavailable:
            stock_status = "unavailable"
    sums = dispatches.list_quantities(db, tenant, items)
    lines = []
    for i in items:
        done, pending = sums[i.id]
        remaining = max(i.quantity - done - pending, ZERO)
        info = infos.get(i.product_id)
        held = max(i.quantity - done, ZERO) if order.status == "active" and order.reservation_status in ("reserved", "updating") else ZERO
        lines.append(OrderLineResponse(
            id=i.id, product_id=i.product_id, product_sku=i.product_sku, product_name=i.product_name, unit=i.unit,
            unit_allows_fractions=None if info is None else info.allows_fractions, ordered_quantity=i.quantity, dispatched_quantity=done,
            pending_quantity=pending, remaining_quantity=remaining,
            stock=None if info is None else OrderStock(total_quantity=info.total, reserved_quantity=info.reserved, available_quantity=info.available, reserved_for_order=held, product_active=info.is_active),
        ))
    (summary,) = summaries(db, tenant, [order])
    all_dispatches = _dispatch_rows(db, tenant, delivery_list.id)
    any_confirmed = any(d.status == "confirmed" for d in all_dispatches)
    posting = any(d.status == "posting" for d in all_dispatches)
    active = order.status == "active"
    busy = order.pending_action is not None or order.reservation_status != "reserved"
    edit_reason = cancel_reason = None
    if not active:
        edit_reason = cancel_reason = {
            "pending_reservation": "The stock booking for this order has not been confirmed yet.",
            "delivered": "This order is fully delivered.", "closed": "The rest of this order was cancelled.",
            "cancelled": "This order was cancelled.", "failed": "The stock could not be booked for this order.",
        }.get(order.status)
    elif busy:
        edit_reason = cancel_reason = "A change to this order is being applied. Try again in a moment."
    elif posting:
        edit_reason = cancel_reason = "A dispatch is being posted to stock. Finish it (confirm it again) first."
    elif any_confirmed:
        cancel_reason = "Goods were already dispatched, so the order cannot be cancelled. You can cancel the remaining quantity."
    can_edit = active and edit_reason is None
    can_cancel = active and cancel_reason is None
    can_cancel_remaining = active and not busy and not posting and any_confirmed and any(l.remaining_quantity > 0 for l in lines)
    can_dispatch = active and not busy and delivery_list.status in dispatches.DISPATCHABLE_LIST_STATUSES and any(l.remaining_quantity > 0 for l in lines)
    return OrderDetail(
        **summary.model_dump(), lines=lines, stock_status=stock_status, dispatches=dispatches.dispatches_of_list(db, tenant, delivery_list.id),
        can_edit=can_edit, edit_blocked_reason=edit_reason, can_cancel=can_cancel, can_cancel_remaining=can_cancel_remaining,
        cancel_blocked_reason=cancel_reason, can_dispatch=can_dispatch, message=message,
    )


def list_orders(db: Session, tenant: TenantContext, gateway: InventoryGateway, *, view: str, q: Optional[str], client_id: Optional[uuid.UUID], limit: int, offset: int):
    """view=active: orders still to be delivered (newest first). view=delivered: orders completed within the last 24 hours (the cutoff is
    applied HERE, on the server clock, so every administrator and every reload sees the same list)."""
    from app.search import like_pattern

    filters = []
    if view == "active":
        filters.append(SalesOrder.status.in_(("pending_reservation", "active")))
        order_by = (SalesOrder.created_at.desc(), SalesOrder.number.desc())
    else:
        filters += [SalesOrder.status.in_(FINISHED), SalesOrder.completed_at > history_cutoff()]
        order_by = (SalesOrder.completed_at.desc(), SalesOrder.number.desc())
    if client_id:
        filters.append(SalesOrder.client_id == client_id)
    base = scoped_select(SalesOrder, tenant).join(DeliveryList, and_(DeliveryList.id == SalesOrder.delivery_list_id, DeliveryList.organization_id == SalesOrder.organization_id)) \
        .join(Client, and_(Client.id == SalesOrder.client_id, Client.organization_id == SalesOrder.organization_id))
    count = select(func.count()).select_from(SalesOrder).where(SalesOrder.organization_id == tenant.organization_id).join(
        Client, and_(Client.id == SalesOrder.client_id, Client.organization_id == SalesOrder.organization_id)
    ).join(DeliveryList, and_(DeliveryList.id == SalesOrder.delivery_list_id, DeliveryList.organization_id == SalesOrder.organization_id))
    if q and q.strip():
        pattern = like_pattern(q.strip())
        filters.append(or_(SalesOrder.number.ilike(pattern, escape="\\"), DeliveryList.number.ilike(pattern, escape="\\"), Client.name.ilike(pattern, escape="\\")))
    total = db.scalar(count.where(*filters))
    rows = list(db.scalars(base.where(*filters).order_by(*order_by).limit(limit).offset(offset)))
    # an order whose booking was left half way is finished (best effort) before it is shown: the caller's own token is the credential
    if view == "active":
        for stuck in [o for o in rows if o.pending_action is not None][:5]:
            try:
                drive(db, tenant, gateway, stuck.id)
            except HTTPException:
                pass
            except Exception:  # an outage must never break the list
                db.rollback()
        if any(o.pending_action is not None or o.status == "pending_reservation" for o in rows):
            rows = list(db.scalars(base.where(*filters).order_by(*order_by).limit(limit).offset(offset)))
    return summaries(db, tenant, rows), total
