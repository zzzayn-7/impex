"""The Sales Service's financial events, for the Finance Service. READ-ONLY.

The Finance Service posts accounting entries for issued invoices, payments and their corrections. It does so by PULLING this feed with the
shared secret MODULE_INTERNAL_API_KEY (no user is logged in when its background worker runs), so Sales needs no outbox, no callback and no change
to any record: this module only SELECTs. The contract is explicit and versioned by its shape:

  GET /internal/v1/organizations/{organization_id}/finance-feed?since=<ISO time>&limit=<1-1000>
  -> {"events": [{"key", "type", "time", "data"}], "has_more": bool}

  invoice.issued     key invoice-issued:<invoice id>   time = issued_at   data: invoice id, number, currency, issued_at, subtotal, discount_total, tax_total, total, client name
  invoice.voided     key invoice-voided:<invoice id>   time = voided_at   (only invoices that WERE issued; voiding a draft is not a financial event)
  payment.recorded   key payment-recorded:<payment id> time = created_at  data: payment id, invoice id + number + issued_at, currency, amount, method, payment_date
  payment.reversed   key payment-reversed:<payment id> time = created_at  (the reversal row; it names the payment it reverses)
  delivery.confirmed key delivery-confirmed:<dispatch id> time = confirmed_at   ONLY when asked for with `include_deliveries=true` (older consumers never see it)
    data: dispatch id + number, client name, delivery list + order number, order currency (null for lists made before prices were recorded), confirmed_at,
          lines: [{"dispatch_line_id", "product_id", "sku", "name", "unit", "quantity", "unit_price"}]   unit_price = the price of ONE unit agreed on the order
          (null when none was recorded: never zero)

invoice.issued also carries `allocations`: [{"dispatch_line_id", "dispatch_confirmed_at", "quantity", "net_amount"}] - which delivered goods the invoice bills and
what it bills for them, net of the line's discount and before tax (so Finance can tell a later discount from the value already recognised at delivery).

`key` is a stable, unique identifier of the fact: the consumer uses it to post each fact exactly once, however often the feed is read. Events with
time >= `since` are returned oldest first, so the consumer re-reads a short overlap each time (rows commit slightly after their own timestamp) and
relies on the key to ignore what it already has. Amounts are exact decimal strings; nothing is converted or summed.
"""
import hmac
import os
import uuid
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Client, DeliveryList, DeliveryListItem, Dispatch, DispatchLine, Invoice, InvoiceAllocation, InvoiceLine, InvoicePayment, SalesOrder

router = APIRouter(include_in_schema=False)
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def require_internal_key(x_internal_key: Optional[str] = Header(default=None)) -> None:
    expected = os.getenv("MODULE_INTERNAL_API_KEY", "")
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Service authentication is not configured")
    if not x_internal_key or not hmac.compare_digest(x_internal_key.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid service credentials")


def _money(value) -> str:
    return format(value, "f")


def _allocations(db: Session, organization_id: uuid.UUID, invoice_id: uuid.UUID) -> list:
    """The delivered goods an invoice bills, with what it bills for each (the line's net amount, pro rata to the quantity allocated)."""
    rows = db.execute(
        select(InvoiceAllocation, InvoiceLine, Dispatch)
        .join(InvoiceLine, (InvoiceLine.id == InvoiceAllocation.invoice_line_id) & (InvoiceLine.organization_id == InvoiceAllocation.organization_id))
        .join(DispatchLine, (DispatchLine.id == InvoiceAllocation.dispatch_line_id) & (DispatchLine.organization_id == InvoiceAllocation.organization_id))
        .join(Dispatch, (Dispatch.id == DispatchLine.dispatch_id) & (Dispatch.organization_id == DispatchLine.organization_id))
        .where(InvoiceAllocation.organization_id == organization_id, InvoiceAllocation.invoice_id == invoice_id)
        .order_by(InvoiceLine.position, InvoiceAllocation.created_at, InvoiceAllocation.id)
    ).all()
    out = []
    for allocation, line, dispatch in rows:
        net = (line.line_net * allocation.quantity / line.quantity).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        out.append({"dispatch_line_id": str(allocation.dispatch_line_id), "dispatch_confirmed_at": dispatch.confirmed_at.isoformat() if dispatch.confirmed_at else None,
                    "quantity": _money(allocation.quantity), "net_amount": _money(net)})
    return out


def _deliveries(db: Session, organization_id: uuid.UUID, since: datetime, limit: int) -> list:
    """Confirmed dispatches: goods that have LEFT stock for a client. This is the moment sales revenue is recognised."""
    dispatches = db.execute(
        select(Dispatch, DeliveryList, Client, SalesOrder)
        .join(DeliveryList, (DeliveryList.id == Dispatch.delivery_list_id) & (DeliveryList.organization_id == Dispatch.organization_id))
        .join(Client, (Client.id == Dispatch.client_id) & (Client.organization_id == Dispatch.organization_id))
        .outerjoin(SalesOrder, (SalesOrder.delivery_list_id == Dispatch.delivery_list_id) & (SalesOrder.organization_id == Dispatch.organization_id))
        .where(Dispatch.organization_id == organization_id, Dispatch.status == "confirmed", Dispatch.confirmed_at.is_not(None), Dispatch.confirmed_at >= since)
        .order_by(Dispatch.confirmed_at, Dispatch.id).limit(limit)
    ).all()
    events = []
    for dispatch, delivery_list, client, order in dispatches:
        lines = db.execute(
            select(DispatchLine, DeliveryListItem.unit_price)
            .join(DeliveryListItem, (DeliveryListItem.id == DispatchLine.delivery_list_item_id) & (DeliveryListItem.organization_id == DispatchLine.organization_id))
            .where(DispatchLine.organization_id == organization_id, DispatchLine.dispatch_id == dispatch.id).order_by(DispatchLine.created_at, DispatchLine.id)
        ).all()
        currency = order.currency_code if order is not None else None
        events.append({"key": f"delivery-confirmed:{dispatch.id}", "type": "delivery.confirmed", "time": dispatch.confirmed_at.isoformat(), "data": {
            "dispatch_id": str(dispatch.id), "dispatch_number": dispatch.number, "client_name": client.name, "delivery_list_id": str(delivery_list.id), "delivery_list_number": delivery_list.number,
            "order_id": str(order.id) if order is not None else None, "order_number": order.number if order is not None else None, "currency_code": currency,
            "confirmed_at": dispatch.confirmed_at.isoformat(),
            "lines": [{"dispatch_line_id": str(line.id), "product_id": str(line.product_id), "sku": line.product_sku, "name": line.product_name, "unit": line.unit,
                       "quantity": _money(line.quantity), "unit_price": _money(price) if price is not None and currency else None} for line, price in lines]}})
    return events


@router.get("/internal/v1/organizations/{organization_id}/finance-feed", dependencies=[Depends(require_internal_key)])
def finance_feed(organization_id: uuid.UUID, since: Optional[datetime] = None, limit: int = Query(default=500, ge=1, le=1000), include_deliveries: bool = False, db: Session = Depends(get_db)):
    since = (since if since and since.tzinfo else (since.replace(tzinfo=timezone.utc) if since else EPOCH))
    events = []
    for inv in db.scalars(select(Invoice).where(Invoice.organization_id == organization_id, Invoice.issued_at.is_not(None), Invoice.issued_at >= since).order_by(Invoice.issued_at, Invoice.id).limit(limit)):
        events.append({"key": f"invoice-issued:{inv.id}", "type": "invoice.issued", "time": inv.issued_at.isoformat(), "data": {
            "invoice_id": str(inv.id), "number": inv.number, "currency_code": inv.currency_code, "issued_at": inv.issued_at.isoformat(), "subtotal": _money(inv.subtotal),
            "discount_total": _money(inv.discount_total), "tax_total": _money(inv.tax_total), "total": _money(inv.total), "client_name": inv.client_name,
            "allocations": _allocations(db, organization_id, inv.id)}})
    for inv in db.scalars(select(Invoice).where(Invoice.organization_id == organization_id, Invoice.voided_at.is_not(None), Invoice.issued_at.is_not(None), Invoice.voided_at >= since).order_by(Invoice.voided_at, Invoice.id).limit(limit)):
        events.append({"key": f"invoice-voided:{inv.id}", "type": "invoice.voided", "time": inv.voided_at.isoformat(), "data": {
            "invoice_id": str(inv.id), "number": inv.number, "currency_code": inv.currency_code, "issued_at": inv.issued_at.isoformat(), "voided_at": inv.voided_at.isoformat(), "total": _money(inv.total)}})
    payments = db.execute(
        select(InvoicePayment, Invoice).join(Invoice, (Invoice.id == InvoicePayment.invoice_id) & (Invoice.organization_id == InvoicePayment.organization_id))
        .where(InvoicePayment.organization_id == organization_id, InvoicePayment.created_at >= since).order_by(InvoicePayment.created_at, InvoicePayment.id).limit(limit)
    ).all()
    for payment, inv in payments:
        reversal = payment.kind == "reversal"
        data = {"payment_id": str(payment.id), "invoice_id": str(inv.id), "invoice_number": inv.number, "invoice_issued_at": inv.issued_at.isoformat() if inv.issued_at else None,
                "currency_code": payment.currency_code, "amount": _money(payment.amount), "method": payment.method, "payment_date": payment.payment_date.isoformat()}
        if reversal:
            data["reverses_payment_id"] = str(payment.reverses_payment_id) if payment.reverses_payment_id else None
        events.append({"key": f"{'payment-reversed' if reversal else 'payment-recorded'}:{payment.id}", "type": "payment.reversed" if reversal else "payment.recorded", "time": payment.created_at.isoformat(), "data": data})
    if include_deliveries:
        events.extend(_deliveries(db, organization_id, since, limit))
    events.sort(key=lambda e: (e["time"], e["key"]))
    return {"events": events[:limit], "has_more": len(events) > limit}
