"""Reading the reporting model: Capital, Investment and Profit & Loss for a period, the transaction history and the trend.

THE DEFINITIONS (the page shows exactly these; docs/finance.md repeats them):

  Investment (total)   what the owner has put in and left in, as of a moment: opening-position equity + owner contributions - owner withdrawals.
                       Buying stock is NOT here: it is an investment ACTIVITY (a change in the form of the money), shown beside it.
  Profit & Loss        gross trading profit of deliveries (revenue - actual cost of goods sold) + invoice adjustments - expenses, over the period.
                       Deliveries that need a price or a cost reconciliation are NOT in it: they are counted and listed instead.
  Capital              Investment + the net profit accumulated since the opening position (or since the beginning when there is none).
                       So: contributing 5,000,000 and buying stock with it leaves Capital at 5,000,000; delivering part of it at a profit raises it by exactly that profit.
  Period               1 Day / 1 Week / 1 Month / 6 Months / 1 Year ROLLING, ending now, measured in the organization's time zone. Capital and Investment are balances AS OF the end of the
                       period compared with the same balance at its start; Profit & Loss is what happened DURING it.
  Change               ((closing - opening) / |opening|) x 100. A zero opening is "New" (with the absolute change) - never a percentage of zero. Never infinity.

Everything is computed PER CURRENCY. Different currencies are never added together or converted: when records exist in more than one currency each is reported on its own and a
combined figure is declared unavailable. Capital is shown only when it can be established (an opening position or an owner contribution exists in that currency); otherwise
the response says a setup is required - no starting balance is ever invented.
"""
import calendar
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import CapitalRecord, CostEntry, Expense, JournalEntry, OpeningPosition, TradeAdjustment, TradeDelivery
from app.trading import ZERO, q4, start_of_day

PERIODS = {"1d": "1 Day", "1w": "1 Week", "1m": "1 Month", "6m": "6 Months", "1y": "1 Year"}
TREND_STEPS = {"1d": 24, "1w": 7, "1m": 30, "6m": 26, "1y": 12}
CATEGORIES = ("all", "investments", "profitable_sales", "loss_sales", "expenses_adjustments", "reconciliation")


# --- periods ----------------------------------------------------------------------------------------------------------------------------
def _minus_months(moment: datetime, months: int) -> datetime:
    total = moment.year * 12 + (moment.month - 1) - months
    year, month = divmod(total, 12)
    month += 1
    return moment.replace(year=year, month=month, day=min(moment.day, calendar.monthrange(year, month)[1]))


def period_bounds(key: str, now: datetime, zone: ZoneInfo) -> Tuple[datetime, datetime]:
    """The rolling period ending at `now`: 1 day = 24 hours back, 1 week = 7 days back, 1 / 6 / 12 months = the same moment that many calendar months earlier, in the organization's time zone."""
    local = now.astimezone(zone)
    start = {"1d": lambda: local - timedelta(days=1), "1w": lambda: local - timedelta(days=7), "1m": lambda: _minus_months(local, 1), "6m": lambda: _minus_months(local, 6), "1y": lambda: _minus_months(local, 12)}[key]()
    return start.astimezone(timezone.utc), now.astimezone(timezone.utc)


def _money(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    exact = q4(value)
    return format(abs(exact) if exact == 0 else exact, "f")  # never "-0.0000"


def change(opening: Decimal, closing: Decimal) -> dict:
    """The change between two balances: the absolute amount, and a percentage that is only given when there is something to compare with."""
    absolute = closing - opening
    pct: Optional[Decimal] = None
    state = "value"
    if opening == 0:
        if closing != 0:
            state = "new"  # a zero baseline: shown as "New" with the absolute change, never as a percentage of zero
        else:
            pct = Decimal("0.0")
    else:
        pct = (absolute / abs(opening) * 100).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
        if pct == 0:
            pct = Decimal("0.0")
    return {"absolute": _money(absolute), "percent": None if pct is None else format(pct, "f"), "state": state, "direction": "up" if absolute > 0 else "down" if absolute < 0 else "flat"}


# --- loading ----------------------------------------------------------------------------------------------------------------------------
@dataclass
class Dataset:
    zone: ZoneInfo
    capital: List[CapitalRecord] = field(default_factory=list)
    openings: List[OpeningPosition] = field(default_factory=list)  # the ACTIVE ones
    deliveries: List[TradeDelivery] = field(default_factory=list)
    adjustments: List[TradeAdjustment] = field(default_factory=list)
    expenses: List[Tuple[Expense, Optional[date]]] = field(default_factory=list)  # (expense, the date of its reversal)
    receipts: List[CostEntry] = field(default_factory=list)
    basis: List[CostEntry] = field(default_factory=list)
    _days: Dict[date, datetime] = field(default_factory=dict)

    def at(self, day: date) -> datetime:
        if day not in self._days:
            self._days[day] = start_of_day(day, self.zone)
        return self._days[day]


def load(db: Session, organization_id, zone: ZoneInfo) -> Dataset:
    ds = Dataset(zone=zone)
    ds.capital = list(db.scalars(select(CapitalRecord).where(CapitalRecord.organization_id == organization_id).order_by(CapitalRecord.effective_date, CapitalRecord.created_at, CapitalRecord.id)))
    ds.openings = list(db.scalars(select(OpeningPosition).where(OpeningPosition.organization_id == organization_id, OpeningPosition.status == "active")))
    ds.deliveries = list(db.scalars(select(TradeDelivery).where(TradeDelivery.organization_id == organization_id).order_by(TradeDelivery.delivered_at, TradeDelivery.id)))
    ds.adjustments = list(db.scalars(select(TradeAdjustment).where(TradeAdjustment.organization_id == organization_id).order_by(TradeAdjustment.effective_at, TradeAdjustment.id)))
    rows = db.execute(
        select(Expense, JournalEntry.entry_date)
        .outerjoin(JournalEntry, (JournalEntry.organization_id == Expense.organization_id) & (JournalEntry.id == Expense.reversal_entry_id))
        .where(Expense.organization_id == organization_id, Expense.status.in_(("posted", "reversed"))).order_by(Expense.expense_date, Expense.id)
    ).all()
    ds.expenses = [(expense, reversal_date) for expense, reversal_date in rows]
    entries = db.scalars(select(CostEntry).where(CostEntry.organization_id == organization_id, CostEntry.kind.in_(("receipt", "basis"))).order_by(CostEntry.effective_at, CostEntry.id))
    for entry in entries:
        (ds.receipts if entry.kind == "receipt" else ds.basis).append(entry)
    return ds


def currencies(ds: Dataset) -> List[str]:
    found = set()
    found.update(r.currency_code for r in ds.capital)
    found.update(o.currency_code for o in ds.openings)
    found.update(d.currency_code for d in ds.deliveries if d.currency_code and d.status != "needs_price")
    found.update(a.currency_code for a in ds.adjustments)
    found.update(e.currency_code for e, _ in ds.expenses)
    found.update(r.currency_code for r in ds.receipts)
    return sorted(found)


# --- the balances -----------------------------------------------------------------------------------------------------------------------
def _opening(ds: Dataset, currency: str) -> Optional[OpeningPosition]:
    return next((o for o in ds.openings if o.currency_code == currency), None)


def profit_items(ds: Dataset, currency: str) -> List[Tuple[datetime, str, Decimal]]:
    """Every dated effect on profit in one currency: (when, what, signed amount). Only RECOGNISED deliveries, the adjustments of recognised deliveries, and expenses."""
    status = {d.id: d.status for d in ds.deliveries}
    items: List[Tuple[datetime, str, Decimal]] = []
    for d in ds.deliveries:
        if d.status == "recognized" and d.currency_code == currency:
            items.append((d.delivered_at, "gross", d.revenue - d.cogs))
    for a in ds.adjustments:
        if a.currency_code == currency and status.get(a.delivery_id) == "recognized":
            items.append((a.effective_at, "adjustment", a.amount))
    for e, reversal_date in ds.expenses:
        if e.currency_code != currency:
            continue
        items.append((ds.at(e.expense_date), "expense", -e.amount))
        if e.status == "reversed" and reversal_date is not None:
            items.append((ds.at(reversal_date), "expense", e.amount))
    return items


def investment_at(ds: Dataset, currency: str, moment: datetime) -> Decimal:
    total = ZERO
    opening = _opening(ds, currency)
    if opening is not None and ds.at(opening.effective_date) <= moment:
        total += opening.equity
    for r in ds.capital:
        if r.currency_code == currency and ds.at(r.effective_date) <= moment:
            total += r.effect
    return total


def capital_at(ds: Dataset, currency: str, moment: datetime, items: Optional[list] = None) -> Decimal:
    """Investment as of `moment` + the profit accumulated from the opening position (or from the beginning) up to it."""
    opening = _opening(ds, currency)
    floor = ds.at(opening.effective_date) if opening is not None else None
    total = investment_at(ds, currency, moment)
    for at, _kind, amount in (items if items is not None else profit_items(ds, currency)):
        if at <= moment and (floor is None or at >= floor):
            total += amount
    return total


def capital_basis(ds: Dataset, currency: str) -> Optional[str]:
    """How capital in this currency can be established: from an opening position, or from owner contributions alone - or not at all (None: a setup is required)."""
    if _opening(ds, currency) is not None:
        return "opening_position"
    if any(r.currency_code == currency for r in ds.capital):
        return "owner_records"
    return None


# --- the summary ------------------------------------------------------------------------------------------------------------------------
def _in(at: datetime, start: datetime, end: datetime) -> bool:
    return start < at <= end


def summary(ds: Dataset, period: str, now: datetime, default_currency: str) -> dict:
    start, end = period_bounds(period, now, ds.zone)
    found = currencies(ds)
    ordered = sorted(found, key=lambda c: (c != default_currency, c))
    needs = {"needs_cost": 0, "needs_price": 0}
    for d in ds.deliveries:
        if d.status in needs:
            needs[d.status] += 1
    by_currency = {}
    for currency in ordered:
        items = profit_items(ds, currency)
        basis = capital_basis(ds, currency)
        in_period = [(k, a) for at, k, a in items if _in(at, start, end)]
        gross = sum((a for k, a in in_period if k == "gross"), ZERO)
        adjustments = sum((a for k, a in in_period if k == "adjustment"), ZERO)
        expenses = -sum((a for k, a in in_period if k == "expense"), ZERO)
        revenue = sum((d.revenue for d in ds.deliveries if d.status == "recognized" and d.currency_code == currency and _in(d.delivered_at, start, end)), ZERO)
        cogs = sum((d.cogs for d in ds.deliveries if d.status == "recognized" and d.currency_code == currency and _in(d.delivered_at, start, end)), ZERO)
        pending = [d for d in ds.deliveries if d.status == "needs_cost" and d.currency_code == currency and _in(d.delivered_at, start, end)]
        contributions = sum((r.effect for r in ds.capital if r.currency_code == currency and r.kind == "contribution" and _in(ds.at(r.effective_date), start, end)), ZERO)
        withdrawals = -sum((r.effect for r in ds.capital if r.currency_code == currency and r.kind == "withdrawal" and _in(ds.at(r.effective_date), start, end)), ZERO)
        purchases = sum((e.value for e in ds.receipts if e.currency_code == currency and _in(e.effective_at, start, end)), ZERO)
        invest_open, invest_close = investment_at(ds, currency, start), investment_at(ds, currency, end)
        net = gross + adjustments - expenses
        block = {
            "currency_code": currency,
            "capital": {"ready": basis is not None, "basis": basis},
            "investment": {
                "closing": _money(invest_close), "opening": _money(invest_open), "change": change(invest_open, invest_close), "contributions": _money(contributions),
                "withdrawals": _money(withdrawals), "net_invested": _money(contributions - withdrawals), "inventory_purchases": _money(purchases),
            },
            "profit_loss": {
                "net": _money(net), "gross_profit": _money(gross), "revenue": _money(revenue), "cost_of_goods_sold": _money(cogs), "expenses": _money(expenses), "adjustments": _money(adjustments),
                "needs_cost_count": len(pending), "needs_cost_revenue": _money(sum((d.revenue for d in pending), ZERO)),
            },
            "trend": [],
        }
        if basis is not None:
            cap_open, cap_close = capital_at(ds, currency, start, items), capital_at(ds, currency, end, items)
            block["capital"].update(closing=_money(cap_close), opening=_money(cap_open), change=change(cap_open, cap_close))
            steps = TREND_STEPS[period]
            span = (end - start) / steps
            block["trend"] = [{"at": (start + span * i).isoformat(), "capital": _money(capital_at(ds, currency, start + span * i, items))} for i in range(steps + 1)]
        by_currency[currency] = block
    missing = [c for c in ordered if capital_basis(ds, c) is None]
    combined = len(ordered) <= 1
    if not ordered:
        message = "Capital cannot be calculated yet. Set up your opening position or record an owner contribution - no starting balance is assumed."
    elif missing:
        message = f"Capital cannot be calculated in {', '.join(missing)} yet: set up the opening position or record an owner contribution in that currency."
    else:
        message = None
    return {
        "period": {"key": period, "label": PERIODS[period], "start": start.isoformat(), "end": end.isoformat(), "timezone": str(ds.zone)},
        "default_currency": default_currency, "currencies": ordered, "combined_available": combined,
        "combined_note": None if combined else "Records exist in more than one currency and Impex holds no exchange rates, so each currency is reported on its own and a combined figure is not available.",
        "setup_required": bool(missing) or not ordered, "setup_message": message, "has_opening_position": bool(ds.openings),
        "reconciliation": {**needs, "total": needs["needs_cost"] + needs["needs_price"]}, "by_currency": by_currency,
    }


# --- the history ------------------------------------------------------------------------------------------------------------------------
def _row(**fields) -> dict:
    base = {"counterparty": None, "profit_loss": None, "status": None, "reference": None, "notes": None, "source_type": None, "source_id": None, "affects_capital": False, "can_reverse": False,
            "delivery_id": None, "direction": None}
    base.update(fields)
    return base


def _rows(ds: Dataset) -> List[dict]:
    rows: List[dict] = []
    reversed_ids = {r.reverses_id for r in ds.capital if r.reverses_id is not None}
    for r in ds.capital:
        label = ("Owner contribution" if r.kind == "contribution" else "Owner withdrawal") + (" reversed" if r.is_reversal else "")
        rows.append(_row(
            id=f"capital:{r.id}", kind=f"owner_{r.kind}{'_reversal' if r.is_reversal else ''}", category="investments", at=ds.at(r.effective_date), description=r.description, transaction=label,
            amount=_money(r.effect), currency_code=r.currency_code, reference=r.reference, notes=r.reversal_reason if r.is_reversal else r.notes, source_type="capital_record", source_id=str(r.id),
            affects_capital=True, can_reverse=not r.is_reversal and r.id not in reversed_ids, direction="in" if r.effect > 0 else "out", entry_type=r.entry_type,
        ))
    for o in ds.openings:
        rows.append(_row(
            id=f"opening:{o.id}", kind="opening_position", category="investments", at=ds.at(o.effective_date), description=f"Opening position: assets {_money(o.assets)}, liabilities {_money(o.liabilities)}",
            transaction="Opening capital", amount=_money(o.equity), currency_code=o.currency_code, notes=o.notes, source_type="opening", source_id=str(o.id), affects_capital=True,
            direction="in" if o.equity >= 0 else "out",
        ))
    for e in ds.receipts:
        rows.append(_row(
            id=f"cost:{e.id}", kind="inventory_purchase", category="investments", at=e.effective_at, description=f"{format(e.quantity, 'f')} x {e.product_name} bought", counterparty=e.counterparty,
            transaction="Inventory purchase", amount=_money(e.value), currency_code=e.currency_code, reference=e.reference, notes=f"Purchase order {e.detail}" if e.detail else None,
            source_type="goods_receipt", source_id=str(e.link_id) if e.link_id else None, direction="exchange",
        ))
    for e in ds.basis:
        rows.append(_row(
            id=f"cost:{e.id}", kind="inventory_cost_basis", category="investments", at=e.effective_at, description=f"Cost of {format(e.quantity, 'f')} x {e.product_name} already in stock",
            transaction="Stock cost recorded", amount=_money(e.value), currency_code=e.currency_code, notes=e.detail, source_type="cost_basis", source_id=str(e.id), direction="exchange",
        ))
    for d in ds.deliveries:
        what = f"{format(d.quantity.normalize(), 'f')} x {d.product_name}" + (f" - {d.order_number}" if d.order_number else f" - {d.dispatch_number}")
        profit = d.revenue - d.cogs if d.status == "recognized" else None
        category = "reconciliation" if d.status != "recognized" else ("profitable_sales" if profit >= 0 else "loss_sales")
        label = {"recognized": "Sale delivered", "needs_cost": "Sale delivered - needs cost reconciliation", "needs_price": "Sale delivered - needs price reconciliation"}[d.status]
        rows.append(_row(
            id=f"delivery:{d.id}", kind="sale", category=category, at=d.delivered_at, description=what, counterparty=d.client_name, transaction=label, amount=_money(d.revenue),
            profit_loss=_money(profit), currency_code=d.currency_code, status=d.status, reference=d.dispatch_number, notes=d.note, source_type="dispatch", source_id=str(d.dispatch_id),
            delivery_id=str(d.id), affects_capital=d.status == "recognized", cogs=_money(d.cogs), unit_price=_money(d.unit_price),
        ))
    names = {d.id: d for d in ds.deliveries}
    for a in ds.adjustments:
        delivery = names.get(a.delivery_id)
        counted = delivery is not None and delivery.status == "recognized"
        rows.append(_row(
            id=f"adjustment:{a.id}", kind="invoice_adjustment", category="expenses_adjustments", at=a.effective_at, description=a.description, counterparty=delivery.client_name if delivery else None,
            transaction="Invoice adjustment reversed" if a.reverses_id else "Invoice adjustment", amount=_money(abs(a.amount)), profit_loss=_money(a.amount) if counted else None, currency_code=a.currency_code,
            reference=a.reference, source_type="invoice", source_id=str(a.invoice_id), affects_capital=counted,
        ))
    for e, reversal_date in ds.expenses:
        rows.append(_row(
            id=f"expense:{e.id}", kind="expense", category="expenses_adjustments", at=ds.at(e.expense_date), description=e.description, counterparty=e.vendor, transaction="Expense", amount=_money(e.amount),
            profit_loss=_money(-e.amount), currency_code=e.currency_code, reference=e.number, source_type="expense", source_id=str(e.id), affects_capital=True,
        ))
        if e.status == "reversed" and reversal_date is not None:
            rows.append(_row(
                id=f"expense-reversal:{e.id}", kind="expense_reversal", category="expenses_adjustments", at=ds.at(reversal_date), description=f"Reversal of: {e.description}", counterparty=e.vendor,
                transaction="Expense reversed", amount=_money(e.amount), profit_loss=_money(e.amount), currency_code=e.currency_code, reference=e.number, notes=e.reversal_reason, source_type="expense",
                source_id=str(e.id), affects_capital=True,
            ))
    return rows


def history(ds: Dataset, period: str, now: datetime, *, category: str = "all", currency: Optional[str] = None, limit: int = 25, offset: int = 0) -> dict:
    start, end = period_bounds(period, now, ds.zone)
    rows = [r for r in _rows(ds) if _in(r["at"], start, end) and (category == "all" or r["category"] == category) and (currency is None or r["currency_code"] == currency or r["currency_code"] is None)]
    rows.sort(key=lambda r: (r["at"], r["id"]), reverse=True)
    page = rows[offset:offset + limit]
    for r in page:
        r["occurred_at"] = r.pop("at").isoformat()
    return {"items": page, "total": len(rows), "limit": limit, "offset": offset, "period": {"key": period, "label": PERIODS[period], "start": start.isoformat(), "end": end.isoformat()}}


def reconciliation_list(ds: Dataset) -> List[dict]:
    """Every delivery that still needs a price or a cost, oldest first."""
    return [
        {"delivery_id": str(d.id), "status": d.status, "delivered_at": d.delivered_at.isoformat(), "dispatch_number": d.dispatch_number, "order_number": d.order_number, "client_name": d.client_name,
         "product_id": str(d.product_id), "sku": d.product_sku, "name": d.product_name, "quantity": _money(d.quantity), "currency_code": d.currency_code, "unit_price": _money(d.unit_price),
         "revenue": _money(d.revenue), "note": d.note}
        for d in ds.deliveries if d.status != "recognized"
    ]


# --- the profit & loss trend (the diverging bar chart) ----------------------------------------------------------------------------------------------
GRANULARITY = {"1d": "hour", "1w": "day", "1m": "week", "6m": "month", "1y": "month"}


def bucket_edges(period: str, start: datetime, end: datetime, zone: ZoneInfo) -> List[datetime]:
    """The consecutive buckets of the period, as edges (the first is `start`, the last is `end`): 1 Day = hours, 1 Week = days, 1 Month = consecutive 7-day weeks from
    the start with a shorter final one, 6 Months / 1 Year = calendar months. Days, weeks and months are counted on the organization's local calendar."""
    local_start = start.astimezone(zone)
    edges = [start]
    index = 1
    while True:
        if period == "1d":
            nxt = start + timedelta(hours=index)
        elif period == "1w":
            nxt = (local_start + timedelta(days=index)).astimezone(timezone.utc)
        elif period == "1m":
            nxt = (local_start + timedelta(days=7 * index)).astimezone(timezone.utc)
        else:
            nxt = _minus_months(local_start, -index).astimezone(timezone.utc)
        if nxt >= end:
            edges.append(end)
            return edges
        edges.append(nxt)
        index += 1


def pnl_events(ds: Dataset, currency: str) -> List[Tuple[datetime, str, Decimal]]:
    """Every dated effect on net profit in one currency, split into its parts: revenue and cost of goods sold of RECOGNISED deliveries, expenses (a reversal is negative) and the
    signed adjustments of recognised deliveries. Net profit = revenue - cost of goods sold - expenses + adjustments (the same figures profit_items() adds up)."""
    status = {d.id: d.status for d in ds.deliveries}
    events: List[Tuple[datetime, str, Decimal]] = []
    for d in ds.deliveries:
        if d.status == "recognized" and d.currency_code == currency:
            events.append((d.delivered_at, "revenue", d.revenue))
            events.append((d.delivered_at, "cogs", d.cogs))
    for a in ds.adjustments:
        if a.currency_code == currency and status.get(a.delivery_id) == "recognized":
            events.append((a.effective_at, "adjustment", a.amount))
    for e, reversal_date in ds.expenses:
        if e.currency_code != currency:
            continue
        events.append((ds.at(e.expense_date), "expense", e.amount))
        if e.status == "reversed" and reversal_date is not None:
            events.append((ds.at(reversal_date), "expense", -e.amount))
    return events


def pnl_trend(ds: Dataset, period: str, now: datetime, default_currency: str) -> dict:
    """Net profit or loss per bucket of the period, per currency, from the SAME recognised facts as the summary (so the buckets add up to its Profit & Loss exactly).
    A bucket with no activity is reported as such (never a profit or a loss); deliveries that need a price or a cost are counted, not valued."""
    start, end = period_bounds(period, now, ds.zone)
    edges = bucket_edges(period, start, end, ds.zone)
    ordered = sorted(currencies(ds), key=lambda c: (c != default_currency, c))
    by_currency = {}
    for currency in ordered:
        events = pnl_events(ds, currency)
        pending = [d for d in ds.deliveries if d.status == "needs_cost" and d.currency_code == currency and _in(d.delivered_at, start, end)]
        buckets = []
        for lo, hi in zip(edges, edges[1:]):
            parts = {"revenue": ZERO, "cogs": ZERO, "expense": ZERO, "adjustment": ZERO}
            active = False
            for at, kind, amount in events:
                if lo < at <= hi:
                    parts[kind] += amount
                    active = True
            net = parts["revenue"] - parts["cogs"] - parts["expense"] + parts["adjustment"]
            buckets.append({
                "start": lo.isoformat(), "end": hi.isoformat(), "revenue": _money(parts["revenue"]), "cost_of_goods_sold": _money(parts["cogs"]), "expenses": _money(parts["expense"]),
                "adjustments": _money(parts["adjustment"]), "other_costs": _money(parts["expense"] - parts["adjustment"]), "net": _money(net), "has_activity": active,
                "needs_cost_count": sum(1 for d in pending if lo < d.delivered_at <= hi), "_net": net,
            })
        total = sum((b["_net"] for b in buckets), ZERO)
        for b in buckets:
            del b["_net"]
        nets = [D_(b["net"]) for b in buckets]
        by_currency[currency] = {
            "currency_code": currency, "buckets": buckets,
            "totals": {"net": _money(total), "profitable_periods": sum(1 for b, n in zip(buckets, nets) if b["has_activity"] and n > 0), "loss_periods": sum(1 for b, n in zip(buckets, nets) if b["has_activity"] and n < 0),
                       "has_activity": any(b["has_activity"] for b in buckets), "needs_cost_count": len(pending)},
        }
    missing_price = sum(1 for d in ds.deliveries if d.status == "needs_price" and _in(d.delivered_at, start, end))
    return {
        "period": {"key": period, "label": PERIODS[period], "start": start.isoformat(), "end": end.isoformat(), "timezone": str(ds.zone)}, "granularity": GRANULARITY[period],
        "default_currency": default_currency, "currencies": ordered, "combined_available": len(ordered) <= 1, "by_currency": by_currency,
        "incomplete": {"needs_price": missing_price, "needs_cost": sum(c["totals"]["needs_cost_count"] for c in by_currency.values())},
    }


def D_(value: str) -> Decimal:
    return Decimal(value)
