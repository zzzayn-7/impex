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

`key` is a stable, unique identifier of the fact: the consumer uses it to post each fact exactly once, however often the feed is read. Events with
time >= `since` are returned oldest first, so the consumer re-reads a short overlap each time (rows commit slightly after their own timestamp) and
relies on the key to ignore what it already has. Amounts are exact decimal strings; nothing is converted or summed.
"""
import hmac
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Invoice, InvoicePayment

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


@router.get("/internal/v1/organizations/{organization_id}/finance-feed", dependencies=[Depends(require_internal_key)])
def finance_feed(organization_id: uuid.UUID, since: Optional[datetime] = None, limit: int = Query(default=500, ge=1, le=1000), db: Session = Depends(get_db)):
    since = (since if since and since.tzinfo else (since.replace(tzinfo=timezone.utc) if since else EPOCH))
    events = []
    for inv in db.scalars(select(Invoice).where(Invoice.organization_id == organization_id, Invoice.issued_at.is_not(None), Invoice.issued_at >= since).order_by(Invoice.issued_at, Invoice.id).limit(limit)):
        events.append({"key": f"invoice-issued:{inv.id}", "type": "invoice.issued", "time": inv.issued_at.isoformat(), "data": {
            "invoice_id": str(inv.id), "number": inv.number, "currency_code": inv.currency_code, "issued_at": inv.issued_at.isoformat(), "subtotal": _money(inv.subtotal),
            "discount_total": _money(inv.discount_total), "tax_total": _money(inv.tax_total), "total": _money(inv.total), "client_name": inv.client_name}})
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
    events.sort(key=lambda e: (e["time"], e["key"]))
    return {"events": events[:limit], "has_more": len(events) > limit}
