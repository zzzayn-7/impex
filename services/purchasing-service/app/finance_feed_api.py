"""The Purchasing Service's financial events, for the Finance Service. READ-ONLY.

The Finance Service recognizes a supplier obligation under ONE defined policy: **when a goods receipt is CONFIRMED** (the goods were physically
accepted and added to stock), at the value of what was accepted: accepted quantity x the purchase order line's unit price, in the order's currency.
Nothing is inferred from a purchase order alone (an order is a plan, not an obligation), and this service has no supplier invoice, so Finance
records the obligation as "goods received, not yet invoiced" - never as a payable to a bill that does not exist.

The Finance Service PULLS this feed with the shared secret MODULE_INTERNAL_API_KEY (no user is logged in when its background worker runs), so
Purchasing needs no outbox, no callback and no change to any record: this module only SELECTs.

  GET /internal/v1/organizations/{organization_id}/finance-feed?since=<ISO time>&limit=<1-1000>
  -> {"events": [{"key", "type", "time", "data"}], "has_more": bool}

  receipt.confirmed   key receipt-confirmed:<receipt id>   time = confirmed_at
    data: receipt id + number, purchase order id + number, supplier name, currency, confirmed_at,
          lines: [{"accepted_quantity", "unit_price"}]   (only lines with something accepted; exact decimal strings)

`key` is a stable, unique identifier of the fact; the consumer posts each fact exactly once however often the feed is read. Events with
time >= `since` are returned oldest first, so the consumer re-reads a short overlap and relies on the key to ignore what it already has.
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
from app.models import GoodsReceipt, GoodsReceiptLine, PurchaseOrder, PurchaseOrderLine, Supplier

router = APIRouter(include_in_schema=False)
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def require_internal_key(x_internal_key: Optional[str] = Header(default=None)) -> None:
    expected = os.getenv("MODULE_INTERNAL_API_KEY", "")
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Service authentication is not configured")
    if not x_internal_key or not hmac.compare_digest(x_internal_key.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid service credentials")


@router.get("/internal/v1/organizations/{organization_id}/finance-feed", dependencies=[Depends(require_internal_key)])
def finance_feed(organization_id: uuid.UUID, since: Optional[datetime] = None, limit: int = Query(default=500, ge=1, le=1000), db: Session = Depends(get_db)):
    since = (since if since and since.tzinfo else (since.replace(tzinfo=timezone.utc) if since else EPOCH))
    receipts = db.execute(
        select(GoodsReceipt, PurchaseOrder, Supplier)
        .join(PurchaseOrder, (PurchaseOrder.id == GoodsReceipt.purchase_order_id) & (PurchaseOrder.organization_id == GoodsReceipt.organization_id))
        .join(Supplier, (Supplier.id == PurchaseOrder.supplier_id) & (Supplier.organization_id == PurchaseOrder.organization_id))
        .where(GoodsReceipt.organization_id == organization_id, GoodsReceipt.status == "confirmed", GoodsReceipt.confirmed_at.is_not(None), GoodsReceipt.confirmed_at >= since)
        .order_by(GoodsReceipt.confirmed_at, GoodsReceipt.id).limit(limit + 1)
    ).all()
    events = []
    for receipt, order, supplier in receipts[:limit]:
        lines = db.execute(
            select(GoodsReceiptLine.accepted_quantity, PurchaseOrderLine.unit_price)
            .join(PurchaseOrderLine, (PurchaseOrderLine.id == GoodsReceiptLine.purchase_order_line_id) & (PurchaseOrderLine.organization_id == GoodsReceiptLine.organization_id))
            .where(GoodsReceiptLine.organization_id == organization_id, GoodsReceiptLine.goods_receipt_id == receipt.id, GoodsReceiptLine.accepted_quantity > 0)
            .order_by(GoodsReceiptLine.created_at, GoodsReceiptLine.id)
        ).all()
        events.append({"key": f"receipt-confirmed:{receipt.id}", "type": "receipt.confirmed", "time": receipt.confirmed_at.isoformat(), "data": {
            "receipt_id": str(receipt.id), "receipt_number": receipt.number, "purchase_order_id": str(order.id), "purchase_order_number": order.number, "supplier_name": supplier.name,
            "currency_code": order.currency_code, "confirmed_at": receipt.confirmed_at.isoformat(), "lines": [{"accepted_quantity": format(q, "f"), "unit_price": format(p, "f")} for q, p in lines]}})
    return {"events": events, "has_more": len(receipts) > limit}
