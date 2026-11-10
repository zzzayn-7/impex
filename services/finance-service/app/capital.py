"""The things a person records: owner contributions and withdrawals, the opening position, the cost of stock already held, and the reconciliation of a delivery.

Every operation adds to the caller's transaction (the API route commits) and writes its audit line in it. Nothing here edits a recorded row: a mistake is reversed by a
new row that names the original, who made it and why.
"""
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import trading
from app.auth import TenantContext
from app.common import Actor, audit, conflict, unprocessable
from app.models import CapitalRecord, CostEntry, OpeningPosition, TradeDelivery
from app.tenancy import scoped_select

KIND_LABEL = {"contribution": "Owner contribution", "withdrawal": "Owner withdrawal"}
TYPE_LABEL = {"cash": "cash / bank", "asset": "asset given in kind", "inventory": "stock given in kind"}


def _not_future(tenant: TenantContext, day) -> None:
    if day > trading.today_in(trading.zone_of(tenant.timezone)) + timedelta(days=1):
        raise unprocessable("future_date", "The date cannot be in the future.")


# --- owner capital ---------------------------------------------------------------------------------------------------------------------------
def record_capital(db: Session, tenant: TenantContext, actor: Actor, payload) -> CapitalRecord:
    """An owner contribution or withdrawal (cash, or an asset / stock given in kind, valued at `amount`). It is the ONLY way owner capital changes, apart from the opening position."""
    _not_future(tenant, payload.effective_date)
    currency = payload.currency_code or tenant.default_currency
    description = payload.description or (f"{KIND_LABEL[payload.kind]} ({TYPE_LABEL[payload.entry_type]})")
    effect = payload.amount if payload.kind == "contribution" else -payload.amount
    row = CapitalRecord(
        organization_id=tenant.organization_id, kind=payload.kind, entry_type=payload.entry_type, is_reversal=False, amount=payload.amount, effect=effect, currency_code=currency,
        effective_date=payload.effective_date, description=description, reference=payload.reference, notes=payload.notes, created_by=actor.user_id, created_by_email=actor.email,
    )
    db.add(row)
    db.flush()
    audit(db, tenant.organization_id, "capital_record", row.id, "recorded", actor, f"{KIND_LABEL[payload.kind]}, {format(payload.amount, 'f')} {currency}, {TYPE_LABEL[payload.entry_type]}")
    return row


def reverse_capital(db: Session, tenant: TenantContext, actor: Actor, record_id: uuid.UUID, payload) -> CapitalRecord:
    original = db.scalar(scoped_select(CapitalRecord, tenant).where(CapitalRecord.id == record_id).with_for_update())
    if original is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Record not found.")
    if original.is_reversal:
        raise conflict("not_reversible", "A reversal cannot itself be reversed. Record the investment again instead.")
    existing = db.scalar(select(CapitalRecord.id).where(CapitalRecord.organization_id == tenant.organization_id, CapitalRecord.reverses_id == original.id))
    if existing is not None:
        raise conflict("already_reversed", "This record was already reversed.")
    day = payload.effective_date or trading.today_in(trading.zone_of(tenant.timezone))
    _not_future(tenant, day)
    row = CapitalRecord(
        organization_id=tenant.organization_id, kind=original.kind, entry_type=original.entry_type, is_reversal=True, reverses_id=original.id, amount=original.amount, effect=-original.effect,
        currency_code=original.currency_code, effective_date=day, description=f"Reversal of: {original.description}"[:500], reference=original.reference, notes=None,
        reversal_reason=payload.reason, created_by=actor.user_id, created_by_email=actor.email,
    )
    db.add(row)
    db.flush()
    audit(db, tenant.organization_id, "capital_record", original.id, "reversed", actor, f"by a reversal: {payload.reason}")
    audit(db, tenant.organization_id, "capital_record", row.id, "recorded", actor, f"Reversal of {KIND_LABEL[original.kind].lower()}, {format(original.amount, 'f')} {original.currency_code}")
    return row


# --- the opening position ---------------------------------------------------------------------------------------------------------------------
def set_opening(db: Session, tenant: TenantContext, actor: Actor, payload) -> OpeningPosition:
    """What the organization owned and owed on the day it starts using Finance, in one currency. The owner's equity is the difference. One active position per currency."""
    _not_future(tenant, payload.effective_date)
    currency = payload.currency_code or tenant.default_currency
    active = db.scalar(select(OpeningPosition.id).where(OpeningPosition.organization_id == tenant.organization_id, OpeningPosition.currency_code == currency, OpeningPosition.status == "active"))
    if active is not None:
        raise conflict("opening_exists", f"An opening position in {currency} already exists. Reverse it first if it was wrong.")
    row = OpeningPosition(
        organization_id=tenant.organization_id, currency_code=currency, effective_date=payload.effective_date, assets=payload.assets, liabilities=payload.liabilities,
        equity=payload.assets - payload.liabilities, notes=payload.notes, created_by=actor.user_id, created_by_email=actor.email,
    )
    db.add(row)
    db.flush()
    audit(db, tenant.organization_id, "opening", row.id, "recorded", actor, f"assets {format(row.assets, 'f')}, liabilities {format(row.liabilities, 'f')}, equity {format(row.equity, 'f')} {currency} on {row.effective_date}")
    return row


def reverse_opening(db: Session, tenant: TenantContext, actor: Actor, position_id: uuid.UUID, payload) -> OpeningPosition:
    row = db.scalar(scoped_select(OpeningPosition, tenant).where(OpeningPosition.id == position_id).with_for_update())
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Opening position not found.")
    if row.status != "active":
        raise conflict("already_reversed", "This opening position was already reversed.")
    row.status, row.reversed_at, row.reversed_by_email, row.reversal_reason = "reversed", datetime.now(timezone.utc), actor.email, payload.reason
    db.flush()
    audit(db, tenant.organization_id, "opening", row.id, "reversed", actor, payload.reason)
    return row


# --- the cost of stock already held -----------------------------------------------------------------------------------------------------------
def add_basis(db: Session, tenant: TenantContext, actor: Actor, payload) -> CostEntry:
    """What stock already held (opening stock, or stock given in kind) cost, per unit: it becomes the cost basis the next deliveries take their cost of goods sold from.
    It changes NO capital figure: the value of such stock is already part of the opening position or of the in-kind contribution - it is only a cost record."""
    _not_future(tenant, payload.effective_date)
    currency = payload.currency_code or tenant.default_currency
    effective_at = trading.start_of_day(payload.effective_date, trading.zone_of(tenant.timezone))
    entry = trading.add_cost(
        db, tenant.organization_id, kind="basis", source_key=f"basis:{uuid.uuid4()}", product_id=payload.product_id, sku=payload.sku, name=payload.name, currency=currency, quantity=payload.quantity,
        value=trading.q4(payload.quantity * payload.unit_cost), effective_at=effective_at, reference=None, counterparty=None, detail=payload.notes or "Cost of stock already held", email=actor.email,
    )
    audit(db, tenant.organization_id, "cost_basis", entry.id, "recorded", actor, f"{format(payload.quantity, 'f')} x {payload.sku} at {format(payload.unit_cost, 'f')} {currency}")
    trading.recost_pending(db, tenant.organization_id, payload.product_id, currency, effective_at, actor)
    return entry


# --- reconciling a delivery that has no reliable price or cost -----------------------------------------------------------------------------------
def reconcile_delivery(db: Session, tenant: TenantContext, actor: Actor, delivery_id: uuid.UUID, payload) -> TradeDelivery:
    """Settle a delivery by hand: the price agreed with the client (an older order that recorded none) and/or the actual unit cost of what was delivered. What is entered is
    final and audited; a recognised delivery cannot be changed."""
    row = db.scalar(scoped_select(TradeDelivery, tenant).where(TradeDelivery.id == delivery_id).with_for_update())
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Delivery not found.")
    if row.status == "recognized":
        raise conflict("already_recognized", "This delivery already has its price and cost, and they are final.")
    changes = []
    if payload.unit_price is not None:
        if row.unit_price is not None:
            raise conflict("price_final", "This delivery already has its agreed price.")
        currency = payload.currency_code or row.currency_code
        if currency is None:
            raise unprocessable("currency_required", "Say which currency the price is in.")
        if row.currency_code is not None and currency != row.currency_code:
            raise unprocessable("currency_mismatch", f"This order is in {row.currency_code}; the price must be too.")
        row.currency_code, row.unit_price, row.revenue = currency, payload.unit_price, trading.q4(row.quantity * payload.unit_price)
        row.status = "needs_cost"
        changes.append(f"price {format(payload.unit_price, 'f')} {currency}")
    if row.status == "needs_price":
        raise unprocessable("price_required", "Enter the price agreed with the client first.")
    if payload.unit_cost is not None:
        row.cogs = trading.q4(row.quantity * payload.unit_cost)
        row.status = "recognized"
        changes.append(f"unit cost {format(payload.unit_cost, 'f')}")
    else:
        trading.settle_cost(db, row)
        if row.status == "recognized":
            changes.append("cost from the recorded stock cost")
    if not changes:
        raise unprocessable("nothing_to_change", "Enter the price or the unit cost to reconcile this delivery.")
    row.note = f"Reconciled by {actor.email}: {payload.reason}"[:300] if row.status == "recognized" else row.note
    row.reconciled_by_email, row.reconciled_at = actor.email, datetime.now(timezone.utc)
    db.flush()
    audit(db, tenant.organization_id, "delivery", row.id, "reconciled", actor, f"{row.dispatch_number}: {', '.join(changes)}. {payload.reason}")
    return row
