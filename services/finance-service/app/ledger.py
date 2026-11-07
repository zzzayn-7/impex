"""The double-entry journal.

  * An entry has ONE currency and 2+ lines; each line is exactly one debit or one credit; debits equal credits to the last 0.0001.
  * It is created as a DRAFT (editable, discardable) and POSTED in one transaction: the entry is locked, numbered (JE-000001 ...; posted numbers
    have no gaps), totalled and marked posted. From then on it is IMMUTABLE - the database refuses any UPDATE or DELETE of it and its lines.
  * A mistake is corrected only by a REVERSAL: a new posted entry that is the exact mirror image (debits and credits swapped), linked to the
    original, with a reason. The original stays exactly as it was. An entry can be reversed once; a reversal cannot itself be reversed.
  * Nothing here converts between currencies or adds amounts of different currencies together.
  * Every change writes an audit line in the same transaction.

Locking order, always: the entry (or expense) first, then the numbering counter. One order everywhere means no deadlock.
"""
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

from app.auth import TenantContext
from app.common import Actor, audit, conflict, next_number, unprocessable
from app.models import Account, FinanceEvent, JournalEntry, JournalLine
from app.tenancy import scoped_select

ZERO = Decimal("0.0000")
QUANT = Decimal("0.0001")

# (account id, debit, credit, description)
LineSpec = Tuple[uuid.UUID, Decimal, Decimal, Optional[str]]


def quantize(value: Decimal) -> Decimal:
    return value.quantize(QUANT)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def database_refusal(exc: DBAPIError) -> HTTPException:
    """Translate a rule the DATABASE enforced (it is the last line of defence) into a clear response."""
    text = str(exc.orig) if exc.orig is not None else str(exc)
    if "uq_journal_entries_organization_id_source_key" in text:
        return conflict("duplicate_source", "This financial event has already been posted.")
    if "uq_journal_entries_organization_id_reverses_entry_id" in text:
        return conflict("already_reversed", "This entry has already been reversed.")
    for phrase in ("must be equal to post", "at least two lines", "must have an amount", "inactive account", "can never be", "mirror image", "cannot itself be reversed", "Only a posted entry"):
        if phrase in text:
            return conflict("rule_violation", text.split("ERROR:")[-1].splitlines()[0].strip())
    return conflict("rule_violation", "The journal rules refused this change.")


# --- loading ---------------------------------------------------------------------------------------------------------------------------
def get_entry_or_404(db: Session, tenant: TenantContext, entry_id: uuid.UUID, *, lock: bool = False) -> JournalEntry:
    query = scoped_select(JournalEntry, tenant).where(JournalEntry.id == entry_id)
    entry = db.scalar(query.with_for_update() if lock else query)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Journal entry not found.")
    return entry


def lines_of(db: Session, organization_id: uuid.UUID, entry_id: uuid.UUID) -> List[Tuple[JournalLine, Account]]:
    return list(db.execute(
        select(JournalLine, Account)
        .join(Account, (Account.organization_id == JournalLine.organization_id) & (Account.id == JournalLine.account_id))
        .where(JournalLine.organization_id == organization_id, JournalLine.entry_id == entry_id)
        .order_by(JournalLine.line_no)
    ).all())


def reversal_of(db: Session, organization_id: uuid.UUID, entry_id: uuid.UUID) -> Optional[JournalEntry]:
    return db.scalar(select(JournalEntry).where(JournalEntry.organization_id == organization_id, JournalEntry.reverses_entry_id == entry_id))


# --- validation ------------------------------------------------------------------------------------------------------------------------
def checked_lines(db: Session, organization_id: uuid.UUID, lines: Iterable) -> List[LineSpec]:
    """Each line is exactly one side with an amount, on an existing ACTIVE account of THIS organization (an unknown or another tenant's
    account is simply 'not found')."""
    specs: List[LineSpec] = []
    ids = set()
    items = list(lines)
    for position, line in enumerate(items, start=1):
        debit, credit = quantize(line.debit), quantize(line.credit)
        if (debit > 0) == (credit > 0):
            raise unprocessable("invalid_line", f"Line {position}: enter either a debit or a credit amount, not both and not neither.", line=position)
        specs.append((line.account_id, debit, credit, line.description))
        ids.add(line.account_id)
    if ids:
        found = {a.id: a for a in db.scalars(select(Account).where(Account.organization_id == organization_id, Account.id.in_(ids)))}
        for position, (account_id, *_rest) in enumerate(specs, start=1):
            account = found.get(account_id)
            if account is None:
                raise unprocessable("unknown_account", f"Line {position}: this account does not exist.", line=position)
            if not account.is_active:
                raise unprocessable("inactive_account", f"Line {position}: {account.code} {account.name} is inactive and cannot be posted to.", line=position)
    return specs


def totals(specs: Sequence[LineSpec]) -> Tuple[Decimal, Decimal]:
    return sum((s[1] for s in specs), ZERO), sum((s[2] for s in specs), ZERO)


def require_postable(specs: Sequence[LineSpec], currency: str) -> Decimal:
    if len(specs) < 2:
        raise unprocessable("too_few_lines", "A journal entry needs at least two lines.")
    debits, credits = totals(specs)
    if debits != credits:
        raise unprocessable("unbalanced", f"The entry does not balance: debits {debits} {currency}, credits {credits} {currency}. The difference is {abs(debits - credits)} {currency}.", debits=format(debits, "f"), credits=format(credits, "f"))
    if debits <= 0:
        raise unprocessable("no_amount", "A journal entry must have an amount.")
    return debits


# --- writing ---------------------------------------------------------------------------------------------------------------------------
def _write_lines(db: Session, organization_id: uuid.UUID, entry_id: uuid.UUID, specs: Sequence[LineSpec]) -> None:
    for position, (account_id, debit, credit, description) in enumerate(specs, start=1):
        db.add(JournalLine(organization_id=organization_id, entry_id=entry_id, line_no=position, account_id=account_id, debit=debit, credit=credit, description=description))
    db.flush()


def create_entry(
    db: Session, organization_id: uuid.UUID, actor: Actor, *, entry_date: date, description: str, currency: str, specs: Sequence[LineSpec], reference: Optional[str] = None,
    source_type: str = "manual", source_key: Optional[str] = None, source_summary: Optional[str] = None, post: bool = False,
) -> JournalEntry:
    """Add a draft (and post it when asked) to the caller's transaction. The caller commits."""
    entry = JournalEntry(
        organization_id=organization_id, entry_date=entry_date, description=description, reference=reference, currency_code=currency, status="draft", source_type=source_type,
        source_key=source_key, source_summary=source_summary, created_by=actor.user_id, created_by_email=actor.email,
    )
    db.add(entry)
    db.flush()
    _write_lines(db, organization_id, entry.id, specs)
    audit(db, organization_id, "journal_entry", entry.id, "created", actor, f"{source_type} entry, {currency}" + (f", {source_summary}" if source_summary else ""))
    if post:
        post_locked(db, entry, actor)
    return entry


def post_locked(db: Session, entry: JournalEntry, actor: Actor) -> JournalEntry:
    """Post a DRAFT entry that the caller has locked (or just created). Balanced, numbered, totalled, marked posted - or an error and nothing."""
    if entry.status != "draft":
        raise conflict("already_posted", "This journal entry is already posted.")
    rows = lines_of(db, entry.organization_id, entry.id)
    specs = [(line.account_id, line.debit, line.credit, line.description) for line, _account in rows]
    total = require_postable(specs, entry.currency_code)
    for position, (line, account) in enumerate(rows, start=1):
        if not account.is_active:
            raise unprocessable("inactive_account", f"Line {position}: {account.code} {account.name} is inactive and cannot be posted to.", line=position)
    entry.entry_number = next_number(db, entry.organization_id, "journal", "JE")
    entry.total = total
    entry.status = "posted"
    entry.posted_at = _now()
    entry.posted_by, entry.posted_by_email = actor.user_id, actor.email
    db.flush()  # the database re-checks balance, line count, active accounts and (for a reversal) the mirror image here
    audit(db, entry.organization_id, "journal_entry", entry.id, "posted", actor, f"{entry.entry_number}, total {format(total, 'f')} {entry.currency_code}")
    return entry


def reverse_posted(db: Session, original: JournalEntry, actor: Actor, *, reason: str, entry_date: Optional[date] = None, source_key: Optional[str] = None, source_summary: Optional[str] = None) -> JournalEntry:
    """Post the exact mirror image of a POSTED entry (that the caller has locked), linked to it. The original is not touched."""
    if original.status != "posted":
        raise conflict("not_posted", "Only a posted entry can be reversed. Discard a draft instead.")
    if original.source_type == "reversal":
        raise conflict("not_reversible", "A reversal cannot itself be reversed. Post a new entry instead.")
    existing = reversal_of(db, original.organization_id, original.id)
    if existing is not None:
        raise conflict("already_reversed", f"This entry was already reversed by {existing.entry_number}.", reversal_entry_id=str(existing.id))
    mirrored: List[LineSpec] = [(line.account_id, line.credit, line.debit, line.description) for line, _account in lines_of(db, original.organization_id, original.id)]
    reversal = JournalEntry(
        organization_id=original.organization_id, entry_date=entry_date or _now().date(), description=f"Reversal of {original.entry_number}: {original.description}"[:500],
        reference=original.entry_number, currency_code=original.currency_code, status="draft", source_type="reversal", source_key=source_key, source_summary=source_summary,
        reverses_entry_id=original.id, reversal_reason=reason, created_by=actor.user_id, created_by_email=actor.email,
    )
    db.add(reversal)
    db.flush()
    _write_lines(db, original.organization_id, reversal.id, mirrored)
    audit(db, original.organization_id, "journal_entry", reversal.id, "created", actor, f"reversal of {original.entry_number}")
    post_locked(db, reversal, actor)
    audit(db, original.organization_id, "journal_entry", original.id, "reversed", actor, f"by {reversal.entry_number}: {reason}")
    return reversal


# --- API operations (each commits or rolls back as one unit) ---------------------------------------------------------------------------
def create_from_request(db: Session, tenant: TenantContext, actor: Actor, payload) -> JournalEntry:
    specs = checked_lines(db, tenant.organization_id, payload.lines)
    currency = payload.currency_code or tenant.default_currency
    if payload.post:
        require_postable(specs, currency)
    try:
        entry = create_entry(db, tenant.organization_id, actor, entry_date=payload.entry_date, description=payload.description, reference=payload.reference, currency=currency, specs=specs, post=payload.post)
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(entry)
    return entry


def update_draft(db: Session, tenant: TenantContext, actor: Actor, entry_id: uuid.UUID, payload) -> JournalEntry:
    entry = get_entry_or_404(db, tenant, entry_id, lock=True)
    if entry.status != "draft":
        raise conflict("not_editable", "A posted journal entry can never be edited. Reverse it and post a corrected one.")
    specs = checked_lines(db, tenant.organization_id, payload.lines)
    try:
        db.execute(delete(JournalLine).where(JournalLine.organization_id == tenant.organization_id, JournalLine.entry_id == entry.id))
        entry.entry_date, entry.description, entry.reference, entry.currency_code = payload.entry_date, payload.description, payload.reference, payload.currency_code
        db.flush()
        _write_lines(db, tenant.organization_id, entry.id, specs)
        audit(db, tenant.organization_id, "journal_entry", entry.id, "updated", actor, f"draft edited, {len(specs)} lines")
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(entry)
    return entry


def discard_draft(db: Session, tenant: TenantContext, actor: Actor, entry_id: uuid.UUID) -> None:
    entry = get_entry_or_404(db, tenant, entry_id, lock=True)
    if entry.status != "draft":
        raise conflict("not_editable", "A posted journal entry can never be deleted. Reverse it instead.")
    try:
        db.delete(entry)
        db.flush()
        audit(db, tenant.organization_id, "journal_entry", entry.id, "draft_discarded", actor, entry.description[:200])
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise database_refusal(exc)


def post_from_request(db: Session, tenant: TenantContext, actor: Actor, entry_id: uuid.UUID) -> JournalEntry:
    entry = get_entry_or_404(db, tenant, entry_id, lock=True)  # a second concurrent post waits here, then finds it posted
    try:
        post_locked(db, entry, actor)
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(entry)
    return entry


def reverse_from_request(db: Session, tenant: TenantContext, actor: Actor, entry_id: uuid.UUID, payload) -> JournalEntry:
    original = get_entry_or_404(db, tenant, entry_id, lock=True)  # two concurrent reversals: the second waits, then is told it was already reversed
    if original.source_type == "expense":
        raise conflict("reverse_via_expense", "This entry belongs to an expense. Reverse the expense instead, so the expense and the books stay in step.")
    try:
        reversal = reverse_posted(db, original, actor, reason=payload.reason, entry_date=payload.entry_date)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise database_refusal(exc)
    except DBAPIError as exc:
        db.rollback()
        raise database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(reversal)
    return reversal


# --- reading ---------------------------------------------------------------------------------------------------------------------------
def reversed_by(db: Session, organization_id: uuid.UUID, entry_ids: Sequence[uuid.UUID]) -> dict:
    if not entry_ids:
        return {}
    rows = db.execute(select(JournalEntry.reverses_entry_id, JournalEntry.id).where(JournalEntry.organization_id == organization_id, JournalEntry.reverses_entry_id.in_(entry_ids))).all()
    return {original: reversal for original, reversal in rows}


def history(db: Session, organization_id: uuid.UUID, entity_id: uuid.UUID) -> List[FinanceEvent]:
    return list(db.scalars(select(FinanceEvent).where(FinanceEvent.organization_id == organization_id, FinanceEvent.entity_id == entity_id).order_by(FinanceEvent.seq)))


def detail_dict(db: Session, tenant: TenantContext, entry: JournalEntry) -> dict:
    rows = lines_of(db, tenant.organization_id, entry.id)
    debits = sum((line.debit for line, _ in rows), ZERO)
    credits = sum((line.credit for line, _ in rows), ZERO)
    reversal = reversal_of(db, tenant.organization_id, entry.id)
    data = {column.key: getattr(entry, column.key) for column in JournalEntry.__table__.columns}
    data.update(
        reversed_by_entry_id=reversal.id if reversal else None, total_debit=debits, total_credit=credits, is_balanced=debits == credits and debits > 0,
        lines=[{"id": line.id, "line_no": line.line_no, "account_id": line.account_id, "account_code": account.code, "account_name": account.name, "debit": line.debit, "credit": line.credit, "description": line.description} for line, account in rows],
        history=history(db, tenant.organization_id, entry.id),
        can_reverse=entry.status == "posted" and entry.source_type not in ("reversal", "expense") and reversal is None,
    )
    return data
