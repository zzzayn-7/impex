"""Order invoices: the simple, printable invoice of a PREPARED sales order.

The flow the portal offers: Sales Invoice -> New invoice -> choose the client -> choose one of that client's prepared orders (booked, still to be dispatched) -> a page that shows
the order's details, read-only, with Print and Download.

What goes on the invoice (nothing is invented, nothing is typed):
  * the CLIENT (name and address as they are now, copied in), the SELLER (the organization's name), the ORDER number and the delivery list number;
  * every LINE of the order: product, SKU, name and unit as they are on the order, the quantity ORDERED, and the unit price AGREED with this client on the order. The product
    catalog is never consulted. An order made before prices were recorded has no agreed prices, so it cannot be invoiced here (no price is guessed);
  * discount and tax are not part of it; the total is the sum of the lines, in the order's one currency (nothing is converted).

It is a DOCUMENT, not a ledger entry: no draft step, no payments, no voiding, and nothing for Finance or the stock (the Finance feed reads only the older `invoices`). One order has
at most one invoice: asking again returns the one that exists, and two simultaneous requests make one (the order row is locked). The invoice is frozen the moment it is made
(a database guard), so a later change to the client, the catalog or the order never changes what was printed. Its number comes from the same counter as the older invoices.
"""
import uuid
from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from typing import Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, func, literal, select, union_all
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app import invoicing
from app.auth import TenantContext
from app.models import Client, DeliveryList, DeliveryListItem, Invoice, OrderInvoice, OrderInvoiceLine, SalesOrder
from app.orders import get_order_or_404
from app.schemas import HistoryItem, OrderInvoiceDetail, OrderInvoiceLineResponse
from app.tenancy import scoped_select

ZERO = Decimal("0.0000")


def _refuse(http: int, code: str, message: str) -> HTTPException:
    return HTTPException(http, {"code": code, "message": message})


def _user_id(tenant: TenantContext) -> uuid.UUID:
    try:
        return uuid.UUID(tenant.user_id)
    except ValueError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Organization administrator permission required")


def get_or_404(db: Session, tenant: TenantContext, invoice_id: uuid.UUID) -> OrderInvoice:
    found = db.scalar(scoped_select(OrderInvoice, tenant).where(OrderInvoice.id == invoice_id))
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found.")
    return found


def for_order(db: Session, tenant: TenantContext, order_id: uuid.UUID) -> Optional[OrderInvoice]:
    return db.scalar(scoped_select(OrderInvoice, tenant).where(OrderInvoice.order_id == order_id))


def lines_of(db: Session, tenant: TenantContext, invoice_id: uuid.UUID) -> List[OrderInvoiceLine]:
    return list(db.scalars(scoped_select(OrderInvoiceLine, tenant).where(OrderInvoiceLine.invoice_id == invoice_id).order_by(OrderInvoiceLine.position, OrderInvoiceLine.id)))


def detail(db: Session, tenant: TenantContext, invoice: OrderInvoice) -> OrderInvoiceDetail:
    return OrderInvoiceDetail(
        id=invoice.id, number=invoice.number, invoice_date=invoice.invoice_date, currency_code=invoice.currency_code, notes=invoice.notes,
        client_id=invoice.client_id, client_name=invoice.client_name, client_address=invoice.client_address, seller_name=invoice.seller_name,
        order_id=invoice.order_id, order_number=invoice.order_number, delivery_list_number=invoice.delivery_list_number,
        subtotal=invoice.subtotal, total=invoice.total, created_by_email=invoice.created_by_email, created_at=invoice.created_at,
        lines=[OrderInvoiceLineResponse(
            product_id=l.product_id, product_sku=l.product_sku, product_name=l.product_name, unit=l.unit, quantity=l.quantity, unit_price=l.unit_price, line_total=l.line_total,
        ) for l in lines_of(db, tenant, invoice.id)],
    )


def create(db: Session, tenant: TenantContext, order_id: uuid.UUID) -> Tuple[OrderInvoice, bool]:
    """(the invoice, created). created is False when the order already had one and that one is returned."""
    order = get_order_or_404(db, tenant, order_id, lock=True)  # another organization's order is a 404; one request at a time per order
    existing = for_order(db, tenant, order.id)
    if existing is not None:
        db.rollback()  # nothing changed: release the order lock
        return existing, False
    if order.status != "active":
        db.rollback()
        raise _refuse(status.HTTP_409_CONFLICT, "not_prepared", f"{order.number} is not a prepared order waiting to be dispatched, so it cannot be invoiced here.")
    items = list(db.scalars(
        scoped_select(DeliveryListItem, tenant).where(DeliveryListItem.delivery_list_id == order.delivery_list_id).order_by(DeliveryListItem.created_at, DeliveryListItem.id)
    ))
    if not items:
        db.rollback()
        raise _refuse(status.HTTP_409_CONFLICT, "no_lines", f"{order.number} has no products, so there is nothing to invoice.")
    if order.currency_code is None or any(i.unit_price is None for i in items):
        db.rollback()
        raise _refuse(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "prices_not_recorded",
            f"{order.number} was made before agreed prices were recorded, so there is no price to put on the invoice.",
        )
    client = db.scalar(scoped_select(Client, tenant).where(Client.id == order.client_id))
    delivery_list = db.scalar(scoped_select(DeliveryList, tenant).where(DeliveryList.id == order.delivery_list_id))
    try:
        rows = []
        for position, item in enumerate(items):
            subtotal, _, _, total = invoicing.line_amounts(item.quantity, item.unit_price, ZERO, ZERO)
            rows.append((position, item, total))
        total = sum((row[2] for row in rows), ZERO)
        invoice = OrderInvoice(
            id=uuid.uuid4(), organization_id=tenant.organization_id, order_id=order.id, client_id=order.client_id, number=invoicing.next_number(db, tenant), invoice_date=invoicing._today(),
            currency_code=order.currency_code, seller_name=tenant.organization_name or None, client_name=client.name, client_address=client.address, order_number=order.number,
            delivery_list_number=delivery_list.number if delivery_list is not None else None, notes=order.notes, subtotal=total, total=total,
            created_by=_user_id(tenant), created_by_email=tenant.email,
        )
        db.add(invoice)
        db.flush()
        for position, item, line_total in rows:
            db.add(OrderInvoiceLine(
                organization_id=tenant.organization_id, invoice_id=invoice.id, position=position, product_id=item.product_id, product_sku=item.product_sku, product_name=item.product_name,
                unit=item.unit, quantity=item.quantity, unit_price=item.unit_price, line_total=line_total,
            ))
        db.commit()  # releases the order lock
    except DBAPIError as exc:
        db.rollback()
        raise invoicing._database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(invoice)
    return invoice, True


def by_orders(db: Session, tenant: TenantContext, order_ids: List[uuid.UUID]) -> Dict[uuid.UUID, OrderInvoice]:
    if not order_ids:
        return {}
    return {i.order_id: i for i in db.scalars(scoped_select(OrderInvoice, tenant).where(OrderInvoice.order_id.in_(order_ids)))}


# --- history: the new invoices AND the older ones, newest first -------------------------------------------------------------------------
def history(db: Session, tenant: TenantContext, *, client_id: Optional[uuid.UUID], day: Optional[date], limit: int, offset: int) -> Tuple[List[HistoryItem], int]:
    """Every invoice of the organization, newest first: the order invoices and the older (dispatch-based) ones in one list. `client_id` and `day` (the invoice date) narrow it and
    work alone or together."""
    org = tenant.organization_id
    new = select(
        literal("order").label("kind"), OrderInvoice.id.label("id"), OrderInvoice.number.label("number"), OrderInvoice.client_id.label("client_id"), OrderInvoice.client_name.label("client_name"),
        OrderInvoice.invoice_date.label("invoice_date"), OrderInvoice.currency_code.label("currency_code"), OrderInvoice.total.label("total"), literal("issued").label("status"),
        OrderInvoice.order_number.label("order_number"), OrderInvoice.created_at.label("created_at"),
    ).where(OrderInvoice.organization_id == org)
    old = select(
        literal("invoice").label("kind"), Invoice.id, Invoice.number, Invoice.client_id, func.coalesce(Invoice.client_name, Client.name).label("client_name"), Invoice.invoice_date,
        Invoice.currency_code, Invoice.total, Invoice.status, literal(None).label("order_number"), Invoice.created_at,
    ).join(Client, and_(Client.id == Invoice.client_id, Client.organization_id == Invoice.organization_id)).where(Invoice.organization_id == org)
    if client_id is not None:
        new, old = new.where(OrderInvoice.client_id == client_id), old.where(Invoice.client_id == client_id)
    if day is not None:
        new, old = new.where(OrderInvoice.invoice_date == day), old.where(Invoice.invoice_date == day)
    both = union_all(new, old).subquery()
    total = db.scalar(select(func.count()).select_from(both)) or 0
    rows = db.execute(select(both).order_by(both.c.created_at.desc(), both.c.number.desc().nulls_last(), both.c.id).limit(limit).offset(offset)).all()
    return [HistoryItem(
        kind=r.kind, id=r.id, number=r.number, client_id=r.client_id, client_name=r.client_name, invoice_date=r.invoice_date, currency_code=r.currency_code, total=r.total,
        status=r.status, order_number=r.order_number,
    ) for r in rows], total


# --- the PDF (the same template as every invoice) -----------------------------------------------------------------------------------------
def pdf_model(db: Session, tenant: TenantContext, invoice: OrderInvoice) -> SimpleNamespace:
    """The invoice in the shape the PDF template reads. It is a plain document, so there is no due date, payment status or balance on it (build_pdf(document=True))."""
    lines = [
        SimpleNamespace(product_name=l.product_name, product_sku=l.product_sku, unit=l.unit, quantity=l.quantity, unit_price=l.unit_price, line_subtotal=l.line_total,
                        discount_amount=ZERO, tax_rate=ZERO, tax_label=None, line_tax=ZERO)
        for l in lines_of(db, tenant, invoice.id)
    ]
    return SimpleNamespace(
        seller_name=invoice.seller_name, number=invoice.number, status="issued", invoice_date=invoice.invoice_date, due_date=invoice.invoice_date, currency_code=invoice.currency_code,
        client_name=invoice.client_name, client_address=invoice.client_address, delivery_list=SimpleNamespace(number=invoice.delivery_list_number) if invoice.delivery_list_number else None,
        notes=invoice.notes, void_reason=None, lines=lines, payments=[], subtotal=invoice.subtotal, discount_total=ZERO, tax_total=ZERO, total=invoice.total, paid_total=ZERO,
        outstanding=invoice.total, overdue=False,
    )
