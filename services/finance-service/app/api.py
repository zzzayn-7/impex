"""The Finance API. Every route depends on `finance_tenant` (an ACTIVE organization administrator whose organization has completed setup and has the
Finance module enabled); none accepts an organization id - the tenant comes only from the authenticated context.
"""
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app import chart, expenses as expense_service, ledger, sync
from app.auth import TenantContext, require_active_tenant
from app.common import Actor, attach_request, audit, claim_request, conflict, idempotency_key_value
from app.database import get_db
from app.models import Account, Expense, FinanceEvent, JournalEntry, JournalLine, SyncEvent, SyncSource
from app.schemas import (
    AccountCreate, AccountOut, AccountUpdate, CurrencyTotals, EntryCreate, EntryDetail, EntryPage, EntrySummary, EntryUpdate, ExpenseCreate, ExpenseDetail, ExpenseOut,
    ExpensePage, ExpenseUpdate, Overview, ReverseRequest, SyncEventOut, SyncEventPage, SyncSourceOut, SyncSummary,
)
from app.search import like_pattern
from app.tenancy import scoped_count, scoped_select

router = APIRouter(prefix="/api/v1/finance")


def finance_tenant(request: Request, tenant: TenantContext = Depends(require_active_tenant), db: Session = Depends(get_db)) -> TenantContext:
    """The authenticated, entitled tenant - with Finance set up for it (the starter chart exists) before any route runs."""
    if chart.activated_at(db, tenant.organization_id) is None:
        enabled_at = None
        client = getattr(request.app.state, "feed_client", None)
        if client is not None:  # best effort: the cut-over is when the Super Admin switched Finance on, not when somebody first opened it
            try:
                for item in client.organizations():
                    if str(item.get("organization_id")) == str(tenant.organization_id):
                        enabled_at = sync._parse_time(item["enabled_at"])
            except Exception:
                enabled_at = None
        chart.ensure_setup(db, tenant.organization_id, enabled_at)
    return tenant


Tenant = Depends(finance_tenant)


def idempotency_key(key: Optional[str] = Header(default=None, alias="Idempotency-Key")) -> str:
    return idempotency_key_value(key)


# =====================================================================================================
# Accounts
# =====================================================================================================
def _account_out(account: Account, used: set) -> AccountOut:
    out = AccountOut.model_validate(account)
    out.has_postings = account.id in used
    return out


@router.get("/accounts", response_model=List[AccountOut], tags=["Accounts"])
def list_accounts(
    account_type: Optional[Literal["asset", "liability", "equity", "revenue", "expense"]] = Query(default=None, alias="type"), active: Optional[bool] = None,
    q: Optional[str] = Query(default=None, max_length=100), tenant: TenantContext = Tenant, db: Session = Depends(get_db),
):
    used = chart.used_account_ids(db, tenant.organization_id)
    return [_account_out(a, used) for a in chart.list_accounts(db, tenant, account_type=account_type, active=active, q=q)]


@router.post("/accounts", response_model=AccountOut, status_code=status.HTTP_201_CREATED, tags=["Accounts"])
def create_account(payload: AccountCreate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return _account_out(chart.create_account(db, tenant, Actor.of(tenant), payload), set())


@router.get("/accounts/{account_id}", response_model=AccountOut, tags=["Accounts"])
def get_account(account_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    account = chart.get_account_or_404(db, tenant, account_id)
    return _account_out(account, chart.used_account_ids(db, tenant.organization_id))


@router.patch("/accounts/{account_id}", response_model=AccountOut, tags=["Accounts"])
def update_account(account_id: uuid.UUID, payload: AccountUpdate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    account = chart.update_account(db, tenant, Actor.of(tenant), account_id, payload)
    return _account_out(account, chart.used_account_ids(db, tenant.organization_id))


@router.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["Accounts"])
def delete_account(account_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    chart.delete_account(db, tenant, Actor.of(tenant), account_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# =====================================================================================================
# Journal entries
# =====================================================================================================
def _summary(db: Session, tenant: TenantContext, entries: List[JournalEntry]) -> List[EntrySummary]:
    reversed_map = ledger.reversed_by(db, tenant.organization_id, [e.id for e in entries])
    out = []
    for entry in entries:
        item = EntrySummary.model_validate(entry)
        item.reversed_by_entry_id = reversed_map.get(entry.id)
        out.append(item)
    return out


def _detail(db: Session, tenant: TenantContext, entry: JournalEntry) -> EntryDetail:
    return EntryDetail.model_validate(ledger.detail_dict(db, tenant, entry))


@router.get("/journal-entries", response_model=EntryPage, tags=["Journal"])
def list_entries(
    status_filter: Optional[Literal["draft", "posted"]] = Query(default=None, alias="status"),
    source: Optional[Literal["manual", "expense", "sales", "purchasing", "reversal"]] = None,
    currency: Optional[str] = Query(default=None, min_length=3, max_length=3), account_id: Optional[uuid.UUID] = None, date_from: Optional[date] = None, date_to: Optional[date] = None,
    q: Optional[str] = Query(default=None, max_length=100), limit: int = Query(default=25, ge=1, le=200), offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant, db: Session = Depends(get_db),
):
    filters = [JournalEntry.organization_id == tenant.organization_id]
    if status_filter:
        filters.append(JournalEntry.status == status_filter)
    if source:
        filters.append(JournalEntry.source_type == source)
    if currency:
        filters.append(JournalEntry.currency_code == currency.upper())
    if date_from:
        filters.append(JournalEntry.entry_date >= date_from)
    if date_to:
        filters.append(JournalEntry.entry_date <= date_to)
    if account_id:
        filters.append(JournalEntry.id.in_(select(JournalLine.entry_id).where(JournalLine.organization_id == tenant.organization_id, JournalLine.account_id == account_id)))
    if q:
        pattern = like_pattern(q)
        filters.append(JournalEntry.description.ilike(pattern, escape="\\") | JournalEntry.entry_number.ilike(pattern, escape="\\") | JournalEntry.reference.ilike(pattern, escape="\\") | JournalEntry.source_summary.ilike(pattern, escape="\\"))
    total = db.scalar(select(func.count()).select_from(JournalEntry).where(*filters))
    rows = list(db.scalars(select(JournalEntry).where(*filters).order_by(JournalEntry.entry_date.desc(), JournalEntry.created_at.desc(), JournalEntry.id).limit(limit).offset(offset)))
    return EntryPage(items=_summary(db, tenant, rows), total=total, limit=limit, offset=offset)


@router.post("/journal-entries", response_model=EntryDetail, status_code=status.HTTP_201_CREATED, tags=["Journal"])
def create_entry(payload: EntryCreate, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Create a journal entry as a draft, or post it straight away (`post: true`; it must balance). The first request answers 201; a retry with the same
    Idempotency-Key and body answers 200 with the same entry and creates nothing."""
    replayed = claim_request(db, tenant, key, "journal_entry", payload)
    if replayed is not None:
        response.status_code = status.HTTP_200_OK
        return _detail(db, tenant, ledger.get_entry_or_404(db, tenant, replayed))
    actor = Actor.of(tenant)
    try:
        specs = ledger.checked_lines(db, tenant.organization_id, payload.lines)
        currency = payload.currency_code or tenant.default_currency
        if payload.post:
            ledger.require_postable(specs, currency)
        entry = ledger.create_entry(db, tenant.organization_id, actor, entry_date=payload.entry_date, description=payload.description, reference=payload.reference, currency=currency, specs=specs, post=payload.post)
        attach_request(db, tenant, key, entry.id)
        db.commit()
    except HTTPException:
        db.rollback()  # a refused request releases its key
        raise
    except Exception as exc:
        db.rollback()
        if hasattr(exc, "orig"):
            raise ledger.database_refusal(exc)
        raise
    db.refresh(entry)
    return _detail(db, tenant, entry)


@router.get("/journal-entries/{entry_id}", response_model=EntryDetail, tags=["Journal"])
def get_entry(entry_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return _detail(db, tenant, ledger.get_entry_or_404(db, tenant, entry_id))


@router.put("/journal-entries/{entry_id}", response_model=EntryDetail, tags=["Journal"])
def update_entry(entry_id: uuid.UUID, payload: EntryUpdate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Replace a DRAFT. A posted entry can never be edited: reverse it instead."""
    return _detail(db, tenant, ledger.update_draft(db, tenant, Actor.of(tenant), entry_id, payload))


@router.delete("/journal-entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["Journal"])
def discard_entry(entry_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    ledger.discard_draft(db, tenant, Actor.of(tenant), entry_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/journal-entries/{entry_id}/post", response_model=EntryDetail, tags=["Journal"])
def post_entry(entry_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Post a draft: it must balance (per currency, to 0.0001). Posting twice answers 409 and changes nothing."""
    return _detail(db, tenant, ledger.post_from_request(db, tenant, Actor.of(tenant), entry_id))


@router.post("/journal-entries/{entry_id}/reverse", response_model=EntryDetail, status_code=status.HTTP_201_CREATED, tags=["Journal"])
def reverse_entry(entry_id: uuid.UUID, payload: ReverseRequest, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Correct a posted entry by posting its exact mirror image, linked to it. Returns the reversing entry. The original is not changed."""
    return _detail(db, tenant, ledger.reverse_from_request(db, tenant, Actor.of(tenant), entry_id, payload))


# =====================================================================================================
# Expenses
# =====================================================================================================
def _expense_out(db: Session, tenant: TenantContext, expense: Expense) -> ExpenseOut:
    account = chart.get_account_or_404(db, tenant, expense.account_id)
    return ExpenseOut.model_validate(expense_service.expense_dict(expense, account))


def _expense_detail(db: Session, tenant: TenantContext, expense: Expense) -> ExpenseDetail:
    account = chart.get_account_or_404(db, tenant, expense.account_id)
    data = expense_service.expense_dict(expense, account)
    data["history"] = ledger.history(db, tenant.organization_id, expense.id)
    return ExpenseDetail.model_validate(data)


@router.get("/expenses", response_model=ExpensePage, tags=["Expenses"])
def list_expenses(
    status_filter: Optional[Literal["draft", "posted", "reversed"]] = Query(default=None, alias="status"), account_id: Optional[uuid.UUID] = None,
    currency: Optional[str] = Query(default=None, min_length=3, max_length=3), date_from: Optional[date] = None, date_to: Optional[date] = None,
    q: Optional[str] = Query(default=None, max_length=100), limit: int = Query(default=25, ge=1, le=200), offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant, db: Session = Depends(get_db),
):
    filters = []
    if status_filter:
        filters.append(Expense.status == status_filter)
    if account_id:
        filters.append(Expense.account_id == account_id)
    if currency:
        filters.append(Expense.currency_code == currency.upper())
    if date_from:
        filters.append(Expense.expense_date >= date_from)
    if date_to:
        filters.append(Expense.expense_date <= date_to)
    if q:
        pattern = like_pattern(q)
        filters.append(Expense.description.ilike(pattern, escape="\\") | Expense.number.ilike(pattern, escape="\\") | Expense.reference.ilike(pattern, escape="\\") | Expense.vendor.ilike(pattern, escape="\\"))
    total, rows = expense_service.list_expenses(db, tenant, filters=filters, limit=limit, offset=offset)
    return ExpensePage(items=[ExpenseOut.model_validate(expense_service.expense_dict(e, a)) for e, a in rows], total=total, limit=limit, offset=offset)


@router.post("/expenses", response_model=ExpenseDetail, status_code=status.HTTP_201_CREATED, tags=["Expenses"])
def create_expense(payload: ExpenseCreate, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Record an expense as a draft, or post it straight away (`post: true`). Recording an expense moves no money. A retry with the same Idempotency-Key
    answers 200 with the same expense."""
    replayed = claim_request(db, tenant, key, "expense", payload)
    if replayed is not None:
        response.status_code = status.HTTP_200_OK
        return _expense_detail(db, tenant, expense_service.get_expense_or_404(db, tenant, replayed))
    try:
        expense = expense_service.create_expense(db, tenant, Actor.of(tenant), payload, request_key=key)
    except HTTPException:
        db.rollback()
        raise
    return _expense_detail(db, tenant, expense)


@router.get("/expenses/{expense_id}", response_model=ExpenseDetail, tags=["Expenses"])
def get_expense(expense_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return _expense_detail(db, tenant, expense_service.get_expense_or_404(db, tenant, expense_id))


@router.put("/expenses/{expense_id}", response_model=ExpenseDetail, tags=["Expenses"])
def update_expense(expense_id: uuid.UUID, payload: ExpenseUpdate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return _expense_detail(db, tenant, expense_service.update_expense(db, tenant, Actor.of(tenant), expense_id, payload))


@router.delete("/expenses/{expense_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["Expenses"])
def delete_expense(expense_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    expense_service.delete_expense(db, tenant, Actor.of(tenant), expense_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/expenses/{expense_id}/post", response_model=ExpenseDetail, tags=["Expenses"])
def post_expense(expense_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return _expense_detail(db, tenant, expense_service.post_expense(db, tenant, Actor.of(tenant), expense_id))


@router.post("/expenses/{expense_id}/reverse", response_model=ExpenseDetail, tags=["Expenses"])
def reverse_expense(expense_id: uuid.UUID, payload: ReverseRequest, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return _expense_detail(db, tenant, expense_service.reverse_expense(db, tenant, Actor.of(tenant), expense_id, payload))


# =====================================================================================================
# Overview
# =====================================================================================================
SOURCES = ("sales", "purchasing")


def sync_summary(db: Session, organization_id: uuid.UUID) -> SyncSummary:
    rows = {r.source: r for r in db.scalars(select(SyncSource).where(SyncSource.organization_id == organization_id))}
    counts = dict(db.execute(select(SyncEvent.status, func.count()).where(SyncEvent.organization_id == organization_id).group_by(SyncEvent.status)).all())
    sources = [
        SyncSourceOut.model_validate(rows[s]) if s in rows else SyncSourceOut(source=s, status="idle", last_attempt_at=None, last_success_at=None, last_error=None, consecutive_failures=0)
        for s in SOURCES
    ]
    return SyncSummary(sources=sources, pending=counts.get("pending", 0), failed=counts.get("failed", 0), skipped=counts.get("skipped", 0), posted=counts.get("posted", 0))


@router.get("/overview", response_model=Overview, tags=["Overview"])
def overview(tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """A first look at the books: counts, the net position per account type IN EACH CURRENCY SEPARATELY (never added together: no exchange rates exist
    here), the latest entries and the health of the Sales/Purchasing synchronisation. Full financial statements arrive in a later step."""
    org = tenant.organization_id
    per_type = db.execute(
        select(JournalEntry.currency_code, Account.account_type, func.coalesce(func.sum(JournalLine.debit), 0), func.coalesce(func.sum(JournalLine.credit), 0))
        .select_from(JournalLine)
        .join(JournalEntry, (JournalEntry.organization_id == JournalLine.organization_id) & (JournalEntry.id == JournalLine.entry_id))
        .join(Account, (Account.organization_id == JournalLine.organization_id) & (Account.id == JournalLine.account_id))
        .where(JournalLine.organization_id == org, JournalEntry.status == "posted").group_by(JournalEntry.currency_code, Account.account_type)
    ).all()
    posted_by_currency = dict(db.execute(select(JournalEntry.currency_code, func.count()).where(JournalEntry.organization_id == org, JournalEntry.status == "posted").group_by(JournalEntry.currency_code)).all())
    by_currency = {}
    for currency, kind, debit, credit in per_type:
        row = by_currency.setdefault(currency, {"assets": Decimal(0), "liabilities": Decimal(0), "equity": Decimal(0), "revenue": Decimal(0), "expenses": Decimal(0)})
        net_debit = Decimal(debit) - Decimal(credit)
        key, value = {"asset": ("assets", net_debit), "expense": ("expenses", net_debit), "liability": ("liabilities", -net_debit), "equity": ("equity", -net_debit), "revenue": ("revenue", -net_debit)}[kind]
        row[key] += value
    totals = [CurrencyTotals(currency_code=c, posted_entries=posted_by_currency.get(c, 0), **{k: v.quantize(ledger.QUANT) for k, v in values.items()}) for c, values in sorted(by_currency.items())]
    entry_counts = dict(db.execute(select(JournalEntry.status, func.count()).where(JournalEntry.organization_id == org).group_by(JournalEntry.status)).all())
    expense_counts = dict(db.execute(select(Expense.status, func.count()).where(Expense.organization_id == org).group_by(Expense.status)).all())
    account_count = db.scalar(scoped_count(Account, tenant))
    active_count = db.scalar(scoped_count(Account, tenant, Account.is_active.is_(True)))
    recent = list(db.scalars(select(JournalEntry).where(JournalEntry.organization_id == org).order_by(JournalEntry.created_at.desc(), JournalEntry.id).limit(8)))
    return Overview(
        default_currency=tenant.default_currency, activated_at=chart.activated_at(db, org), accounts=account_count, active_accounts=active_count,
        draft_entries=entry_counts.get("draft", 0), posted_entries=entry_counts.get("posted", 0), draft_expenses=expense_counts.get("draft", 0),
        posted_expenses=expense_counts.get("posted", 0), totals_by_currency=totals, recent_entries=_summary(db, tenant, recent), sync=sync_summary(db, org),
    )


# =====================================================================================================
# Synchronisation with Sales and Purchasing
# =====================================================================================================
@router.get("/sync/events", response_model=SyncEventPage, tags=["Synchronisation"])
def sync_events(
    status_filter: Optional[Literal["pending", "posted", "skipped", "failed"]] = Query(default=None, alias="status"), limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0), tenant: TenantContext = Tenant, db: Session = Depends(get_db),
):
    filters = [SyncEvent.organization_id == tenant.organization_id]
    if status_filter:
        filters.append(SyncEvent.status == status_filter)
    total = db.scalar(select(func.count()).select_from(SyncEvent).where(*filters))
    rows = db.scalars(select(SyncEvent).where(*filters).order_by(SyncEvent.event_time.desc(), SyncEvent.id).limit(limit).offset(offset))
    return SyncEventPage(items=[SyncEventOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset)


@router.post("/sync/events/{event_id}/retry", response_model=SyncEventOut, tags=["Synchronisation"])
def retry_event(event_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Give a FAILED event another go (after fixing whatever stopped it). It is posted at most once, however often this is called."""
    event = db.scalar(scoped_select(SyncEvent, tenant).where(SyncEvent.id == event_id).with_for_update())
    if event is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Event not found.")
    if event.status != "failed":
        raise conflict("not_failed", "Only a failed event can be retried.")
    event.status, event.attempts, event.last_error, event.next_retry_at = "pending", 0, None, datetime.now(timezone.utc)
    audit(db, tenant.organization_id, "sync", event.id, "event_retried", Actor.of(tenant), event.event_key)
    db.commit()
    return SyncEventOut.model_validate(event)


@router.post("/sync/run", tags=["Synchronisation"])
def run_sync(request: Request, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Pull and post this organization's Sales and Purchasing events now (the background worker does the same every few seconds)."""
    client = getattr(request.app.state, "feed_client", None)
    if client is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Synchronisation is not configured.")
    return sync.sync_organization(sessionmaker(bind=db.get_bind(), autoflush=False, expire_on_commit=False), client, tenant.organization_id)
