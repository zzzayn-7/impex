"""The Finance page's API: Capital, Investment and Profit & Loss. Every route depends on `Tenant` (an ACTIVE organization administrator whose organization completed setup
and has the Finance module enabled); none accepts an organization id. The older accounting API (accounts, journal, expenses, synchronisation) is unchanged and still served.
"""
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app import capital, ledger, reporting, trading
from app.api import Tenant, idempotency_key
from app.auth import TenantContext
from app.common import Actor, attach_request, claim_request, conflict
from app.database import get_db
from app.models import CapitalRecord, CostEntry, InventoryCost, OpeningPosition, TradeDelivery
from app.tenancy import scoped_select
from app.trading_schemas import BasisCreate, InvestmentCreate, InvestmentReverse, OpeningCreate, ReasonBody, ReconcileBody

router = APIRouter(prefix="/api/v1/finance")


def clock() -> datetime:
    """The current moment (a dependency so that tests can fix it)."""
    return datetime.now(timezone.utc)


def _money(value) -> Optional[str]:
    return None if value is None else format(value, "f")


def _created_once(db: Session, tenant: TenantContext, key: str, scope: str, payload, response: Response, make, load):
    """Run `make` once per Idempotency-Key: the first request answers 201, a retry (same key and body) answers 200 with the same record and creates nothing."""
    replayed = claim_request(db, tenant, key, scope, payload)
    if replayed is not None:
        response.status_code = status.HTTP_200_OK
        return load(replayed)
    try:
        row = make()
        attach_request(db, tenant, key, row.id)
        db.commit()
    except HTTPException:
        db.rollback()  # a refused request releases its key
        raise
    except DBAPIError as exc:
        db.rollback()
        text = str(exc.orig) if exc.orig is not None else ""
        raise conflict("rule_violation", text.split("ERROR:")[-1].strip().splitlines()[0] if "ERROR:" in text else "The rules of the books refused this record.")
    db.refresh(row)
    return row


# --- serialisation ----------------------------------------------------------------------------------------------------------------------
def capital_out(r: CapitalRecord) -> dict:
    return {
        "id": str(r.id), "kind": r.kind, "entry_type": r.entry_type, "is_reversal": r.is_reversal, "reverses_id": str(r.reverses_id) if r.reverses_id else None, "amount": _money(r.amount),
        "effect": _money(r.effect), "currency_code": r.currency_code, "effective_date": r.effective_date.isoformat(), "description": r.description, "reference": r.reference, "notes": r.notes,
        "reversal_reason": r.reversal_reason, "created_by_email": r.created_by_email, "created_at": r.created_at.isoformat(),
    }


def opening_out(o: OpeningPosition) -> dict:
    return {
        "id": str(o.id), "currency_code": o.currency_code, "effective_date": o.effective_date.isoformat(), "assets": _money(o.assets), "liabilities": _money(o.liabilities), "equity": _money(o.equity),
        "notes": o.notes, "status": o.status, "reversal_reason": o.reversal_reason, "reversed_at": o.reversed_at.isoformat() if o.reversed_at else None, "reversed_by_email": o.reversed_by_email,
        "created_by_email": o.created_by_email, "created_at": o.created_at.isoformat(),
    }


def cost_out(e: CostEntry) -> dict:
    return {
        "id": str(e.id), "kind": e.kind, "product_id": str(e.product_id), "sku": e.product_sku, "name": e.product_name, "currency_code": e.currency_code, "quantity": _money(e.quantity),
        "value": _money(e.value), "effective_at": e.effective_at.isoformat(), "reference": e.reference, "counterparty": e.counterparty, "detail": e.detail, "created_by_email": e.created_by_email,
    }


def delivery_out(d: TradeDelivery) -> dict:
    return {
        "id": str(d.id), "status": d.status, "dispatch_id": str(d.dispatch_id), "dispatch_number": d.dispatch_number, "order_number": d.order_number, "client_name": d.client_name,
        "product_id": str(d.product_id), "sku": d.product_sku, "name": d.product_name, "quantity": _money(d.quantity), "currency_code": d.currency_code, "unit_price": _money(d.unit_price),
        "revenue": _money(d.revenue), "cogs": _money(d.cogs), "profit": _money(d.revenue - d.cogs) if d.status == "recognized" else None, "note": d.note, "delivered_at": d.delivered_at.isoformat(),
        "reconciled_by_email": d.reconciled_by_email, "reconciled_at": d.reconciled_at.isoformat() if d.reconciled_at else None,
    }


# =====================================================================================================
# The Finance page
# =====================================================================================================
@router.get("/summary", tags=["Finance page"])
def summary(period: Literal["1w", "1m", "1y"] = "1m", tenant: TenantContext = Tenant, db: Session = Depends(get_db), now: datetime = Depends(clock)):
    """Capital, Investment and Profit & Loss for a rolling period (1 Week, 1 Month or 1 Year), per currency, with the trend. Reading changes nothing."""
    ds = reporting.load(db, tenant.organization_id, trading.zone_of(tenant.timezone))
    return reporting.summary(ds, period, now, tenant.default_currency)


@router.get("/history", tags=["Finance page"])
def history(
    period: Literal["1w", "1m", "1y"] = "1m", category: Literal["all", "investments", "profitable_sales", "loss_sales", "expenses_adjustments", "reconciliation"] = "all",
    currency: Optional[str] = Query(default=None, min_length=3, max_length=3), limit: int = Query(default=25, ge=1, le=200), offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant, db: Session = Depends(get_db), now: datetime = Depends(clock),
):
    """The transactions behind the figures, newest first: investments, profitable and loss-making sales, expenses and adjustments, and deliveries needing reconciliation."""
    ds = reporting.load(db, tenant.organization_id, trading.zone_of(tenant.timezone))
    return reporting.history(ds, period, now, category=category, currency=currency.upper() if currency else None, limit=limit, offset=offset)


@router.get("/reconciliation", tags=["Finance page"])
def reconciliation(tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """The deliveries that have no recorded price or no reliable cost yet. They count in no profit figure until settled."""
    ds = reporting.load(db, tenant.organization_id, trading.zone_of(tenant.timezone))
    return {"items": reporting.reconciliation_list(ds)}


@router.get("/deliveries/{delivery_id}", tags=["Finance page"])
def get_delivery(delivery_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    row = db.scalar(scoped_select(TradeDelivery, tenant).where(TradeDelivery.id == delivery_id))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Delivery not found.")
    history_lines = [{"seq": h.seq, "action": h.action, "actor_email": h.actor_email, "source": h.source, "detail": h.detail, "created_at": h.created_at.isoformat()} for h in ledger.history(db, tenant.organization_id, row.id)]
    return {**delivery_out(row), "history": history_lines}


@router.post("/deliveries/{delivery_id}/reconcile", tags=["Finance page"])
def reconcile(delivery_id: uuid.UUID, payload: ReconcileBody, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Settle a delivery by hand (the price agreed with the client, and/or the actual unit cost). Final and audited."""
    try:
        row = capital.reconcile_delivery(db, tenant, Actor.of(tenant), delivery_id, payload)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except DBAPIError:
        db.rollback()
        raise conflict("rule_violation", "The rules of the books refused this change.")
    return delivery_out(row)


# =====================================================================================================
# Investment: owner contributions and withdrawals
# =====================================================================================================
@router.post("/investments", status_code=status.HTTP_201_CREATED, tags=["Finance page"])
def record_investment(payload: InvestmentCreate, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Record an owner contribution or withdrawal (cash, or an asset / stock given in kind at its valuation). A retry with the same Idempotency-Key answers 200 and records nothing."""
    actor = Actor.of(tenant)
    row = _created_once(db, tenant, key, "capital_record", payload, response, lambda: capital.record_capital(db, tenant, actor, payload),
                        lambda record_id: db.scalar(scoped_select(CapitalRecord, tenant).where(CapitalRecord.id == record_id)))
    return capital_out(row)


@router.post("/investments/{record_id}/reverse", status_code=status.HTTP_201_CREATED, tags=["Finance page"])
def reverse_investment(record_id: uuid.UUID, payload: InvestmentReverse, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Correct a mistaken record: a reversing record is added (the original stays, with who reversed it and why)."""
    try:
        row = capital.reverse_capital(db, tenant, Actor.of(tenant), record_id, payload)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except DBAPIError:
        db.rollback()
        raise conflict("already_reversed", "This record was already reversed.")
    db.refresh(row)
    return capital_out(row)


# =====================================================================================================
# The opening position
# =====================================================================================================
@router.get("/opening-positions", tags=["Finance page"])
def list_opening_positions(tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    rows = db.scalars(scoped_select(OpeningPosition, tenant).order_by(OpeningPosition.created_at.desc(), OpeningPosition.id))
    return {"items": [opening_out(o) for o in rows]}


@router.post("/opening-positions", status_code=status.HTTP_201_CREATED, tags=["Finance page"])
def set_opening_position(payload: OpeningCreate, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Set the financial position the organization starts from (what it owned and owed on a date, in one currency). The owner's equity is the difference."""
    actor = Actor.of(tenant)
    row = _created_once(db, tenant, key, "opening", payload, response, lambda: capital.set_opening(db, tenant, actor, payload),
                        lambda position_id: db.scalar(scoped_select(OpeningPosition, tenant).where(OpeningPosition.id == position_id)))
    return opening_out(row)


@router.post("/opening-positions/{position_id}/reverse", tags=["Finance page"])
def reverse_opening_position(position_id: uuid.UUID, payload: ReasonBody, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    try:
        row = capital.reverse_opening(db, tenant, Actor.of(tenant), position_id, payload)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    db.refresh(row)
    return opening_out(row)


# =====================================================================================================
# The cost of stock
# =====================================================================================================
@router.get("/inventory-costs", tags=["Finance page"])
def inventory_costs(tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """What the stock of each product, in each currency, cost (weighted average): the cost the next delivery takes its cost of goods sold from."""
    rows = db.scalars(select(InventoryCost).where(InventoryCost.organization_id == tenant.organization_id).order_by(InventoryCost.product_sku, InventoryCost.currency_code))
    return {"items": [
        {"product_id": str(r.product_id), "sku": r.product_sku, "name": r.product_name, "currency_code": r.currency_code, "quantity": _money(r.quantity), "total_value": _money(r.total_value),
         "average_cost": _money(trading.q4(r.total_value / r.quantity)) if r.quantity > 0 else None}
        for r in rows
    ]}


@router.post("/inventory-costs", status_code=status.HTTP_201_CREATED, tags=["Finance page"])
def record_inventory_cost(payload: BasisCreate, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Record what stock already held (opening stock, stock given in kind) cost per unit. It changes no capital figure; it is the cost basis later deliveries use."""
    actor = Actor.of(tenant)
    row = _created_once(db, tenant, key, "cost_basis", payload, response, lambda: capital.add_basis(db, tenant, actor, payload),
                        lambda entry_id: db.scalar(select(CostEntry).where(CostEntry.organization_id == tenant.organization_id, CostEntry.id == entry_id)))
    return cost_out(row)
