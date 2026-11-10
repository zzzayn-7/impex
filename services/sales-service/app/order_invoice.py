"""Generate Invoice from a dispatched sales order: one click on the Delivery Lists card makes a DRAFT invoice and saves it.

What goes on the invoice (nothing is invented):
  * the CLIENT, and the CONFIRMED dispatch lines of the order's delivery list: product, SKU, name, unit and the dispatched quantity are the
    dispatch's own (never typed, never from the caller);
  * the unit price is the product's CURRENT selling price in the catalog (the same price the order's "Cost" on the Delivery Lists card shows),
    read from the Inventory Service with the caller's own token; the invoice currency is the products' currency. If a product has no price or the
    products use different currencies, NOTHING is made: no price is guessed and no currency is converted - the message says what to fix, and the
    invoice can still be made by hand on the Sales Invoice page;
  * discount and tax are zero. Both can be set on the draft before it is issued.

It is only a DRAFT: no number is used and no stock, payment or Finance record is touched (see app/invoicing.py). Repeating the click never makes
a second invoice for the same goods: while an invoice (a draft, or an issued one) already covers the order's dispatched goods, THAT invoice is
returned. A voided invoice does not count, so voiding a mistaken one lets the order be invoiced again. The order row is locked for the whole
operation, so two simultaneous clicks make one invoice.
"""
import uuid
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_
from sqlalchemy.orm import Session

from app import invoicing
from app.auth import TenantContext
from app.inventory import InventoryGateway, InventoryUnavailable
from app.models import Invoice, InvoiceAllocation
from app.orders import get_order_or_404
from app.schemas import InvoiceCreate, InvoiceDetail, InvoiceLineInput
from app.tenancy import scoped_select

PRICE = Decimal("0.0001")


def _refuse(http: int, code: str, message: str) -> HTTPException:
    return HTTPException(http, {"code": code, "message": message})


def _existing(db: Session, tenant: TenantContext, dispatch_line_ids: list) -> Optional[Invoice]:
    """The newest invoice (not voided) that bills any of these dispatched lines."""
    return db.scalar(
        scoped_select(Invoice, tenant)
        .join(InvoiceAllocation, and_(InvoiceAllocation.organization_id == Invoice.organization_id, InvoiceAllocation.invoice_id == Invoice.id))
        .where(InvoiceAllocation.dispatch_line_id.in_(dispatch_line_ids), Invoice.status != "void")
        .order_by(Invoice.created_at.desc(), Invoice.id)
        .limit(1)
    )


def generate(db: Session, tenant: TenantContext, gateway: InventoryGateway, order_id: uuid.UUID) -> Tuple[InvoiceDetail, bool]:
    """(the invoice, created): created is False when the order already had one and that one is returned."""
    order = get_order_or_404(db, tenant, order_id, lock=True)  # another organization's order is a 404; one generation at a time per order

    lines = invoicing.billable_lines(db, tenant, order.client_id, order.delivery_list_id)
    if not lines:
        db.rollback()
        raise _refuse(status.HTTP_409_CONFLICT, "not_dispatched", "Nothing has been dispatched for this order yet, so there is nothing to invoice.")

    existing = _existing(db, tenant, [l.dispatch_line_id for l in lines])
    if existing is not None:
        result = invoicing.detail(db, tenant, existing)
        db.rollback()  # nothing was changed: release the order lock
        return result, False

    to_bill = [l for l in lines if l.remaining_quantity > 0]
    if not to_bill:
        db.rollback()
        raise _refuse(status.HTTP_409_CONFLICT, "nothing_to_invoice", "Everything dispatched for this order is already invoiced.")

    try:
        prices = gateway.products({l.product_id for l in to_bill})
    except InventoryUnavailable:
        db.rollback()
        raise _refuse(status.HTTP_503_SERVICE_UNAVAILABLE, "prices_unavailable", "The product prices could not be read just now, so the invoice was not made. Please try again in a moment.")
    except HTTPException:
        db.rollback()
        raise

    unpriced = sorted({l.product_name for l in to_bill if prices.get(l.product_id) is None or prices[l.product_id].selling_price is None or not prices[l.product_id].currency_code})
    if unpriced:
        db.rollback()
        names = ", ".join(unpriced)
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "price_missing", f"No selling price is set for {names}. Set it in Stock, or create this invoice by hand on the Sales Invoice page.")
    currencies = {prices[l.product_id].currency_code for l in to_bill}
    if len(currencies) != 1:
        db.rollback()
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "mixed_currencies", f"The products of this order are priced in different currencies ({', '.join(sorted(currencies))}), and nothing is converted. Create the invoice by hand on the Sales Invoice page.")

    payload = InvoiceCreate(
        client_id=order.client_id,
        currency_code=currencies.pop(),
        notes=f"Generated from sales order {order.number} (delivery list {to_bill[0].delivery_list.number}).",
        lines=[
            InvoiceLineInput(
                dispatch_line_id=l.dispatch_line_id, quantity=l.remaining_quantity,
                unit_price=prices[l.product_id].selling_price.quantize(PRICE, rounding=ROUND_HALF_UP),
            )
            for l in to_bill
        ],
    )
    invoice, _ = invoicing.create_invoice(db, tenant, payload, f"order-invoice:{order.id}:{uuid.uuid4().hex}")  # commits (and so releases the order lock)
    return invoicing.detail(db, tenant, invoice), True
