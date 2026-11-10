"""Sales invoices and client payments.

The rules that matter most:

  * Invoicing NEVER touches inventory. This module does not import the Inventory gateway: an invoice is built from what was actually
    DISPATCHED (confirmed dispatch lines, which already left stock), and creating, issuing, paying or voiding one writes no stock
    movement and reads no product price. The selling price is whatever the administrator types; the catalog is never overwritten.
  * Quantities are billed once. An invoice line is backed by ALLOCATIONS: (invoice line, confirmed dispatch line, quantity). The
    quantity of a dispatch line that issued invoices already cover cannot be covered again - checked here under row locks and by a
    database trigger when the invoice is issued. Drafts reserve nothing (like every other draft in Impex).
  * Money is exact. Quantities, prices, discounts, rates and amounts are Decimals / NUMERIC(18,4); every line amount is calculated
    HERE (half-up to 4 decimals, re-checked by the database) and the invoice totals are the sums of the line amounts.
  * One currency per invoice, never converted. Taxes and discounts are exactly what the administrator entered; no jurisdiction's rules
    are built in, and nothing here claims an invoice meets any country's tax regulations.
  * An issued invoice is frozen and never deleted. Payments are an append-only record: they are never edited or deleted, a mistake is
    corrected by a REVERSAL (a new, auditable row), and an invoice with payments on record cannot be voided.
  * The payment status follows the payments: the database keeps `paid_total` and the status in step with the sum of the payment rows.
"""
import hashlib
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, case, delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

from app.auth import TenantContext
from app.currency import is_known_currency
from app.delivery import conflict
from app.models import (
    Client, DeliveryList, DeliveryListItem, Dispatch, DispatchLine, Invoice, InvoiceAllocation, InvoiceCounter, InvoiceLine, InvoicePayment, InvoiceRequest, SalesOrder,
)
from app.schemas import (
    ClientRef, DISCLAIMER, AccountBalance, AllocationResponse, BillableLine, ClientAccount, InvoiceDetail, InvoiceLineInput, InvoiceLineResponse,
    InvoiceSummary, ListRef, PaymentResponse, PaymentWithInvoice,
)
from app.tenancy import scoped_select

ZERO = Decimal("0.0000")
CENT = Decimal("0.0001")
LIMIT = Decimal(10) ** 14  # what fits a NUMERIC(18,4) column
COUNTED = ("issued", "partially_paid", "paid")  # invoices whose allocations use up dispatched quantity


def _user_id(tenant: TenantContext) -> uuid.UUID:
    try:
        return uuid.UUID(tenant.user_id)
    except ValueError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Organization administrator permission required")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _today() -> date:
    return _now().date()


def human(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _database_refusal(exc: DBAPIError) -> HTTPException:
    """The database rules are the last line of defence; if one fires, say why in the words the rule was written in."""
    message = str(exc.orig).splitlines()[0] if exc.orig is not None else "the database refused the change"
    return conflict(f"That change is not allowed: {message}.")


# --- money -----------------------------------------------------------------------------------------------------------------------
def _round(value: Decimal) -> Decimal:
    with localcontext() as context:
        context.prec = 80
        return value.quantize(CENT, rounding=ROUND_HALF_UP)


def line_amounts(quantity: Decimal, unit_price: Decimal, discount: Decimal, tax_rate: Decimal) -> Tuple[Decimal, Decimal, Decimal, Decimal]:
    """(subtotal, net, tax, total) of one line, exactly: subtotal = round(quantity x price); net = subtotal - discount;
    tax = round(net x rate / 100); total = net + tax. Identical to the CHECK constraints of the database."""
    with localcontext() as context:
        context.prec = 80
        subtotal = _round(quantity * unit_price)
        if discount > subtotal:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "A discount cannot be more than the amount it is taken from.")
        net = subtotal - discount
        tax = _round(net * tax_rate / Decimal(100))
        total = net + tax
    if total >= LIMIT:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That line total is too large. Check the quantity and the price.")
    return subtotal, net, tax, total


def check_currency(code: str) -> None:
    if not is_known_currency(code):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"'{code}' is not a valid ISO 4217 currency code (for example USD, EUR, PKR).")


# --- numbering -----------------------------------------------------------------------------------------------------------------
def next_number(db: Session, tenant: TenantContext) -> str:
    """INV-000001, INV-000002, ... per organization. Assigned when an invoice is ISSUED, inside the issuing transaction, so the
    numbers of issued invoices have no gaps (a failed issue rolls the counter back) and two invoices never share one."""
    row = db.execute(
        pg_insert(InvoiceCounter)
        .values(organization_id=tenant.organization_id, last_number=1)
        .on_conflict_do_update(index_elements=["organization_id"], set_={"last_number": InvoiceCounter.last_number + 1})
        .returning(InvoiceCounter.last_number)
    ).one()
    return f"INV-{row[0]:06d}"


# --- loading -----------------------------------------------------------------------------------------------------------------------
def get_invoice_or_404(db: Session, tenant: TenantContext, invoice_id: uuid.UUID, *, lock: bool = False) -> Invoice:
    query = scoped_select(Invoice, tenant).where(Invoice.id == invoice_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    found = db.scalar(query)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found.")
    return found


def get_client_or_404(db: Session, tenant: TenantContext, client_id: uuid.UUID) -> Client:
    found = db.scalar(scoped_select(Client, tenant).where(Client.id == client_id))
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Client not found.")
    return found


def invoice_lines(db: Session, tenant: TenantContext, invoice_id: uuid.UUID) -> List[InvoiceLine]:
    return list(db.scalars(scoped_select(InvoiceLine, tenant).where(InvoiceLine.invoice_id == invoice_id).order_by(InvoiceLine.position, InvoiceLine.id)))


def require_draft(invoice: Invoice) -> None:
    if invoice.status != "draft":
        label = {"issued": "issued", "partially_paid": "issued (partially paid)", "paid": "issued (paid)", "void": "void"}[invoice.status]
        raise conflict(f"{invoice.number or 'This invoice'} is {label}. Only a draft invoice can be changed; an issued one is frozen and void invoices are kept for history.")


def require_active_client(client: Client) -> None:
    if not client.is_active:
        raise conflict(f"{client.name} is inactive. Reactivate the client before creating or issuing an invoice for them (payments already due can still be recorded).")


# --- billable quantities ----------------------------------------------------------------------------------------------------------
def invoiced_quantities(
    db: Session, tenant: TenantContext, dispatch_line_ids: Iterable[uuid.UUID], exclude_invoice: Optional[uuid.UUID] = None
) -> Dict[uuid.UUID, Tuple[Decimal, Decimal]]:
    """dispatch line id -> (quantity covered by ISSUED invoices, quantity sitting in DRAFT invoices), optionally leaving one invoice out."""
    ids = list(dispatch_line_ids)
    if not ids:
        return {}
    totals: Dict[uuid.UUID, List[Decimal]] = {i: [ZERO, ZERO] for i in ids}
    query = (
        select(InvoiceAllocation.dispatch_line_id, Invoice.status, func.coalesce(func.sum(InvoiceAllocation.quantity), 0))
        .join(Invoice, and_(Invoice.organization_id == InvoiceAllocation.organization_id, Invoice.id == InvoiceAllocation.invoice_id))
        .where(InvoiceAllocation.organization_id == tenant.organization_id, InvoiceAllocation.dispatch_line_id.in_(ids), Invoice.status.in_(COUNTED + ("draft",)))
        .group_by(InvoiceAllocation.dispatch_line_id, Invoice.status)
    )
    if exclude_invoice is not None:
        query = query.where(Invoice.id != exclude_invoice)
    for line_id, invoice_status, total in db.execute(query).all():
        totals[line_id][1 if invoice_status == "draft" else 0] += Decimal(total).quantize(CENT)
    return {i: (v[0], v[1]) for i, v in totals.items()}


def billable_lines(db: Session, tenant: TenantContext, client_id: uuid.UUID, list_id: Optional[uuid.UUID] = None) -> List[BillableLine]:
    """The CONFIRMED dispatch lines of this client with how much of each is already invoiced (issued), sitting in drafts, and still free."""
    get_client_or_404(db, tenant, client_id)
    query = (
        scoped_select(DispatchLine, tenant)
        .add_columns(Dispatch, DeliveryList, DeliveryListItem.unit_price, SalesOrder.currency_code, SalesOrder.number)
        .join(Dispatch, and_(Dispatch.organization_id == DispatchLine.organization_id, Dispatch.id == DispatchLine.dispatch_id))
        .join(DeliveryList, and_(DeliveryList.organization_id == Dispatch.organization_id, DeliveryList.id == Dispatch.delivery_list_id))
        .outerjoin(DeliveryListItem, and_(DeliveryListItem.organization_id == DispatchLine.organization_id, DeliveryListItem.id == DispatchLine.delivery_list_item_id))
        .outerjoin(SalesOrder, and_(SalesOrder.organization_id == DeliveryList.organization_id, SalesOrder.delivery_list_id == DeliveryList.id))
        .where(Dispatch.client_id == client_id, Dispatch.status == "confirmed")
        .order_by(Dispatch.dispatch_date.desc(), Dispatch.number.desc(), DispatchLine.product_name, DispatchLine.id)
    )
    if list_id is not None:
        query = query.where(Dispatch.delivery_list_id == list_id)
    rows = db.execute(query.limit(1000)).all()
    sums = invoiced_quantities(db, tenant, [r[0].id for r in rows])
    out = []
    for line, dispatch, delivery_list, agreed_price, agreed_currency, order_number in rows:
        issued, drafts = sums[line.id]
        priced = agreed_price is not None and agreed_currency is not None  # a line of an order made before prices were recorded has no agreed price
        out.append(
            BillableLine(
                dispatch_line_id=line.id, dispatch_id=dispatch.id, dispatch_number=dispatch.number, dispatch_date=dispatch.dispatch_date,
                delivery_list=ListRef(id=delivery_list.id, number=delivery_list.number, status=delivery_list.status), product_id=line.product_id,
                product_sku=line.product_sku, product_name=line.product_name, unit=line.unit,
                dispatched_quantity=line.quantity, invoiced_quantity=issued, in_drafts_quantity=drafts, remaining_quantity=max(line.quantity - issued, ZERO),
                agreed_unit_price=agreed_price if priced else None, agreed_currency_code=agreed_currency if priced else None, order_number=order_number,
            )
        )
    return out


# --- views --------------------------------------------------------------------------------------------------------------------------
def _overdue(invoice: Invoice) -> bool:
    return invoice.status in ("issued", "partially_paid") and invoice.due_date < _today()


def summaries(db: Session, tenant: TenantContext, invoices: List[Invoice]) -> List[InvoiceSummary]:
    if not invoices:
        return []
    clients = {c.id: c for c in db.scalars(scoped_select(Client, tenant).where(Client.id.in_({i.client_id for i in invoices})))}
    list_ids = {i.delivery_list_id for i in invoices if i.delivery_list_id}
    lists = {l.id: l for l in db.scalars(scoped_select(DeliveryList, tenant).where(DeliveryList.id.in_(list_ids)))} if list_ids else {}
    counts = dict(
        db.execute(
            select(InvoiceLine.invoice_id, func.count())
            .where(InvoiceLine.organization_id == tenant.organization_id, InvoiceLine.invoice_id.in_([i.id for i in invoices]))
            .group_by(InvoiceLine.invoice_id)
        ).all()
    )
    out = []
    for i in invoices:
        c = clients[i.client_id]
        dl = lists.get(i.delivery_list_id) if i.delivery_list_id else None
        out.append(
            InvoiceSummary(
                id=i.id, number=i.number, status=i.status, client=ClientRef(id=c.id, name=i.client_name or c.name, is_active=c.is_active),
                delivery_list=ListRef(id=dl.id, number=dl.number, status=dl.status) if dl else None, invoice_date=i.invoice_date, due_date=i.due_date,
                currency_code=i.currency_code, subtotal=i.subtotal, discount_total=i.discount_total, tax_total=i.tax_total, total=i.total, paid_total=i.paid_total,
                outstanding=i.total - i.paid_total, overdue=_overdue(i), line_count=counts.get(i.id, 0), created_by_email=i.created_by_email, issued_at=i.issued_at,
                issued_by_email=i.issued_by_email, voided_at=i.voided_at, updated_at=i.updated_at,
            )
        )
    return out


def payment_response(p: InvoicePayment) -> PaymentResponse:
    return PaymentResponse.model_validate(p)


def detail(db: Session, tenant: TenantContext, invoice: Invoice) -> InvoiceDetail:
    (summary,) = summaries(db, tenant, [invoice])
    lines = invoice_lines(db, tenant, invoice.id)
    allocations = list(db.execute(
        scoped_select(InvoiceAllocation, tenant).add_columns(Dispatch.id, Dispatch.number)
        .join(DispatchLine, and_(DispatchLine.organization_id == InvoiceAllocation.organization_id, DispatchLine.id == InvoiceAllocation.dispatch_line_id))
        .join(Dispatch, and_(Dispatch.organization_id == DispatchLine.organization_id, Dispatch.id == DispatchLine.dispatch_id))
        .where(InvoiceAllocation.invoice_id == invoice.id).order_by(Dispatch.number)
    ).all())
    by_line: Dict[uuid.UUID, List[AllocationResponse]] = {}
    for allocation, dispatch_id, dispatch_number in allocations:
        by_line.setdefault(allocation.invoice_line_id, []).append(
            AllocationResponse(dispatch_line_id=allocation.dispatch_line_id, dispatch_id=dispatch_id, dispatch_number=dispatch_number, quantity=allocation.quantity)
        )
    rendered = [
        InvoiceLineResponse(
            id=l.id, product_id=l.product_id, product_sku=l.product_sku, product_name=l.product_name, unit=l.unit, quantity=l.quantity, unit_price=l.unit_price,
            discount_amount=l.discount_amount, tax_rate=l.tax_rate, tax_label=l.tax_label, line_subtotal=l.line_subtotal, line_net=l.line_net, line_tax=l.line_tax,
            line_total=l.line_total, allocations=by_line.get(l.id, []),
        )
        for l in lines
    ]
    payments = list(db.scalars(scoped_select(InvoicePayment, tenant).where(InvoicePayment.invoice_id == invoice.id).order_by(InvoicePayment.created_at, InvoicePayment.id)))
    reversed_ids = {p.reverses_payment_id for p in payments if p.reverses_payment_id}
    responses = []
    for p in payments:
        r = payment_response(p)
        r.reversed = p.id in reversed_ids
        responses.append(r)
    outstanding = invoice.total - invoice.paid_total
    return InvoiceDetail(
        **summary.model_dump(), seller_name=invoice.seller_name, client_name=invoice.client_name, client_address=invoice.client_address, notes=invoice.notes,
        void_reason=invoice.void_reason, lines=rendered, payments=responses, editable=invoice.status == "draft",
        can_issue=invoice.status == "draft" and bool(rendered), can_void=invoice.status == "draft" or (invoice.status == "issued" and invoice.paid_total == 0),
        can_record_payment=invoice.status in ("issued", "partially_paid") and outstanding > 0, disclaimer=DISCLAIMER,
    )


# --- validating lines ------------------------------------------------------------------------------------------------------------------
class Row:
    """One invoice line, validated, as plain values."""

    def __init__(self, dispatch_line: DispatchLine, dispatch: Dispatch, item: InvoiceLineInput):
        self.dispatch_line_id, self.dispatch_id, self.dispatch_list_id = dispatch_line.id, dispatch.id, dispatch.delivery_list_id
        self.product_id, self.sku, self.name, self.unit = dispatch_line.product_id, dispatch_line.product_sku, dispatch_line.product_name, dispatch_line.unit
        self.dispatched = dispatch_line.quantity
        self.quantity, self.unit_price, self.discount, self.tax_rate, self.tax_label = item.quantity, item.unit_price, item.discount_amount, item.tax_rate, item.tax_label
        self.subtotal, self.net, self.tax, self.total = line_amounts(self.quantity, self.unit_price, self.discount, self.tax_rate)


def build_rows(db: Session, tenant: TenantContext, client_id: uuid.UUID, items: List[InvoiceLineInput]) -> List[Row]:
    """Each line must name a CONFIRMED dispatch line of THIS client (another client's or organization's looks like a missing one)."""
    ids = [i.dispatch_line_id for i in items]
    if len(ids) != len(set(ids)):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "A dispatch line can appear only once on an invoice; bill part of it by lowering the quantity.")
    found = {
        line.id: (line, dispatch)
        for line, dispatch in db.execute(
            scoped_select(DispatchLine, tenant).add_columns(Dispatch)
            .join(Dispatch, and_(Dispatch.organization_id == DispatchLine.organization_id, Dispatch.id == DispatchLine.dispatch_id))
            .where(DispatchLine.id.in_(ids), Dispatch.client_id == client_id, Dispatch.status == "confirmed")
        ).all()
    }
    rows = []
    for item in items:
        if item.dispatch_line_id not in found:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "That dispatched product was not found among this client's confirmed dispatches.")
        rows.append(Row(*found[item.dispatch_line_id], item))
    total = sum((r.total for r in rows), ZERO)
    if total >= LIMIT:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That invoice total is too large.")
    return rows


def check_capacity(db: Session, tenant: TenantContext, rows: List[Row], invoice_id: Optional[uuid.UUID], *, include_drafts: bool = False) -> None:
    """The quantity of a dispatch line that ISSUED invoices already cover cannot be billed again."""
    sums = invoiced_quantities(db, tenant, [r.dispatch_line_id for r in rows], exclude_invoice=invoice_id)
    for r in rows:
        issued, _ = sums[r.dispatch_line_id]
        free = r.dispatched - issued
        if r.quantity > free:
            raise conflict(
                f"You cannot bill {human(r.quantity)} {r.unit} of {r.name}: {human(r.dispatched)} were dispatched and {human(issued)} are already on issued invoices, "
                f"so at most {human(max(free, ZERO))} can still be billed.",
                code="over_invoiced",
            )


def _header_totals(rows: List[Row]) -> Tuple[Decimal, Decimal, Decimal, Decimal]:
    subtotal = sum((r.subtotal for r in rows), ZERO)
    discount = sum((r.discount for r in rows), ZERO)
    tax = sum((r.tax for r in rows), ZERO)
    return subtotal, discount, tax, subtotal - discount + tax


def _write_lines(db: Session, tenant: TenantContext, invoice: Invoice, rows: List[Row]) -> None:
    db.execute(delete(InvoiceAllocation).where(InvoiceAllocation.organization_id == tenant.organization_id, InvoiceAllocation.invoice_id == invoice.id))
    db.execute(delete(InvoiceLine).where(InvoiceLine.organization_id == tenant.organization_id, InvoiceLine.invoice_id == invoice.id))
    db.flush()
    for position, r in enumerate(rows):
        line = InvoiceLine(
            id=uuid.uuid4(), organization_id=tenant.organization_id, invoice_id=invoice.id, position=position, product_id=r.product_id, product_sku=r.sku,
            product_name=r.name, unit=r.unit, quantity=r.quantity, unit_price=r.unit_price, discount_amount=r.discount, tax_rate=r.tax_rate, tax_label=r.tax_label,
            line_subtotal=r.subtotal, line_net=r.net, line_tax=r.tax, line_total=r.total,
        )
        db.add(line)
        db.flush()
        db.add(InvoiceAllocation(organization_id=tenant.organization_id, invoice_id=invoice.id, invoice_line_id=line.id, dispatch_line_id=r.dispatch_line_id, quantity=r.quantity))
    db.flush()
    subtotal, discount, tax, total = _header_totals(rows)
    invoice.subtotal, invoice.discount_total, invoice.tax_total, invoice.total = subtotal, discount, tax, total
    lists = {r.dispatch_list_id for r in rows}
    invoice.delivery_list_id = next(iter(lists)) if len(lists) == 1 else None
    db.flush()


# --- creating (idempotent) --------------------------------------------------------------------------------------------------------------
def check_dates(invoice_date: date, due_date: date) -> None:
    if invoice_date > _today() + timedelta(days=1):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The invoice date cannot be in the future.")
    if due_date < invoice_date:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The due date cannot be before the invoice date.")


def _request_hash(payload) -> str:
    return hashlib.sha256(json.dumps(payload.model_dump(mode="json"), sort_keys=True).encode()).hexdigest()


def _replay(db: Session, tenant: TenantContext, key: str, request_hash: str) -> Invoice:
    previous = db.scalar(scoped_select(InvoiceRequest, tenant).where(InvoiceRequest.idempotency_key == key))
    if previous is None or previous.invoice_id is None:
        raise conflict("The request was being processed. Please retry.")
    if previous.request_hash != request_hash:
        raise conflict("This Idempotency-Key was already used for a different request. Use a new key for a new invoice.")
    return get_invoice_or_404(db, tenant, previous.invoice_id)


def create_invoice(db: Session, tenant: TenantContext, payload, key: str) -> Tuple[Invoice, bool]:
    """A DRAFT invoice for one client from confirmed dispatch lines. Creates no stock movement and calls no other service.
    Returns (invoice, replayed): a repeated request with the same key returns the first invoice and creates nothing."""
    request_hash = _request_hash(payload)
    if db.scalar(scoped_select(InvoiceRequest, tenant).where(InvoiceRequest.idempotency_key == key)) is not None:
        return _replay(db, tenant, key, request_hash), True
    check_currency(payload.currency_code)
    invoice_date = payload.invoice_date or _today()
    due_date = payload.due_date or invoice_date + timedelta(days=30)
    check_dates(invoice_date, due_date)
    client = get_client_or_404(db, tenant, payload.client_id)
    require_active_client(client)
    claimed = db.execute(
        pg_insert(InvoiceRequest)
        .values(organization_id=tenant.organization_id, idempotency_key=key, request_hash=request_hash)
        .on_conflict_do_nothing(index_elements=["organization_id", "idempotency_key"])
        .returning(InvoiceRequest.id)
    ).first()
    if claimed is None:  # a concurrent duplicate won the race and has committed by now
        db.rollback()
        return _replay(db, tenant, key, request_hash), True
    try:
        rows = build_rows(db, tenant, client.id, payload.lines)
        check_capacity(db, tenant, rows, None)
        invoice = Invoice(
            id=uuid.uuid4(), organization_id=tenant.organization_id, client_id=client.id, status="draft", invoice_date=invoice_date, due_date=due_date,
            currency_code=payload.currency_code, notes=payload.notes, seller_name=tenant.organization_name or None, client_name=client.name, client_address=client.address,
            created_by=_user_id(tenant), created_by_email=tenant.email,
        )
        db.add(invoice)
        db.flush()
        _write_lines(db, tenant, invoice, rows)
        db.execute(InvoiceRequest.__table__.update().where(InvoiceRequest.id == claimed[0]).values(invoice_id=invoice.id))
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()  # the claimed key is released together with everything else
        raise
    db.refresh(invoice)
    return invoice, False


# --- editing a draft --------------------------------------------------------------------------------------------------------------------
def update_header(db: Session, tenant: TenantContext, invoice_id: uuid.UUID, changes: dict) -> Invoice:
    invoice = get_invoice_or_404(db, tenant, invoice_id, lock=True)
    require_draft(invoice)
    new_date, new_due = changes.get("invoice_date", invoice.invoice_date), changes.get("due_date", invoice.due_date)
    check_dates(new_date, new_due)
    for field, value in changes.items():
        setattr(invoice, field, value)
    try:
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    db.refresh(invoice)
    return invoice


def save_lines(db: Session, tenant: TenantContext, invoice_id: uuid.UUID, items: List[InvoiceLineInput]) -> Invoice:
    """Replace the draft's lines with exactly these (the totals are recalculated here). Changes no stock."""
    try:
        invoice = get_invoice_or_404(db, tenant, invoice_id, lock=True)
        require_draft(invoice)
        client = get_client_or_404(db, tenant, invoice.client_id)
        require_active_client(client)
        rows = build_rows(db, tenant, invoice.client_id, items)
        check_capacity(db, tenant, rows, invoice.id)
        _write_lines(db, tenant, invoice, rows)
        invoice.updated_at = _now()
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(invoice)
    return invoice


# --- issuing and voiding ---------------------------------------------------------------------------------------------------------------
def issue_invoice(db: Session, tenant: TenantContext, invoice_id: uuid.UUID) -> Invoice:
    """Freeze a draft: it gets its number, and from now on its commercial details cannot change. Idempotent."""
    try:
        invoice = get_invoice_or_404(db, tenant, invoice_id, lock=True)
        if invoice.status in COUNTED:
            db.rollback()
            return invoice  # already issued: harmless to repeat
        if invoice.status == "void":
            raise conflict(f"This invoice is void and cannot be issued.")
        client = get_client_or_404(db, tenant, invoice.client_id)
        require_active_client(client)
        lines = invoice_lines(db, tenant, invoice.id)
        if not lines:
            raise conflict("Add at least one dispatched product before issuing the invoice.")
        if invoice.total <= 0:
            raise conflict("An invoice with a total of zero cannot be issued. Check the prices and discounts.")
        check_dates(invoice.invoice_date, invoice.due_date)
        # lock the dispatch lines being billed, in a fixed order, and re-check the quantities against ISSUED invoices
        allocations = list(db.scalars(scoped_select(InvoiceAllocation, tenant).where(InvoiceAllocation.invoice_id == invoice.id)))
        ids = sorted({a.dispatch_line_id for a in allocations}, key=str)
        locked = {l.id: l for l in db.scalars(scoped_select(DispatchLine, tenant).where(DispatchLine.id.in_(ids)).order_by(DispatchLine.id).with_for_update())}
        sums = invoiced_quantities(db, tenant, ids, exclude_invoice=invoice.id)
        for a in allocations:
            line = locked[a.dispatch_line_id]
            issued, _ = sums[a.dispatch_line_id]
            if a.quantity > line.quantity - issued:
                raise conflict(
                    f"{line.product_name}: {human(line.quantity)} {line.unit} were dispatched and {human(issued)} are already on issued invoices, so at most "
                    f"{human(max(line.quantity - issued, ZERO))} can still be billed.", code="over_invoiced",
                )
        invoice.client_name, invoice.client_address = client.name, client.address  # the bill-to details as they are NOW, frozen with the invoice
        invoice.number = next_number(db, tenant)
        invoice.status, invoice.issued_at, invoice.issued_by, invoice.issued_by_email = "issued", _now(), _user_id(tenant), tenant.email
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(invoice)
    return invoice


def void_invoice(db: Session, tenant: TenantContext, invoice_id: uuid.UUID, reason: Optional[str]) -> Invoice:
    """Void a draft (discard it) or an issued invoice with NO payment on record. An invoice with payments cannot be voided: reverse the
    payments first (each reversal is a permanent record) - that keeps the payment history intact."""
    try:
        invoice = get_invoice_or_404(db, tenant, invoice_id, lock=True)
        if invoice.status == "void":
            db.rollback()
            return invoice  # already void: harmless to repeat
        if invoice.status in ("partially_paid", "paid") or (invoice.status == "issued" and invoice.paid_total > 0):
            raise conflict(
                f"{invoice.number} has payments on record and cannot be voided: that would destroy the payment history. "
                "Reverse the payments first (each reversal is kept as its own record), then void the invoice and issue a corrected one.",
                code="has_payments",
            )
        if invoice.status == "issued" and not reason:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Give the reason for voiding an issued invoice.")
        invoice.status, invoice.voided_at, invoice.voided_by_email, invoice.void_reason = "void", _now(), tenant.email, reason
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(invoice)
    return invoice


# --- payments ------------------------------------------------------------------------------------------------------------------------------
def _payment_hash(kind: str, invoice_id: uuid.UUID, fields: dict) -> str:
    return hashlib.sha256(json.dumps({"kind": kind, "invoice": str(invoice_id), **{k: str(v) for k, v in fields.items()}}, sort_keys=True).encode()).hexdigest()


def _existing_payment(db: Session, tenant: TenantContext, key: str) -> Optional[InvoicePayment]:
    return db.scalar(scoped_select(InvoicePayment, tenant).where(InvoicePayment.idempotency_key == key))


def record_payment(db: Session, tenant: TenantContext, invoice_id: uuid.UUID, payload, key: str) -> Tuple[Invoice, bool]:
    """Record a payment against an issued invoice. Returns (invoice, replayed). Never more than the outstanding amount (no credit is
    created), and a repeated request with the same Idempotency-Key records nothing new."""
    fields = payload.model_dump(mode="json")
    request_hash = _payment_hash("payment", invoice_id, fields)
    payment_date = payload.payment_date or _today()
    if payment_date > _today() + timedelta(days=1):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The payment date cannot be in the future.")
    try:
        invoice = get_invoice_or_404(db, tenant, invoice_id, lock=True)  # serializes payments of the same invoice
        previous = _existing_payment(db, tenant, key)
        if previous is not None:
            if previous.invoice_id != invoice.id or previous.request_hash != request_hash or previous.kind != "payment":
                raise conflict("This Idempotency-Key was already used for a different request. Use a new key for a new payment.")
            db.rollback()
            return get_invoice_or_404(db, tenant, invoice_id), True
        if invoice.status in ("draft", "void"):
            raise conflict(f"{'This draft' if invoice.status == 'draft' else invoice.number} is {invoice.status}: payments can be recorded only against an issued invoice.")
        outstanding = invoice.total - invoice.paid_total
        if invoice.status == "paid" or outstanding <= 0:
            raise conflict(f"{invoice.number} is already paid in full. No credit is held: a payment above the amount due is not accepted.", code="overpayment")
        if payload.amount > outstanding:
            raise conflict(
                f"{human(payload.amount)} {invoice.currency_code} is more than the {human(outstanding)} {invoice.currency_code} still due on {invoice.number}. "
                "Payments above the outstanding amount are not accepted (no credit balance is held).", code="overpayment",
            )
        db.add(InvoicePayment(
            organization_id=tenant.organization_id, invoice_id=invoice.id, kind="payment", payment_date=payment_date, amount=payload.amount,
            currency_code=invoice.currency_code, method=payload.method, reference=payload.reference, notes=payload.notes, idempotency_key=key,
            request_hash=request_hash, recorded_by=_user_id(tenant), recorded_by_email=tenant.email,
        ))
        db.commit()
    except IntegrityError as exc:  # the same key raced in from another invoice: the unique index decided
        db.rollback()
        if "idempotency_key" in str(exc.orig):
            raise conflict("This Idempotency-Key was already used for a different request. Use a new key for a new payment.")
        raise _database_refusal(exc)
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(invoice)  # the database trigger moved paid_total and the status: show what is stored
    return invoice, False


def reverse_payment(db: Session, tenant: TenantContext, invoice_id: uuid.UUID, payment_id: uuid.UUID, payload, key: str) -> Tuple[Invoice, bool]:
    """Correct a mistaken payment WITHOUT touching it: a reversal row of the same amount is added, with a reason. A payment can be
    reversed once; the original and its reversal both stay on the invoice forever."""
    request_hash = _payment_hash("reversal", invoice_id, {"payment": payment_id, "reason": payload.reason})
    try:
        invoice = get_invoice_or_404(db, tenant, invoice_id, lock=True)
        previous = _existing_payment(db, tenant, key)
        if previous is not None:
            if previous.invoice_id != invoice.id or previous.request_hash != request_hash or previous.kind != "reversal":
                raise conflict("This Idempotency-Key was already used for a different request. Use a new key for a new reversal.")
            db.rollback()
            return get_invoice_or_404(db, tenant, invoice_id), True
        original = db.scalar(scoped_select(InvoicePayment, tenant).where(InvoicePayment.id == payment_id, InvoicePayment.invoice_id == invoice.id))
        if original is None or original.kind != "payment":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Payment not found.")
        if db.scalar(scoped_select(InvoicePayment, tenant).where(InvoicePayment.reverses_payment_id == original.id)) is not None:
            raise conflict("That payment was already reversed. Both records stay on the invoice.", code="already_reversed")
        if invoice.status == "void":
            raise conflict(f"{invoice.number} is void.")
        db.add(InvoicePayment(
            organization_id=tenant.organization_id, invoice_id=invoice.id, kind="reversal", reverses_payment_id=original.id, payment_date=_today(), amount=original.amount,
            currency_code=original.currency_code, method=original.method, reference=original.reference, notes=payload.reason, idempotency_key=key,
            request_hash=request_hash, recorded_by=_user_id(tenant), recorded_by_email=tenant.email,
        ))
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        text_ = str(exc.orig)
        if "idempotency_key" in text_:
            raise conflict("This Idempotency-Key was already used for a different request. Use a new key for a new reversal.")
        if "reverses_payment_id" in text_:
            raise conflict("That payment was already reversed. Both records stay on the invoice.", code="already_reversed")
        raise _database_refusal(exc)
    except DBAPIError as exc:
        db.rollback()
        raise _database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(invoice)  # the database trigger moved paid_total and the status: show what is stored
    return invoice, False


# --- the client's account ------------------------------------------------------------------------------------------------------------------
def client_account(db: Session, tenant: TenantContext, client_id: uuid.UUID) -> ClientAccount:
    client = get_client_or_404(db, tenant, client_id)
    invoices = list(db.scalars(scoped_select(Invoice, tenant).where(Invoice.client_id == client.id).order_by(Invoice.created_at.desc(), Invoice.id.desc()).limit(200)))
    # The balances are summed in the database over EVERY counted invoice of the client (the list below shows only the latest 200).
    owed = Invoice.total - Invoice.paid_total
    rows = db.execute(
        select(
            Invoice.currency_code, func.sum(Invoice.total), func.sum(Invoice.paid_total), func.sum(owed),
            func.sum(case((and_(Invoice.status.in_(("issued", "partially_paid")), Invoice.due_date < _today()), owed), else_=ZERO)),
        )
        .where(Invoice.organization_id == tenant.organization_id, Invoice.client_id == client.id, Invoice.status.in_(COUNTED))
        .group_by(Invoice.currency_code).order_by(Invoice.currency_code)
    ).all()
    balances = [
        AccountBalance(currency_code=code, invoiced=Decimal(a).quantize(CENT), paid=Decimal(b).quantize(CENT), outstanding=Decimal(c).quantize(CENT), overdue=Decimal(d).quantize(CENT))
        for code, a, b, c, d in rows
    ]
    payments = list(db.execute(
        scoped_select(InvoicePayment, tenant).add_columns(Invoice.number)
        .join(Invoice, and_(Invoice.organization_id == InvoicePayment.organization_id, Invoice.id == InvoicePayment.invoice_id))
        .where(Invoice.client_id == client.id).order_by(InvoicePayment.created_at.desc(), InvoicePayment.id.desc()).limit(50)
    ).all())
    shown = [p.id for p, _ in payments]
    reversed_ids = set(db.scalars(scoped_select(InvoicePayment, tenant).where(InvoicePayment.reverses_payment_id.in_(shown))).all()) if shown else set()
    reversed_of = {r.reverses_payment_id for r in reversed_ids}
    return ClientAccount(
        client=ClientRef(id=client.id, name=client.name, is_active=client.is_active), balances=balances,
        invoices=summaries(db, tenant, invoices),
        payments=[
            PaymentWithInvoice(**{**PaymentResponse.model_validate(p).model_dump(), "reversed": p.id in reversed_of}, invoice_number=number or "")
            for p, number in payments
        ],
    )


# --- listing -------------------------------------------------------------------------------------------------------------------------------
def search_filter(pattern: str):
    return or_(Invoice.number.ilike(pattern, escape="\\"), Invoice.client_name.ilike(pattern, escape="\\"), Client.name.ilike(pattern, escape="\\"), Invoice.notes.ilike(pattern, escape="\\"))
