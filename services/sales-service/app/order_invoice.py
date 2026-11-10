"""Generate Invoice from a dispatched sales order: one click on the Delivery Lists card makes a DRAFT invoice and saves it.

What goes on the invoice (nothing is invented):
  * the CLIENT, and the CONFIRMED dispatch lines of the order's delivery list: product, SKU, name, unit and the dispatched quantity are the dispatch's own
    (never typed, never from the caller);
  * the unit price is the price AGREED with this client on the sales order (saved on the order line when the order was created) and the invoice currency is the
    order's currency. The product catalog is never consulted: it has no selling price for a client. An order made before prices were recorded has no agreed
    prices: NOTHING is made and the message says to enter the price by hand on the Sales Invoice page (no price is guessed, nothing is converted);
  * discount and tax are zero. Both can be set on the draft before it is issued, and the draft's prices can still be edited under the invoice's own rules.

It is only a DRAFT: no number is used and no stock, payment or Finance record is touched (see app/invoicing.py). Repeating the click never makes a second
invoice for the same goods: while an invoice (a draft, or an issued one) already covers the order's dispatched goods, THAT invoice is returned. A voided
invoice does not count, so voiding a mistaken one lets the order be invoiced again. The order row is locked for the whole operation, so two simultaneous
clicks make one invoice.
"""
import uuid
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_
from sqlalchemy.orm import Session

from app import invoicing
from app.auth import TenantContext
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


def generate(db: Session, tenant: TenantContext, order_id: uuid.UUID) -> Tuple[InvoiceDetail, bool]:
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

    if order.currency_code is None or any(l.agreed_unit_price is None for l in to_bill):
        db.rollback()
        raise _refuse(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "prices_not_recorded",
            f"{order.number} was made before agreed prices were recorded, so there is no price to put on the invoice. Create the invoice by hand on the Sales Invoice page and enter the price you agreed.",
        )

    payload = InvoiceCreate(
        client_id=order.client_id,
        currency_code=order.currency_code,
        notes=f"Generated from sales order {order.number} (delivery list {to_bill[0].delivery_list.number}).",
        lines=[
            InvoiceLineInput(dispatch_line_id=l.dispatch_line_id, quantity=l.remaining_quantity, unit_price=l.agreed_unit_price.quantize(PRICE, rounding=ROUND_HALF_UP))
            for l in to_bill
        ],
    )
    invoice, _ = invoicing.create_invoice(db, tenant, payload, f"order-invoice:{order.id}:{uuid.uuid4().hex}")  # commits (and so releases the order lock)
    return invoicing.detail(db, tenant, invoice), True
