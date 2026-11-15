"""Order invoices and the invoice history. Every route depends on `require_active_tenant`; none accepts an organization id. See app/order_invoices.py."""
import uuid
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import order_invoices
from app.auth import TenantContext, require_active_tenant
from app.database import get_db
from app.invoice_pdf import Branding, build_pdf
from app.invoices_api import organization_logo
from app.models import Client
from app.schemas import HistoryPage, OrderInvoiceCreate, OrderInvoiceDetail, OrderInvoiceRef, OrderInvoiceRefs

router = APIRouter(prefix="/api/v1/sales")
Tenant = Depends(require_active_tenant)


@router.post("/order-invoices", response_model=OrderInvoiceDetail, status_code=status.HTTP_201_CREATED, tags=["Order invoices"])
def create_order_invoice(payload: OrderInvoiceCreate, response: Response, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """The invoice of one prepared order. 201 when it was just made, 200 when the order already had one (that one is returned: there is never a second)."""
    invoice, created = order_invoices.create(db, tenant, payload.order_id)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return order_invoices.detail(db, tenant, invoice)


@router.get("/order-invoices/by-order", response_model=OrderInvoiceRefs, tags=["Order invoices"])
def invoices_of_orders(order_ids: str = Query(default="", max_length=4000, description="Comma-separated order ids"), tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Which of these orders already have an invoice (id and number), so a list of orders can show 'View invoice' instead of 'Create invoice'."""
    ids = []
    for part in [p.strip() for p in order_ids.split(",") if p.strip()][:200]:
        try:
            ids.append(uuid.UUID(part))
        except ValueError:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Order ids must be UUIDs.")
    found = order_invoices.by_orders(db, tenant, ids)
    return OrderInvoiceRefs(items=[OrderInvoiceRef(order_id=order_id, invoice_id=i.id, number=i.number) for order_id, i in found.items()])


@router.get("/invoice-history", response_model=HistoryPage, tags=["Order invoices"])
def invoice_history(
    client_id: Optional[uuid.UUID] = None,
    day: Optional[date] = Query(default=None, description="The invoice date"),
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    """All invoices (the order invoices and the older ones), newest first. `client_id` and `day` work alone or together."""
    items, total = order_invoices.history(db, tenant, client_id=client_id, day=day, limit=limit, offset=offset)
    return HistoryPage(items=items, total=total, limit=limit, offset=offset)


@router.get("/order-invoices/{invoice_id}", response_model=OrderInvoiceDetail, tags=["Order invoices"])
def get_order_invoice(invoice_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return order_invoices.detail(db, tenant, order_invoices.get_or_404(db, tenant, invoice_id))


@router.get("/order-invoices/{invoice_id}/pdf", tags=["Order invoices"], responses={200: {"content": {"application/pdf": {}}}})
def order_invoice_pdf(invoice_id: uuid.UUID, inline: bool = False, tenant: TenantContext = Tenant, logo: Optional[bytes] = Depends(organization_logo), db: Session = Depends(get_db)):
    """The invoice as a PDF on the same template as every invoice, built from the saved invoice only. `inline=true` is what Print opens (shown, not downloaded)."""
    invoice = order_invoices.get_or_404(db, tenant, invoice_id)
    contact = db.scalar(select(Client.contact_person).where(Client.organization_id == tenant.organization_id, Client.id == invoice.client_id))
    pdf = build_pdf(order_invoices.pdf_model(db, tenant, invoice), Branding(name=tenant.organization_name, description=tenant.organization_description, logo=logo),
                    contact_person=contact, document=True, order_number=invoice.order_number)
    return Response(content=pdf, media_type="application/pdf", headers={"Content-Disposition": f'{"inline" if inline else "attachment"}; filename="{invoice.number}.pdf"', "Cache-Control": "no-store"})
