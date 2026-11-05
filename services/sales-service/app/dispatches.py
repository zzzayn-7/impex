"""Client dispatch: goods leaving for a client against a delivery list, and how they are deducted from stock.

The rules that matter most:

  * Creating a delivery list, preparing / saving / reviewing a dispatch, and scanning or locating products NEVER change stock.
    Stock changes only when a dispatch is confirmed, and only through the Inventory Service's own audited, idempotent
    operation (see InventoryGateway.post_dispatch). Prices are never sent, so a catalog price can never be touched.
  * Confirming is a DURABLE two-service workflow:
        1. (short transaction)  the intent is saved: draft -> posting. The quantities are now reserved against the list, so a
                                 second dispatch cannot take them, and the dispatch is frozen.
        2. (NO transaction)     the Inventory Service is asked, with the stable Idempotency-Key  dispatch-<dispatch id>.
        3. (short transaction)  only when its answer is VERIFIED (the right operation, one movement per line, the right
                                 product / warehouse / quantity) does the dispatch become confirmed, and the list Partially
                                 Dispatched / Dispatched.
    If anything is uncertain - timeout, outage, crash, garbled answer - the dispatch STAYS `posting`. Retrying confirm (from any
    process, after any restart) asks again with the same key: the Inventory Service replays the first result instead of
    deducting the goods twice. A dispatch is never called confirmed on hope.
  * If the Inventory Service definitively refuses (not enough stock, an archived warehouse, a changed unit...), nothing was
    deducted and the dispatch returns to draft with the reason, so it can be fixed and confirmed again.
  * No over-dispatch: the quantities of confirmed + posting dispatches can never exceed what the client requested (checked under
    a lock on the delivery list, and again by a database trigger). Two people dispatching at once cannot both take the last units.
  * Units are never converted: a dispatch line has the unit of its delivery-list item.
  * Confirmed dispatches are immutable and are never deleted (database-enforced).
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

from app.auth import TenantContext
from app.delivery import conflict, get_list_or_404, human, list_items
from app.inventory import InventoryGateway, InventoryUnavailable, PostingOutcome, ProductInfo, unavailable_error
from app.models import Client, DeliveryList, DeliveryListItem, Dispatch, DispatchCounter, DispatchLine, DispatchRequest
from app.schemas import (
    ClientRef,
    DispatchDetail,
    DispatchLineInput,
    DispatchLineResponse,
    DispatchSummary,
    ListRef,
    PostingInfo,
)
from app.tenancy import scoped_select

ZERO = Decimal("0.0000")
CENT = Decimal("0.0001")
DISPATCHABLE_LIST_STATUSES = ("ready", "partially_dispatched")


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
    """DS-000001, DS-000002, ... per organization, from an atomically incremented counter inside the creating transaction."""
    row = db.execute(
        pg_insert(DispatchCounter)
        .values(organization_id=tenant.organization_id, last_number=1)
        .on_conflict_do_update(index_elements=["organization_id"], set_={"last_number": DispatchCounter.last_number + 1})
        .returning(DispatchCounter.last_number)
    ).one()
    return f"DS-{row[0]:06d}"


# --- loading --------------------------------------------------------------------------------------------------------------------
def get_dispatch_or_404(db: Session, tenant: TenantContext, dispatch_id: uuid.UUID, *, lock: bool = False) -> Dispatch:
    query = scoped_select(Dispatch, tenant).where(Dispatch.id == dispatch_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    found = db.scalar(query)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dispatch not found.")
    return found


def dispatch_lines(db: Session, tenant: TenantContext, dispatch_id: uuid.UUID) -> List[DispatchLine]:
    return list(
        db.scalars(
            scoped_select(DispatchLine, tenant)
            .where(DispatchLine.dispatch_id == dispatch_id)
            .order_by(DispatchLine.created_at, DispatchLine.product_name, DispatchLine.warehouse_code, DispatchLine.id)
        )
    )


def dispatched_quantities(
    db: Session, tenant: TenantContext, item_ids: Iterable[uuid.UUID], exclude_dispatch: Optional[uuid.UUID] = None
) -> Dict[uuid.UUID, Tuple[Decimal, Decimal]]:
    """item id -> (confirmed quantity, pending quantity) over the list's dispatches, optionally leaving one dispatch out.
    "Pending" is what dispatches in the `posting` state have reserved. Drafts reserve nothing."""
    ids = list(item_ids)
    if not ids:
        return {}
    totals: Dict[uuid.UUID, List[Decimal]] = {i: [ZERO, ZERO] for i in ids}
    query = (
        select(DispatchLine.delivery_list_item_id, Dispatch.status, func.coalesce(func.sum(DispatchLine.quantity), 0))
        .join(Dispatch, and_(Dispatch.organization_id == DispatchLine.organization_id, Dispatch.id == DispatchLine.dispatch_id))
        .where(
            DispatchLine.organization_id == tenant.organization_id,
            DispatchLine.delivery_list_item_id.in_(ids),
            Dispatch.status.in_(("confirmed", "posting")),
        )
        .group_by(DispatchLine.delivery_list_item_id, Dispatch.status)
    )
    if exclude_dispatch is not None:
        query = query.where(Dispatch.id != exclude_dispatch)
    for item_id, dispatch_status, total in db.execute(query).all():
        totals[item_id][0 if dispatch_status == "confirmed" else 1] = Decimal(total).quantize(CENT)
    return {i: (v[0], v[1]) for i, v in totals.items()}


def list_quantities(db: Session, tenant: TenantContext, items: List[DeliveryListItem]) -> Dict[uuid.UUID, Tuple[Decimal, Decimal]]:
    return dispatched_quantities(db, tenant, [i.id for i in items])


# --- delivery list status ------------------------------------------------------------------------------------------------------
def explain_list_not_dispatchable(delivery_list: DeliveryList) -> HTTPException:
    reasons = {
        "draft": f"{delivery_list.number} is still a draft. Mark it Ready before dispatching goods against it.",
        "cancelled": f"{delivery_list.number} is cancelled. Goods cannot be dispatched against it.",
        "dispatched": f"{delivery_list.number} is already fully dispatched. There is nothing left to dispatch.",
    }
    return conflict(reasons.get(delivery_list.status, f"{delivery_list.number} is {delivery_list.status}; goods cannot be dispatched against it."))


def require_dispatchable_list(delivery_list: DeliveryList) -> None:
    if delivery_list.status not in DISPATCHABLE_LIST_STATUSES:
        raise explain_list_not_dispatchable(delivery_list)


def recompute_list_status(db: Session, tenant: TenantContext, delivery_list: DeliveryList) -> None:
    """Called inside the transaction that confirms a dispatch (dispatch already flushed as confirmed, list row locked): the
    list becomes Dispatched when every item is fully dispatched, otherwise Partially Dispatched. The database re-checks the claim."""
    items = list_items(db, tenant, delivery_list.id)
    sums = list_quantities(db, tenant, items)
    any_dispatched = any(sums[i.id][0] > 0 for i in items)
    everything = all(sums[i.id][0] >= i.quantity for i in items)
    target = "dispatched" if everything else ("partially_dispatched" if any_dispatched else delivery_list.status)
    if target != delivery_list.status:
        delivery_list.status = target
        db.flush()


# --- views -------------------------------------------------------------------------------------------------------------------------
def summaries(db: Session, tenant: TenantContext, dispatches: List[Dispatch]) -> List[DispatchSummary]:
    if not dispatches:
        return []
    lists = {l.id: l for l in db.scalars(scoped_select(DeliveryList, tenant).where(DeliveryList.id.in_({d.delivery_list_id for d in dispatches})))}
    clients = {c.id: c for c in db.scalars(scoped_select(Client, tenant).where(Client.id.in_({d.client_id for d in dispatches})))}
    counts = dict(
        db.execute(
            select(DispatchLine.dispatch_id, func.count())
            .where(DispatchLine.organization_id == tenant.organization_id, DispatchLine.dispatch_id.in_([d.id for d in dispatches]))
            .group_by(DispatchLine.dispatch_id)
        ).all()
    )
    out = []
    for d in dispatches:
        delivery_list, client = lists[d.delivery_list_id], clients[d.client_id]
        out.append(
            DispatchSummary(
                id=d.id, number=d.number, status=d.status, delivery_list=ListRef(id=delivery_list.id, number=delivery_list.number, status=delivery_list.status),
                client=ClientRef(id=client.id, name=client.name, is_active=client.is_active), dispatch_date=d.dispatch_date,
                tracking_reference=d.tracking_reference, line_count=counts.get(d.id, 0), created_by_email=d.created_by_email, created_at=d.created_at,
                confirmed_at=d.confirmed_at, confirmed_by_email=d.confirmed_by_email, cancelled_at=d.cancelled_at, cancelled_by_email=d.cancelled_by_email,
                updated_at=d.updated_at,
            )
        )
    return out


def dispatches_of_list(db: Session, tenant: TenantContext, list_id: uuid.UUID) -> List[DispatchSummary]:
    rows = db.scalars(
        scoped_select(Dispatch, tenant).where(Dispatch.delivery_list_id == list_id).order_by(Dispatch.created_at.desc(), Dispatch.number.desc())
    ).all()
    return summaries(db, tenant, list(rows))


def detail(db: Session, tenant: TenantContext, gateway: Optional[InventoryGateway], dispatch: Dispatch) -> DispatchDetail:
    """The dispatch with its lines. For a draft or a posting dispatch the LIVE stock of each line's warehouse is shown (information
    only); if the Inventory Service cannot be asked the dispatch is still shown with stock_status = 'unavailable'."""
    (summary,) = summaries(db, tenant, [dispatch])
    lines = dispatch_lines(db, tenant, dispatch.id)
    items = {i.id: i for i in db.scalars(scoped_select(DeliveryListItem, tenant).where(DeliveryListItem.id.in_([l.delivery_list_item_id for l in lines])))} if lines else {}
    elsewhere = dispatched_quantities(db, tenant, items.keys(), exclude_dispatch=dispatch.id)
    infos: Dict[uuid.UUID, ProductInfo] = {}
    stock_status = "not-needed"
    if lines and dispatch.status in ("draft", "posting") and gateway is not None:
        stock_status = "ok"
        try:
            infos = gateway.products({l.product_id for l in lines})
        except InventoryUnavailable:
            stock_status = "unavailable"
    rows, exceeding = [], 0
    needed: Dict[Tuple[uuid.UUID, uuid.UUID], Decimal] = {}
    for l in lines:
        needed[(l.product_id, l.warehouse_id)] = needed.get((l.product_id, l.warehouse_id), ZERO) + l.quantity
    for l in lines:
        requested = items[l.delivery_list_item_id].quantity
        confirmed, pending = elsewhere.get(l.delivery_list_item_id, (ZERO, ZERO))
        info = infos.get(l.product_id)
        available = info.in_warehouse(l.warehouse_id) if info is not None else None
        if available is not None and needed[(l.product_id, l.warehouse_id)] > available:
            exceeding += 1
        rows.append(
            DispatchLineResponse(
                id=l.id, delivery_list_item_id=l.delivery_list_item_id, product_id=l.product_id, product_sku=l.product_sku, product_name=l.product_name,
                unit=l.unit, requested_quantity=requested, dispatched_elsewhere_quantity=confirmed, pending_elsewhere_quantity=pending,
                dispatchable_quantity=max(requested - confirmed - pending, ZERO), warehouse_id=l.warehouse_id, warehouse_code=l.warehouse_code,
                quantity=l.quantity, inventory_movement_id=l.inventory_movement_id, available_in_warehouse=available,
            )
        )
    return DispatchDetail(
        **summary.model_dump(), delivery_address=dispatch.delivery_address, transport_details=dispatch.transport_details, notes=dispatch.notes,
        lines=rows, inventory_operation_id=dispatch.inventory_operation_id, editable=dispatch.status == "draft", stock_status=stock_status,
        lines_exceeding_stock=exceeding,
        posting=PostingInfo(
            attempts=dispatch.posting_attempts, started_at=dispatch.posting_started_at,
            last_attempt_at=dispatch.last_posting_attempt_at, last_error=dispatch.last_posting_error,
        ),
    )


# --- checking what a caller asks for -----------------------------------------------------------------------------------------------
class Row:
    """One dispatch line, validated, as plain values (no ORM objects, so no database session is needed to hold it)."""

    def __init__(self, item: DeliveryListItem, warehouse_id: uuid.UUID, quantity: Decimal):
        self.item_id, self.product_id, self.sku, self.name, self.unit = item.id, item.product_id, item.product_sku, item.product_name, item.unit
        self.requested = item.quantity
        self.warehouse_id, self.quantity = warehouse_id, quantity
        self.warehouse_code: Optional[str] = None


def row_from_line(line: DispatchLine, requested: Decimal) -> Row:
    row = Row.__new__(Row)
    row.item_id, row.product_id, row.sku, row.name, row.unit = line.delivery_list_item_id, line.product_id, line.product_sku, line.product_name, line.unit
    row.requested, row.warehouse_id, row.quantity, row.warehouse_code = requested, line.warehouse_id, line.quantity, line.warehouse_code
    return row


def local_rows(db: Session, tenant: TenantContext, delivery_list: DeliveryList, inputs: List[DispatchLineInput]) -> List[Row]:
    """Everything that can be judged from our own data."""
    items = {i.id: i for i in list_items(db, tenant, delivery_list.id)}
    seen, rows = set(), []
    for entry in inputs:
        item = items.get(entry.delivery_list_item_id)
        if item is None:  # an item of another list or organization looks exactly like one that does not exist
            raise HTTPException(status.HTTP_404_NOT_FOUND, "That product is not on this delivery list.")
        if (item.id, entry.warehouse_id) in seen:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{item.product_name} appears more than once for the same warehouse.")
        seen.add((item.id, entry.warehouse_id))
        rows.append(Row(item, entry.warehouse_id, entry.quantity))
    return rows


def remote_checks(gateway: InventoryGateway, rows: List[Row], *, require_stock: bool = False) -> None:
    """Ask the Inventory Service (caller's own token) whether the products and warehouses can serve this. Called with no
    transaction open. Archived or unknown things are refused; a product whose unit is no longer the listed one is refused.
    With require_stock the warehouses must also hold the quantities (checked again, authoritatively, by the Inventory Service)."""
    if not rows:
        return
    try:
        products: Dict[uuid.UUID, ProductInfo] = gateway.products([r.product_id for r in rows])
        warehouses: Dict[uuid.UUID, dict] = {}
        for warehouse_id in dict.fromkeys(r.warehouse_id for r in rows):
            found = gateway.warehouse(warehouse_id)
            if found is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Warehouse not found.")
            warehouses[warehouse_id] = found
    except InventoryUnavailable:
        raise unavailable_error()
    needed: Dict[Tuple[uuid.UUID, uuid.UUID], Decimal] = {}
    for r in rows:
        info = products.get(r.product_id)
        if info is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found.")
        if not info.is_active:
            raise conflict(f"{info.name} is archived. Restore it in Products before dispatching it.")
        if info.unit != r.unit:
            raise conflict(
                f"{info.name} is now counted in '{info.unit}' but was listed in '{r.unit}'. A quantity is never converted between units; "
                "correct the product's unit first."
            )
        if not info.allows_fractions and r.quantity != r.quantity.to_integral_value():
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"The quantity must be a whole number: {info.name} is counted in '{info.unit}'.")
        warehouse = warehouses[r.warehouse_id]
        r.warehouse_code = warehouse["code"]
        if not warehouse["is_active"]:
            raise conflict(f"Warehouse {warehouse['code']} is archived. Choose an active warehouse.")
        key = (r.product_id, r.warehouse_id)
        needed[key] = needed.get(key, ZERO) + r.quantity
    if require_stock:
        by_key = {(r.product_id, r.warehouse_id): r for r in rows}
        for (product_id, warehouse_id), quantity in needed.items():
            available = products[product_id].in_warehouse(warehouse_id)
            if quantity > available:
                r = by_key[(product_id, warehouse_id)]
                raise conflict(
                    f"Not enough stock: {human(available)} {r.unit} of {r.name} in {r.warehouse_code}, {human(quantity)} to dispatch. "
                    "Nothing was deducted; reduce the quantity or choose another warehouse.",
                    code="insufficient_stock",
                )


def check_capacity(db: Session, tenant: TenantContext, rows: List[Row], dispatch_id: Optional[uuid.UUID]) -> None:
    """Under the list's lock: the quantities must fit what is still dispatchable (requested - confirmed - being posted elsewhere)."""
    per_item: Dict[uuid.UUID, Decimal] = {}
    first: Dict[uuid.UUID, Row] = {}
    for r in rows:
        per_item[r.item_id] = per_item.get(r.item_id, ZERO) + r.quantity
        first.setdefault(r.item_id, r)
    others = dispatched_quantities(db, tenant, per_item.keys(), exclude_dispatch=dispatch_id)
    for item_id, wanted in per_item.items():
        r = first[item_id]
        confirmed, pending = others.get(item_id, (ZERO, ZERO))
        dispatchable = r.requested - confirmed - pending
        if wanted > dispatchable:
            pending_note = f" ({human(pending)} more is being posted on another dispatch)" if pending > 0 else ""
            raise conflict(
                f"You cannot dispatch {human(wanted)} {r.unit} of {r.name}: the client requested {human(r.requested)}, {human(confirmed)} already dispatched"
                f"{pending_note}, so at most {human(max(dispatchable, ZERO))} can still be dispatched.",
                code="over_dispatch",
            )


# --- creating (idempotent) -------------------------------------------------------------------------------------------------------------
def check_dispatch_date(value: date) -> None:
    if value > (_now() + timedelta(days=1)).date():  # one day of slack for time zones
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The dispatch date cannot be in the future.")


def _request_hash(payload) -> str:
    return hashlib.sha256(json.dumps(payload.model_dump(mode="json"), sort_keys=True).encode()).hexdigest()


def _replay(db: Session, tenant: TenantContext, key: str, request_hash: str) -> Dispatch:
    previous = db.scalar(scoped_select(DispatchRequest, tenant).where(DispatchRequest.idempotency_key == key))
    if previous is None or previous.dispatch_id is None:
        raise conflict("The request was being processed. Please retry.")
    if previous.request_hash != request_hash:
        raise conflict("This Idempotency-Key was already used for a different request. Use a new key for a new dispatch.")
    return get_dispatch_or_404(db, tenant, previous.dispatch_id)


def create_dispatch(db: Session, tenant: TenantContext, gateway: InventoryGateway, payload, key: str) -> Tuple[Dispatch, bool]:
    """A DRAFT dispatch against a Ready / Partially Dispatched list, optionally with its lines. Changes no stock.
    Returns (dispatch, replayed): a repeated request with the same key returns the first dispatch and creates nothing."""
    request_hash = _request_hash(payload)
    if db.scalar(scoped_select(DispatchRequest, tenant).where(DispatchRequest.idempotency_key == key)) is not None:
        return _replay(db, tenant, key, request_hash), True

    delivery_list = get_list_or_404(db, tenant, payload.delivery_list_id)  # another organization's list is simply not found
    require_dispatchable_list(delivery_list)
    if payload.dispatch_date:
        check_dispatch_date(payload.dispatch_date)
    rows = local_rows(db, tenant, delivery_list, payload.lines)
    list_id = delivery_list.id
    db.rollback()
    remote_checks(gateway, rows)  # no transaction is open while the Inventory Service is asked

    claimed = db.execute(
        pg_insert(DispatchRequest)
        .values(organization_id=tenant.organization_id, idempotency_key=key, request_hash=request_hash)
        .on_conflict_do_nothing(index_elements=["organization_id", "idempotency_key"])
        .returning(DispatchRequest.id)
    ).first()
    if claimed is None:  # a concurrent duplicate won the race and has committed by now
        db.rollback()
        return _replay(db, tenant, key, request_hash), True
    try:
        delivery_list = get_list_or_404(db, tenant, list_id, lock=True)  # the list first, always: one lock order for every dispatch operation
        require_dispatchable_list(delivery_list)
        check_capacity(db, tenant, rows, None)
        dispatch_id = uuid.uuid4()
        dispatch = Dispatch(
            id=dispatch_id, organization_id=tenant.organization_id, delivery_list_id=delivery_list.id, client_id=delivery_list.client_id,
            number=next_number(db, tenant), dispatch_date=payload.dispatch_date or _now().date(), delivery_address=payload.delivery_address,
            transport_details=payload.transport_details, tracking_reference=payload.tracking_reference, notes=payload.notes,
            status="draft", posting_key=f"dispatch-{dispatch_id}", created_by=_user_id(tenant), created_by_email=tenant.email,
        )
        db.add(dispatch)
        db.flush()
        _write_lines(db, tenant, dispatch, rows)
        db.execute(DispatchRequest.__table__.update().where(DispatchRequest.id == claimed[0]).values(dispatch_id=dispatch.id))
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()  # the claimed key and the number are released together with everything else
        raise
    db.refresh(dispatch)
    return dispatch, False


def _write_lines(db: Session, tenant: TenantContext, dispatch: Dispatch, rows: List[Row]) -> None:
    db.execute(delete(DispatchLine).where(DispatchLine.organization_id == tenant.organization_id, DispatchLine.dispatch_id == dispatch.id))
    for r in rows:
        db.add(
            DispatchLine(
                organization_id=tenant.organization_id, dispatch_id=dispatch.id, delivery_list_item_id=r.item_id, product_id=r.product_id,
                product_sku=r.sku, product_name=r.name, unit=r.unit, warehouse_id=r.warehouse_id, warehouse_code=r.warehouse_code, quantity=r.quantity,
            )
        )
    db.flush()


def require_draft(dispatch: Dispatch) -> None:
    if dispatch.status != "draft":
        explanation = {
            "posting": "is being deducted from stock; it can no longer be edited. Retry confirming it to finish.",
            "confirmed": "is confirmed. A confirmed dispatch is a permanent record and cannot be changed.",
            "cancelled": "is cancelled and is kept for history.",
        }[dispatch.status]
        raise conflict(f"{dispatch.number} {explanation}")


# --- editing a draft -------------------------------------------------------------------------------------------------------------------
def update_header(db: Session, tenant: TenantContext, dispatch_id: uuid.UUID, changes: dict) -> Dispatch:
    if "dispatch_date" in changes:
        check_dispatch_date(changes["dispatch_date"])
    dispatch = get_dispatch_or_404(db, tenant, dispatch_id)
    delivery_list = get_list_or_404(db, tenant, dispatch.delivery_list_id, lock=True)  # list, then dispatch
    dispatch = get_dispatch_or_404(db, tenant, dispatch_id, lock=True)
    require_draft(dispatch)
    require_dispatchable_list(delivery_list)
    for field, value in changes.items():
        setattr(dispatch, field, value)
    try:
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    db.refresh(dispatch)
    return dispatch


def save_lines(db: Session, tenant: TenantContext, gateway: InventoryGateway, dispatch_id: uuid.UUID, inputs: List[DispatchLineInput]) -> Dispatch:
    """Replace the draft's lines with exactly these. Changes no stock."""
    dispatch = get_dispatch_or_404(db, tenant, dispatch_id)
    require_draft(dispatch)
    delivery_list = get_list_or_404(db, tenant, dispatch.delivery_list_id)
    require_dispatchable_list(delivery_list)
    rows = local_rows(db, tenant, delivery_list, inputs)
    list_id = delivery_list.id
    db.rollback()
    remote_checks(gateway, rows)

    try:
        delivery_list = get_list_or_404(db, tenant, list_id, lock=True)
        dispatch = get_dispatch_or_404(db, tenant, dispatch_id, lock=True)
        require_draft(dispatch)  # re-checked under the locks: someone may have started confirming meanwhile
        require_dispatchable_list(delivery_list)
        check_capacity(db, tenant, rows, dispatch.id)
        _write_lines(db, tenant, dispatch, rows)
        dispatch.updated_at = _now()
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(dispatch)
    return dispatch


def cancel_dispatch(db: Session, tenant: TenantContext, dispatch_id: uuid.UUID) -> Dispatch:
    """Cancel a DRAFT (kept for history). A dispatch that is being posted or confirmed cannot be cancelled: stock may already have moved."""
    dispatch = get_dispatch_or_404(db, tenant, dispatch_id)
    get_list_or_404(db, tenant, dispatch.delivery_list_id, lock=True)  # the list first, then the dispatch
    dispatch = get_dispatch_or_404(db, tenant, dispatch_id, lock=True)
    if dispatch.status == "cancelled":
        db.rollback()
        return dispatch  # already there: harmless to repeat
    if dispatch.status == "posting":
        raise conflict(f"{dispatch.number} is being deducted from stock and cannot be cancelled. Retry confirming it to finish.")
    if dispatch.status == "confirmed":
        raise conflict(f"{dispatch.number} is confirmed: its goods have left stock. A confirmed dispatch cannot be cancelled.")
    dispatch.status, dispatch.cancelled_at, dispatch.cancelled_by_email = "cancelled", _now(), tenant.email
    db.commit()
    db.refresh(dispatch)
    return dispatch


# --- confirming: the durable workflow --------------------------------------------------------------------------------------------------
class Mismatch(Exception):
    """The Inventory Service's answer does not match what was asked for: not trusted."""


def posting_body(dispatch: Dispatch, list_number: str, lines: List[DispatchLine]) -> dict:
    return {
        "dispatch_number": dispatch.number,
        "delivery_list_number": list_number,
        "lines": [
            {"line_id": str(l.id), "product_id": str(l.product_id), "warehouse_id": str(l.warehouse_id), "quantity": format(l.quantity, "f"), "unit": l.unit}
            for l in lines
        ],
    }


def verify_posting(number: str, body: dict, data: Optional[dict]) -> Tuple[uuid.UUID, Dict[uuid.UUID, uuid.UUID]]:
    """Accept the Inventory Service's answer only if it says exactly what we asked for: this dispatch, one movement per line,
    each for the right product, warehouse and quantity. Returns (operation id, dispatch line id -> movement id)."""
    try:
        if not isinstance(data, dict) or data.get("dispatch_number") != number:
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
                or str(uuid.UUID(str(movement["warehouse_id"]))) != expected["warehouse_id"]
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


def _record_attempt_failure(db: Session, tenant: TenantContext, dispatch_id: uuid.UUID, message: str) -> None:
    dispatch = get_dispatch_or_404(db, tenant, dispatch_id, lock=True)
    if dispatch.status == "posting":
        dispatch.last_posting_error = message[:500]
        db.commit()
    else:
        db.rollback()


def _finish(db: Session, tenant: TenantContext, list_id: uuid.UUID, dispatch_id: uuid.UUID, operation_id: uuid.UUID, movements: Dict[uuid.UUID, uuid.UUID]) -> Dispatch:
    """The verified answer is in: record the movements, confirm the dispatch and move the list on - one transaction."""
    try:
        delivery_list = get_list_or_404(db, tenant, list_id, lock=True)
        dispatch = get_dispatch_or_404(db, tenant, dispatch_id, lock=True)
        if dispatch.status == "confirmed":  # another request finished first: nothing more to do
            db.rollback()
            return dispatch
        if dispatch.status != "posting":
            raise conflict(f"{dispatch.number} is {dispatch.status} and cannot be confirmed now.")
        for line in dispatch_lines(db, tenant, dispatch.id):
            line.inventory_movement_id = movements[line.id]
        db.flush()
        dispatch.status, dispatch.inventory_operation_id = "confirmed", operation_id
        dispatch.confirmed_at, dispatch.confirmed_by_email, dispatch.last_posting_error = _now(), tenant.email, None
        db.flush()
        recompute_list_status(db, tenant, delivery_list)
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(dispatch)
    return dispatch


def _return_to_draft(db: Session, tenant: TenantContext, dispatch_id: uuid.UUID, list_id: uuid.UUID, message: str) -> None:
    get_list_or_404(db, tenant, list_id, lock=True)
    dispatch = get_dispatch_or_404(db, tenant, dispatch_id, lock=True)
    if dispatch.status == "posting":
        dispatch.status, dispatch.last_posting_error = "draft", message[:500]
        db.commit()
    else:
        db.rollback()


def confirm_dispatch(db: Session, tenant: TenantContext, gateway: InventoryGateway, dispatch_id: uuid.UUID) -> Tuple[Dispatch, bool]:
    """Returns (dispatch, confirmed). confirmed=False means the posting could not be verified yet: the dispatch stays `posting`
    and confirming it again (the same call) finishes the job without ever deducting the goods twice."""
    dispatch = get_dispatch_or_404(db, tenant, dispatch_id)
    if dispatch.status == "confirmed":
        db.rollback()
        return dispatch, True  # confirming twice is harmless
    if dispatch.status == "cancelled":
        raise conflict(f"{dispatch.number} is cancelled and cannot be confirmed.")
    list_id = dispatch.delivery_list_id

    # -- 0. a draft is checked against the Inventory Service first (no locks, no transaction), so an obvious problem - an archived
    #       product, a changed unit, not enough stock - is explained BEFORE anything is reserved
    if dispatch.status == "draft":
        delivery_list = get_list_or_404(db, tenant, list_id)
        require_dispatchable_list(delivery_list)
        requested = {i.id: i.quantity for i in list_items(db, tenant, list_id)}
        rows = [row_from_line(l, requested[l.delivery_list_item_id]) for l in dispatch_lines(db, tenant, dispatch.id)]
        db.rollback()
        remote_checks(gateway, rows, require_stock=True)

    # -- 1. save the INTENT (short transaction). From here the quantities are reserved and the dispatch is frozen.
    try:
        delivery_list = get_list_or_404(db, tenant, list_id, lock=True)  # the list first, then the dispatch: one lock order everywhere
        dispatch = get_dispatch_or_404(db, tenant, dispatch_id, lock=True)
        if dispatch.status == "confirmed":
            db.rollback()
            return dispatch, True
        if dispatch.status == "cancelled":
            raise conflict(f"{dispatch.number} is cancelled and cannot be confirmed.")
        lines = dispatch_lines(db, tenant, dispatch.id)
        if dispatch.status == "draft":
            require_dispatchable_list(delivery_list)
            if not lines:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "This dispatch has no lines, so there is nothing to deduct from stock. Add the products and quantities, or cancel it.")
            requested = {i.id: i.quantity for i in list_items(db, tenant, list_id)}
            check_capacity(db, tenant, [row_from_line(l, requested[l.delivery_list_item_id]) for l in lines], dispatch.id)
            dispatch.status, dispatch.posting_started_at = "posting", _now()
        dispatch.posting_attempts += 1
        dispatch.last_posting_attempt_at = _now()
        body = posting_body(dispatch, delivery_list.number, lines)
        key, number = dispatch.posting_key, dispatch.number
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise

    # -- 2. ask the Inventory Service. NO database transaction is open here (the commit above ended it).
    outcome: PostingOutcome = gateway.post_dispatch(key, body)
    data, problem = (outcome.data if outcome.kind == "posted" else None), outcome.message

    if outcome.kind == "rejected":
        # Definitive, but we do not take its word for "nothing happened" without asking: the same key may have been used before.
        lookup = gateway.posting_by_key(key)
        if lookup.kind == "absent":
            _return_to_draft(db, tenant, dispatch_id, list_id, f"The inventory service refused the dispatch: {problem}")
            raise conflict(f"The inventory service refused to deduct this dispatch from stock: {problem} Nothing was deducted. Fix it and confirm again.", code="inventory_rejected")
        data = lookup.data if lookup.kind == "found" else None
        problem = problem if lookup.kind != "found" else ""
    elif outcome.kind == "unknown":
        lookup = gateway.posting_by_key(key)  # the request may have been applied even though the answer was lost
        if lookup.kind == "found":
            data, problem = lookup.data, ""

    # -- 3. only a VERIFIED answer confirms the dispatch
    if data is not None:
        try:
            operation_id, movements = verify_posting(number, body, data)
        except Mismatch:
            problem = "The inventory service's answer did not match this dispatch, so it was not trusted."
        else:
            return _finish(db, tenant, list_id, dispatch_id, operation_id, movements), True
    _record_attempt_failure(db, tenant, dispatch_id, problem or "The posting could not be verified.")
    return get_dispatch_or_404(db, tenant, dispatch_id), False


# --- listing -------------------------------------------------------------------------------------------------------------------------------
def search_filter(pattern: str):
    return or_(
        Dispatch.number.ilike(pattern, escape="\\"),
        Dispatch.tracking_reference.ilike(pattern, escape="\\"),
        DeliveryList.number.ilike(pattern, escape="\\"),
        Client.name.ilike(pattern, escape="\\"),
    )
