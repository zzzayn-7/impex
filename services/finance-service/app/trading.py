"""Capital, Investment and Profit & Loss: how the facts are recorded (the READING of them is in reporting.py).

THE RULES (docs/finance.md, "Capital, Investment and Profit & Loss"):

  * Owner capital changes ONLY by an owner contribution or withdrawal (`CapitalRecord`) or an opening position. A purchase of stock - however it is paid for - is
    an INVESTMENT ACTIVITY (a cost-basis movement), never a contribution; a customer payment is never profit.
  * Profit is recognised ONCE, when a dispatch is CONFIRMED (the goods left): revenue = delivered quantity x the unit price agreed on the sales order line,
    cost = the ACTUAL weighted-average cost of that quantity from the goods receipts (and the costs of stock the person entered) - never the product's editable
    cost-price field. An invoice or a payment cannot recognise it again; an invoice that billed a different amount only records an ADJUSTMENT (a discount).
  * Nothing is guessed. A delivery with no recorded price, or no reliable cost, is kept as `needs_price` / `needs_cost`: it counts in no profit figure and is
    listed for reconciliation. A cost is never assumed to be zero.
  * Every fact is recorded exactly once (a unique key per fact), in ONE currency; nothing here converts or adds different currencies.
  * Records are append-only. A mistake is corrected by a reversing row; the database refuses UPDATE and DELETE.
"""
import uuid
from datetime import date, datetime, time, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Dict, Iterable, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.common import Actor, audit
from app.currencies import is_known_currency
from app.models import CostEntry, InventoryCost, TradeAdjustment, TradeDelivery

ZERO = Decimal("0")
QUANT = Decimal("0.0001")


class Unreadable(Exception):
    """The event's data cannot be trusted (not a number, unknown currency ...). Nothing is guessed from it."""


class NotYet(Exception):
    """Something this fact depends on has not been recorded yet. Retried later."""


# --- small helpers ----------------------------------------------------------------------------------------------------------------------
def q4(value: Decimal) -> Decimal:
    return value.quantize(QUANT, rounding=ROUND_HALF_UP)


def zone_of(name: Optional[str]) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return ZoneInfo("UTC")


def start_of_day(day: date, zone: ZoneInfo) -> datetime:
    """The instant a calendar day begins in the organization's time zone."""
    return datetime.combine(day, time.min, tzinfo=zone).astimezone(timezone.utc)


def today_in(zone: ZoneInfo, now: Optional[datetime] = None) -> date:
    return (now or datetime.now(timezone.utc)).astimezone(zone).date()


def _when(value) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise Unreadable("unreadable time")
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _amount(value, field: str, *, positive: bool = False, optional: bool = False) -> Optional[Decimal]:
    if value is None or value == "":
        if optional:
            return None
        raise Unreadable(f"'{field}' is missing")
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        raise Unreadable(f"'{field}' is not a number")
    if not number.is_finite() or number < 0 or (positive and number == 0):
        raise Unreadable(f"'{field}' must be {'above zero' if positive else 'zero or more'}")
    if q4(number) != number:
        raise Unreadable(f"'{field}' has more than 4 decimal places")
    return number


def _currency(value, *, optional: bool = False) -> Optional[str]:
    code = str(value or "")
    if not code and optional:
        return None
    if not is_known_currency(code):
        raise Unreadable(f"unknown currency '{code}'")  # never guessed or defaulted
    return code


def _text(value, fallback: str, limit: int) -> str:
    return " ".join(str(value or fallback).split())[:limit]


def _uuid(value, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise Unreadable(f"'{field}' is not an id")


# --- the cost of stock (weighted average) -----------------------------------------------------------------------------------------------
def _pool_for_update(db: Session, organization_id: uuid.UUID, product_id: uuid.UUID, currency: str) -> Optional[InventoryCost]:
    return db.scalar(select(InventoryCost).where(InventoryCost.organization_id == organization_id, InventoryCost.product_id == product_id, InventoryCost.currency_code == currency).with_for_update())


def add_cost(
    db: Session, organization_id: uuid.UUID, *, kind: str, source_key: str, product_id: uuid.UUID, sku: str, name: str, currency: str, quantity: Decimal, value: Decimal,
    effective_at: datetime, reference: Optional[str] = None, counterparty: Optional[str] = None, detail: Optional[str] = None, link_id: Optional[uuid.UUID] = None,
    email: Optional[str] = None,
) -> Optional[CostEntry]:
    """Add `quantity` of a product to the stock cost, at a total cost of `value`. Exactly once per `source_key`: asked again, it does nothing and returns None."""
    if db.scalar(select(CostEntry.id).where(CostEntry.organization_id == organization_id, CostEntry.source_key == source_key)) is not None:
        return None
    db.execute(
        pg_insert(InventoryCost).values(organization_id=organization_id, product_id=product_id, currency_code=currency, product_sku=sku[:64], product_name=name[:255])
        .on_conflict_do_nothing(index_elements=["organization_id", "product_id", "currency_code"])
    )
    pool = _pool_for_update(db, organization_id, product_id, currency)
    pool.quantity = pool.quantity + quantity
    pool.total_value = pool.total_value + value
    pool.product_sku, pool.product_name = sku[:64], name[:255]
    entry = CostEntry(
        organization_id=organization_id, source_key=source_key, kind=kind, product_id=product_id, product_sku=sku[:64], product_name=name[:255], currency_code=currency,
        quantity=quantity, value=value, quantity_after=pool.quantity, value_after=pool.total_value, effective_at=effective_at, reference=reference, counterparty=counterparty,
        detail=detail, link_id=link_id, created_by_email=email,
    )
    db.add(entry)
    db.flush()
    return entry


def take_cost(db: Session, organization_id: uuid.UUID, *, product_id: uuid.UUID, currency: str, quantity: Decimal, source_key: str, sku: str, name: str, effective_at: datetime,
              reference: Optional[str], counterparty: Optional[str], detail: Optional[str]) -> Optional[Decimal]:
    """The cost of `quantity` leaving stock: the stock's total value x quantity / quantity on hand (the weighted average), or ALL the value when it all leaves. None when
    stock of that product in that currency is not recorded in enough quantity - the cost is then unknown, never zero."""
    pool = _pool_for_update(db, organization_id, product_id, currency)
    if pool is None or pool.quantity < quantity:
        return None
    cogs = pool.total_value if quantity == pool.quantity else q4(pool.total_value * quantity / pool.quantity)
    pool.quantity = pool.quantity - quantity
    pool.total_value = pool.total_value - cogs
    db.add(CostEntry(
        organization_id=organization_id, source_key=source_key, kind="delivery", product_id=product_id, product_sku=sku[:64], product_name=name[:255], currency_code=currency,
        quantity=quantity, value=cogs, quantity_after=pool.quantity, value_after=pool.total_value, effective_at=effective_at, reference=reference, counterparty=counterparty, detail=detail,
    ))
    db.flush()
    return cogs


def settle_cost(db: Session, row: TradeDelivery) -> bool:
    """Try to give a delivery its actual cost from the stock cost. True when it now has one (and counts in profit)."""
    if row.revenue is None or row.currency_code is None or row.status == "recognized":
        return False
    cogs = take_cost(
        db, row.organization_id, product_id=row.product_id, currency=row.currency_code, quantity=row.quantity, source_key=f"delivery-cost:{row.id}", sku=row.product_sku, name=row.product_name,
        effective_at=row.delivered_at, reference=row.dispatch_number, counterparty=row.client_name, detail=row.order_number,
    )
    if cogs is None:
        pool = _pool_for_update(db, row.organization_id, row.product_id, row.currency_code)
        have = format(pool.quantity, "f") if pool is not None else "0"
        row.note = f"No reliable {row.currency_code} cost for {row.product_sku}: {have} in stock cost records against {format(row.quantity, 'f')} delivered. Add the stock cost to reconcile."[:300]
        row.status = "needs_cost"
        return False
    row.cogs, row.status, row.note = cogs, "recognized", None
    return True


def recost_pending(db: Session, organization_id: uuid.UUID, product_id: uuid.UUID, currency: str, since: datetime, actor: Actor) -> int:
    """New stock cost has arrived (a goods receipt, or stock cost entered by hand): deliveries of this product, in this currency, made from `since` on that were waiting
    for a cost take it now, oldest first. Returns how many were settled."""
    pending = list(db.scalars(
        select(TradeDelivery).where(
            TradeDelivery.organization_id == organization_id, TradeDelivery.product_id == product_id, TradeDelivery.currency_code == currency,
            TradeDelivery.status == "needs_cost", TradeDelivery.delivered_at >= since,
        ).order_by(TradeDelivery.delivered_at, TradeDelivery.id).with_for_update()
    ))
    settled = 0
    for row in pending:
        if settle_cost(db, row):
            settled += 1
            audit(db, organization_id, "delivery", row.id, "cost_settled", actor, f"{row.dispatch_number}: cost {format(row.cogs, 'f')} {row.currency_code} from the recorded stock cost")
    return settled


# --- Purchasing: a confirmed goods receipt is stock bought at its ACTUAL price (an investment ACTIVITY, never an owner contribution) -------------
def apply_receipt(db: Session, organization_id: uuid.UUID, data: dict, actor: Actor) -> int:
    """Record what a confirmed goods receipt added to the stock cost: accepted quantity x the purchase order's unit price, per product. Exactly once per receipt and
    product, however often the receipt is read again. Returns the number of cost entries written."""
    currency = _currency(data.get("currency_code"))
    receipt_id = _uuid(data.get("receipt_id"), "receipt_id")
    confirmed_at = _when(data.get("confirmed_at"))
    lines = data.get("lines")
    if not isinstance(lines, list):
        raise Unreadable("a receipt has no lines")
    by_product: Dict[uuid.UUID, dict] = {}
    for line in lines:
        if not isinstance(line, dict) or not line.get("product_id"):
            continue  # a receipt read before the feed named its products: its cost cannot be attributed to a product, so nothing is invented
        product = _uuid(line["product_id"], "product_id")
        quantity, price = _amount(line.get("accepted_quantity"), "accepted_quantity", positive=True), _amount(line.get("unit_price"), "unit_price")
        slot = by_product.setdefault(product, {"quantity": ZERO, "value": ZERO, "sku": _text(line.get("sku"), "?", 64), "name": _text(line.get("name"), "Product", 255)})
        slot["quantity"] += quantity
        slot["value"] += quantity * price
    written = 0
    for product, slot in by_product.items():
        entry = add_cost(
            db, organization_id, kind="receipt", source_key=f"receipt-cost:{receipt_id}:{product}", product_id=product, sku=slot["sku"], name=slot["name"], currency=currency,
            quantity=slot["quantity"], value=q4(slot["value"]), effective_at=confirmed_at, reference=_text(data.get("receipt_number"), "?", 100),
            counterparty=_text(data.get("supplier_name"), "a supplier", 150), detail=_text(data.get("purchase_order_number"), "?", 300), link_id=receipt_id,
        )
        if entry is not None:
            written += 1
            recost_pending(db, organization_id, product, currency, confirmed_at, actor)
    return written


# --- Sales: a confirmed dispatch is the moment revenue and cost of goods sold are recognised ----------------------------------------------------
def apply_delivery(db: Session, organization_id: uuid.UUID, data: dict, actor: Actor) -> int:
    """Recognise every line of a confirmed dispatch, once. Returns how many lines were recognised by THIS call (0 when it was already recorded)."""
    dispatch_id = _uuid(data.get("dispatch_id"), "dispatch_id")
    delivered_at = _when(data.get("confirmed_at"))
    currency = _currency(data.get("currency_code"), optional=True)
    lines = data.get("lines")
    if not isinstance(lines, list) or not lines:
        raise Unreadable("a delivery has no lines")
    recognised = 0
    for line in lines:
        if not isinstance(line, dict):
            raise Unreadable("a delivery line is unreadable")
        line_id = _uuid(line.get("dispatch_line_id"), "dispatch_line_id")
        key = f"delivery-line:{line_id}"
        if db.scalar(select(TradeDelivery.id).where(TradeDelivery.organization_id == organization_id, TradeDelivery.source_key == key)) is not None:
            continue  # recorded already: reading the same delivery again can never recognise it twice
        quantity = _amount(line.get("quantity"), "quantity", positive=True)
        price = _amount(line.get("unit_price"), "unit_price", optional=True) if currency else None
        revenue = q4(quantity * price) if price is not None else None
        row = TradeDelivery(
            organization_id=organization_id, source_key=key, dispatch_id=dispatch_id, dispatch_line_id=line_id, dispatch_number=_text(data.get("dispatch_number"), "?", 32),
            order_number=_text(data.get("order_number"), "", 32) or None, client_name=_text(data.get("client_name"), "a client", 255), product_id=_uuid(line.get("product_id"), "product_id"),
            product_sku=_text(line.get("sku"), "?", 64), product_name=_text(line.get("name"), "Product", 255), quantity=quantity, currency_code=currency,
            unit_price=price, revenue=revenue, cogs=None, status="needs_price" if price is None else "needs_cost", delivered_at=delivered_at,
            note="No price was recorded for this product on the sales order (an order made before prices were recorded): the revenue is unknown, so no profit is shown. Enter the price to reconcile." if price is None else None,
        )
        db.add(row)
        db.flush()
        if price is not None:
            settle_cost(db, row)
        recognised += 1
        audit(db, organization_id, "delivery", row.id, "recognized" if row.status == "recognized" else row.status, actor,
              f"{row.dispatch_number}: {format(quantity, 'f')} x {row.product_sku}" + (f", revenue {format(revenue, 'f')} {currency}" if revenue is not None else ", no price recorded")
              + (f", cost {format(row.cogs, 'f')}" if row.cogs is not None else ""))
    return recognised


# --- Sales: an invoice never recognises revenue again; it can only adjust what delivery recognised --------------------------------------------------
def apply_invoice_issued(db: Session, organization_id: uuid.UUID, data: dict, activated_at: Optional[datetime], actor: Actor) -> int:
    """For each delivered line an issued invoice bills: the difference between what the invoice bills (net of its discount, before tax) and the revenue delivery already
    recognised is recorded as ONE adjustment (a discount is negative). Returns how many adjustments were recorded."""
    allocations = data.get("allocations")
    if not isinstance(allocations, list) or not allocations:
        return 0
    currency = _currency(data.get("currency_code"))
    invoice_id = _uuid(data.get("invoice_id"), "invoice_id")
    number = _text(data.get("number"), "?", 32)
    issued_at = _when(data.get("issued_at"))
    written = 0
    for allocation in allocations:
        line_id = _uuid(allocation.get("dispatch_line_id"), "dispatch_line_id")
        delivery = db.scalar(select(TradeDelivery).where(TradeDelivery.organization_id == organization_id, TradeDelivery.source_key == f"delivery-line:{line_id}"))
        if delivery is None:
            confirmed = allocation.get("dispatch_confirmed_at")
            if not confirmed or (activated_at is not None and _when(confirmed) < activated_at):
                continue  # goods delivered before Finance began: no revenue was recognised for them, so there is nothing to adjust
            raise NotYet("waiting for the delivery this invoice bills to be recognised first")
        if delivery.revenue is None or delivery.currency_code != currency:
            continue  # no recorded price, or another currency: nothing is compared across currencies and no price is invented
        quantity, billed = _amount(allocation.get("quantity"), "quantity", positive=True), _amount(allocation.get("net_amount"), "net_amount")
        difference = billed - q4(delivery.unit_price * quantity)
        key = f"invoice-adjustment:{invoice_id}:{line_id}"
        if difference == 0 or db.scalar(select(TradeAdjustment.id).where(TradeAdjustment.organization_id == organization_id, TradeAdjustment.source_key == key)) is not None:
            continue
        adjustment = TradeAdjustment(
            organization_id=organization_id, source_key=key, kind="invoice_adjustment", invoice_id=invoice_id, delivery_id=delivery.id, reference=number, amount=difference,
            currency_code=currency, effective_at=issued_at,
            description=f"Invoice {number} billed {format(billed, 'f')} for {delivery.product_sku} against {format(q4(delivery.unit_price * quantity), 'f')} recognised at delivery"[:300],
        )
        db.add(adjustment)
        db.flush()
        audit(db, organization_id, "delivery", delivery.id, "invoice_adjustment", actor, f"{number}: {format(difference, 'f')} {currency}")
        written += 1
    return written


def apply_invoice_voided(db: Session, organization_id: uuid.UUID, data: dict, actor: Actor) -> int:
    """A voided invoice undoes the adjustments it made (each reversed once). The delivery's own revenue stays: the goods were still delivered."""
    invoice_id = _uuid(data.get("invoice_id"), "invoice_id")
    voided_at = _when(data.get("voided_at"))
    adjustments = list(db.scalars(select(TradeAdjustment).where(TradeAdjustment.organization_id == organization_id, TradeAdjustment.invoice_id == invoice_id, TradeAdjustment.kind == "invoice_adjustment")))
    reversed_count = 0
    for original in adjustments:
        key = f"invoice-adjustment-reversed:{original.id}"
        if db.scalar(select(TradeAdjustment.id).where(TradeAdjustment.organization_id == organization_id, TradeAdjustment.source_key == key)) is not None:
            continue
        db.add(TradeAdjustment(
            organization_id=organization_id, source_key=key, kind="invoice_adjustment_reversal", invoice_id=invoice_id, delivery_id=original.delivery_id, reference=original.reference,
            amount=-original.amount, currency_code=original.currency_code, effective_at=voided_at, reverses_id=original.id,
            description=f"Invoice {original.reference} was voided: its adjustment is reversed"[:300],
        ))
        db.flush()
        audit(db, organization_id, "delivery", original.delivery_id, "invoice_adjustment_reversed", actor, f"{original.reference}: {format(-original.amount, 'f')} {original.currency_code}")
        reversed_count += 1
    return reversed_count


def has_adjustments(db: Session, organization_id: uuid.UUID, invoice_id: str) -> bool:
    try:
        wanted = uuid.UUID(str(invoice_id))
    except ValueError:
        return False
    return db.scalar(select(TradeAdjustment.id).where(TradeAdjustment.organization_id == organization_id, TradeAdjustment.invoice_id == wanted).limit(1)) is not None
