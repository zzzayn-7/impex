"""Invoices and payments. Every route depends on `require_active_tenant`; none accepts an organization id.

NOTHING in this module touches inventory or calls the Inventory Service: see app/invoicing.py. Payments are recorded by hand - no bank
or payment gateway is involved.
"""
import re
import uuid
from datetime import date
from typing import Literal, Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import invoicing
from app.auth import TenantContext, bearer_scheme, get_org_client, require_active_tenant
from app.database import get_db
from app.invoice_pdf import Branding, build_pdf
from app.models import Client, Invoice
from app.schemas import (
    BillableLine, ClientAccount, InvoiceCreate, InvoiceDetail, InvoiceLines, InvoicePage, InvoiceUpdate, PaymentCreate, ReversalCreate, VoidRequest,
)
from app.search import like_pattern
from app.tenancy import scoped_count, scoped_select

router = APIRouter(prefix="/api/v1/sales")
Tenant = Depends(require_active_tenant)

IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,100}$")


def idempotency_key(key: Optional[str] = Header(default=None, alias="Idempotency-Key")) -> str:
    key = (key or "").strip()
    if not key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The Idempotency-Key header is required.")
    if not IDEMPOTENCY_KEY_RE.match(key):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key must be 8-100 characters: letters, digits and . _ : -")
    return key


@router.get("/billable-lines", response_model=list[BillableLine], tags=["Invoices"])
def list_billable_lines(client_id: uuid.UUID, delivery_list_id: Optional[uuid.UUID] = None, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """The confirmed dispatch lines of one client that can be invoiced, with what is already invoiced and what is still free."""
    return invoicing.billable_lines(db, tenant, client_id, delivery_list_id)


@router.post("/invoices", response_model=InvoiceDetail, status_code=status.HTTP_201_CREATED, tags=["Invoices"])
def create_invoice(payload: InvoiceCreate, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Start a DRAFT invoice for a client from confirmed dispatch lines. Writes no stock movement. The first request answers 201; a retry
    with the same Idempotency-Key and body answers 200 with the same invoice."""
    invoice, replayed = invoicing.create_invoice(db, tenant, payload, key)
    response.status_code = status.HTTP_200_OK if replayed else status.HTTP_201_CREATED
    return invoicing.detail(db, tenant, invoice)


@router.get("/invoices", response_model=InvoicePage, tags=["Invoices"])
def list_invoices(
    client_id: Optional[uuid.UUID] = None,
    status_filter: Optional[Literal["draft", "issued", "partially_paid", "paid", "void"]] = Query(default=None, alias="status"),
    payment_status: Optional[Literal["unpaid", "partial", "paid", "overdue"]] = Query(default=None, description="unpaid = issued with nothing paid; partial; paid; overdue = past due and not fully paid"),
    q: Optional[str] = Query(default=None, max_length=100, description="Search invoice number, client name or notes"),
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    filters = []
    if client_id:
        filters.append(Invoice.client_id == client_id)
    if status_filter:
        filters.append(Invoice.status == status_filter)
    if payment_status == "unpaid":
        filters.append(Invoice.status == "issued")
    elif payment_status == "partial":
        filters.append(Invoice.status == "partially_paid")
    elif payment_status == "paid":
        filters.append(Invoice.status == "paid")
    elif payment_status == "overdue":
        filters += [Invoice.status.in_(("issued", "partially_paid")), Invoice.due_date < invoicing._today()]
    if date_from:
        filters.append(Invoice.invoice_date >= date_from)
    if date_to:
        filters.append(Invoice.invoice_date <= date_to)
    if q and q.strip():
        filters.append(invoicing.search_filter(like_pattern(q.strip())))
    join = (Client.id == Invoice.client_id) & (Client.organization_id == Invoice.organization_id)
    total = db.scalar(scoped_count(Invoice, tenant).join(Client, join).where(*filters))
    rows = db.scalars(
        scoped_select(Invoice, tenant).join(Client, join).where(*filters)
        .order_by(Invoice.invoice_date.desc(), Invoice.created_at.desc(), Invoice.id.desc()).limit(limit).offset(offset)
    ).all()
    return InvoicePage(items=invoicing.summaries(db, tenant, list(rows)), total=total, limit=limit, offset=offset)


@router.get("/invoices/{invoice_id}", response_model=InvoiceDetail, tags=["Invoices"])
def get_invoice(invoice_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return invoicing.detail(db, tenant, invoicing.get_invoice_or_404(db, tenant, invoice_id))


async def organization_logo(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme), org_client: httpx.AsyncClient = Depends(get_org_client),
) -> Optional[bytes]:
    """The caller's own organization's logo, through the Organization Service's secured, tenant-bound endpoint with the caller's own token. A missing logo - or an unreachable
    service - is simply "no logo" (the invoice then shows the initials square): it never stops an invoice from being printed."""
    if credentials is None:
        return None
    try:
        response = await org_client.get("/api/v1/tenant/organization/logo", headers={"Authorization": f"Bearer {credentials.credentials}"})
    except httpx.HTTPError:
        return None
    if response.status_code != 200 or not response.headers.get("content-type", "").startswith("image/"):
        return None
    return response.content


@router.get("/invoices/{invoice_id}/pdf", tags=["Invoices"], responses={200: {"content": {"application/pdf": {}}}})
def invoice_pdf(
    invoice_id: uuid.UUID, inline: bool = False, tenant: TenantContext = Tenant, logo: Optional[bytes] = Depends(organization_logo), db: Session = Depends(get_db),
):
    """The invoice as a PDF, built from the saved invoice only (and the organization's branding). Read-only. `inline=true` is what Print opens (shown, not downloaded); the document
    is the same."""
    detail = invoicing.detail(db, tenant, invoicing.get_invoice_or_404(db, tenant, invoice_id))
    contact = db.scalar(select(Client.contact_person).where(Client.organization_id == tenant.organization_id, Client.id == detail.client.id))
    pdf = build_pdf(detail, Branding(name=tenant.organization_name, description=tenant.organization_description, logo=logo), contact_person=contact)
    filename = f"{detail.number or 'invoice-draft'}.pdf"
    return Response(content=pdf, media_type="application/pdf", headers={"Content-Disposition": f'{"inline" if inline else "attachment"}; filename="{filename}"', "Cache-Control": "no-store"})


@router.patch("/invoices/{invoice_id}", response_model=InvoiceDetail, tags=["Invoices"])
def update_invoice(invoice_id: uuid.UUID, payload: InvoiceUpdate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Edit the dates or notes of a DRAFT invoice. An issued invoice is frozen."""
    invoice = invoicing.update_header(db, tenant, invoice_id, payload.model_dump(exclude_unset=True))
    return invoicing.detail(db, tenant, invoice)


@router.put("/invoices/{invoice_id}/lines", response_model=InvoiceDetail, tags=["Invoices"])
def save_invoice_lines(invoice_id: uuid.UUID, payload: InvoiceLines, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Replace the lines of a DRAFT invoice with exactly these; the totals are recalculated here."""
    return invoicing.detail(db, tenant, invoicing.save_lines(db, tenant, invoice_id, payload.lines))


@router.post("/invoices/{invoice_id}/issue", response_model=InvoiceDetail, tags=["Invoices"])
def issue_invoice(invoice_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Issue a draft: it gets its number and is frozen. Repeating the call changes nothing."""
    return invoicing.detail(db, tenant, invoicing.issue_invoice(db, tenant, invoice_id))


@router.post("/invoices/{invoice_id}/void", response_model=InvoiceDetail, tags=["Invoices"])
def void_invoice(invoice_id: uuid.UUID, payload: VoidRequest, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Void a draft, or an issued invoice that has NO payment on record (409 `has_payments` otherwise: reverse the payments first)."""
    return invoicing.detail(db, tenant, invoicing.void_invoice(db, tenant, invoice_id, payload.reason))


@router.post("/invoices/{invoice_id}/payments", response_model=InvoiceDetail, status_code=status.HTTP_201_CREATED, tags=["Payments"])
def record_payment(
    invoice_id: uuid.UUID, payload: PaymentCreate, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)
):
    """Record a payment received against an issued invoice (full or partial). Never more than the outstanding amount. 201 the first time,
    200 for a retry with the same Idempotency-Key (nothing is recorded twice)."""
    invoice, replayed = invoicing.record_payment(db, tenant, invoice_id, payload, key)
    response.status_code = status.HTTP_200_OK if replayed else status.HTTP_201_CREATED
    return invoicing.detail(db, tenant, invoice)


@router.post("/invoices/{invoice_id}/payments/{payment_id}/reverse", response_model=InvoiceDetail, status_code=status.HTTP_201_CREATED, tags=["Payments"])
def reverse_payment(
    invoice_id: uuid.UUID, payment_id: uuid.UUID, payload: ReversalCreate, response: Response, tenant: TenantContext = Tenant,
    key: str = Depends(idempotency_key), db: Session = Depends(get_db),
):
    """Correct a payment by recording its REVERSAL with a reason. The payment itself is never edited or deleted."""
    invoice, replayed = invoicing.reverse_payment(db, tenant, invoice_id, payment_id, payload, key)
    response.status_code = status.HTTP_200_OK if replayed else status.HTTP_201_CREATED
    return invoicing.detail(db, tenant, invoice)


@router.get("/clients/{client_id}/account", response_model=ClientAccount, tags=["Invoices"])
def client_account(client_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """A client's invoices, recent payments and outstanding balance per currency."""
    return invoicing.client_account(db, tenant, client_id)
