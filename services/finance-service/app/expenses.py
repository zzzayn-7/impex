"""Expenses: record a business cost, categorize it (an expense account), post it to the books, reverse it if it was wrong.

  * DRAFT: editable and deletable; nothing is in the books yet.
  * POSTED: one journal entry - debit the expense account, credit the system account "Accrued Expenses Payable". The expense is now immutable.
  * REVERSED: a mirror-image entry cancels it; the expense and both entries stay for the audit trail.

Recording an expense says that the cost was INCURRED and is owed until settled. It does not move money and implies no bank, cash or payment:
Finance has no bank integration, and the account it credits is a liability, not a bank balance.
"""
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app import ledger
from app.auth import TenantContext
from app.chart import system_account
from app.common import Actor, attach_request, audit, conflict, next_number, unprocessable
from app.models import Account, Expense
from app.tenancy import scoped_select


def get_expense_or_404(db: Session, tenant: TenantContext, expense_id: uuid.UUID, *, lock: bool = False) -> Expense:
    query = scoped_select(Expense, tenant).where(Expense.id == expense_id)
    expense = db.scalar(query.with_for_update() if lock else query)
    if expense is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Expense not found.")
    return expense


def _expense_account(db: Session, organization_id: uuid.UUID, account_id: uuid.UUID) -> Account:
    account = db.scalar(select(Account).where(Account.organization_id == organization_id, Account.id == account_id))
    if account is None:
        raise unprocessable("unknown_account", "This account does not exist.")
    if account.account_type != "expense":
        raise unprocessable("not_an_expense_account", f"{account.code} {account.name} is not an expense account. Choose an expense category.")
    if not account.is_active:
        raise unprocessable("inactive_account", f"{account.code} {account.name} is inactive and cannot be used.")
    return account


def _post_locked(db: Session, expense: Expense, actor: Actor) -> None:
    account = _expense_account(db, expense.organization_id, expense.account_id)
    payable = system_account(db, expense.organization_id, "accrued_expenses")
    entry = ledger.create_entry(
        db, expense.organization_id, actor, entry_date=expense.expense_date, description=expense.description, reference=expense.reference or expense.number, currency=expense.currency_code,
        specs=[(account.id, expense.amount, ledger.ZERO, expense.vendor), (payable.id, ledger.ZERO, expense.amount, expense.vendor)],
        source_type="expense", source_key=f"expense:{expense.id}", source_summary=f"Expense {expense.number}", post=True,
    )
    expense.status, expense.journal_entry_id = "posted", entry.id
    expense.posted_at, expense.posted_by_email = datetime.now(timezone.utc), actor.email
    db.flush()
    audit(db, expense.organization_id, "expense", expense.id, "posted", actor, f"{entry.entry_number}, {format(expense.amount, 'f')} {expense.currency_code}")


def create_expense(db: Session, tenant: TenantContext, actor: Actor, payload, request_key: Optional[str] = None) -> Expense:
    _expense_account(db, tenant.organization_id, payload.account_id)
    expense = Expense(
        organization_id=tenant.organization_id, number=next_number(db, tenant.organization_id, "expense", "EXP"), expense_date=payload.expense_date, description=payload.description,
        reference=payload.reference, vendor=payload.vendor, account_id=payload.account_id, amount=ledger.quantize(payload.amount), currency_code=payload.currency_code or tenant.default_currency,
        status="draft", created_by=actor.user_id, created_by_email=actor.email or "",
    )
    try:
        db.add(expense)
        db.flush()
        audit(db, tenant.organization_id, "expense", expense.id, "created", actor, f"{expense.number}, {format(expense.amount, 'f')} {expense.currency_code}")
        if payload.post:
            _post_locked(db, expense, actor)
        if request_key:
            attach_request(db, tenant, request_key, expense.id)  # the key and the expense commit together
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise ledger.database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(expense)
    return expense


def update_expense(db: Session, tenant: TenantContext, actor: Actor, expense_id: uuid.UUID, payload) -> Expense:
    expense = get_expense_or_404(db, tenant, expense_id, lock=True)
    if expense.status != "draft":
        raise conflict("not_editable", "A posted expense can never be edited. Reverse it and record a corrected one.")
    _expense_account(db, tenant.organization_id, payload.account_id)
    expense.expense_date, expense.description, expense.reference, expense.vendor = payload.expense_date, payload.description, payload.reference, payload.vendor
    expense.account_id, expense.amount, expense.currency_code = payload.account_id, ledger.quantize(payload.amount), payload.currency_code
    try:
        db.flush()
        audit(db, tenant.organization_id, "expense", expense.id, "updated", actor, f"draft edited, {format(expense.amount, 'f')} {expense.currency_code}")
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise ledger.database_refusal(exc)
    db.refresh(expense)
    return expense


def delete_expense(db: Session, tenant: TenantContext, actor: Actor, expense_id: uuid.UUID) -> None:
    expense = get_expense_or_404(db, tenant, expense_id, lock=True)
    if expense.status != "draft":
        raise conflict("not_editable", "A posted expense can never be deleted. Reverse it instead.")
    number = expense.number
    try:
        db.delete(expense)
        db.flush()
        audit(db, tenant.organization_id, "expense", expense_id, "draft_discarded", actor, number)
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise ledger.database_refusal(exc)


def post_expense(db: Session, tenant: TenantContext, actor: Actor, expense_id: uuid.UUID) -> Expense:
    expense = get_expense_or_404(db, tenant, expense_id, lock=True)  # a second concurrent post waits, then finds it posted
    if expense.status != "draft":
        raise conflict("already_posted", "This expense is already posted.")
    try:
        _post_locked(db, expense, actor)
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise ledger.database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(expense)
    return expense


def reverse_expense(db: Session, tenant: TenantContext, actor: Actor, expense_id: uuid.UUID, payload) -> Expense:
    expense = get_expense_or_404(db, tenant, expense_id, lock=True)
    if expense.status == "reversed":
        raise conflict("already_reversed", "This expense was already reversed.")
    if expense.status != "posted" or expense.journal_entry_id is None:
        raise conflict("not_posted", "Only a posted expense can be reversed. Delete a draft instead.")
    original = ledger.get_entry_or_404(db, tenant, expense.journal_entry_id, lock=True)
    try:
        reversal = ledger.reverse_posted(db, original, actor, reason=payload.reason, entry_date=payload.entry_date, source_summary=f"Reversal of expense {expense.number}")
        expense.status, expense.reversal_entry_id, expense.reversal_reason = "reversed", reversal.id, payload.reason
        expense.reversed_at, expense.reversed_by_email = datetime.now(timezone.utc), actor.email
        db.flush()
        audit(db, tenant.organization_id, "expense", expense.id, "reversed", actor, f"{reversal.entry_number}: {payload.reason}")
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise ledger.database_refusal(exc)
    except Exception:
        db.rollback()
        raise
    db.refresh(expense)
    return expense


def expense_dict(expense: Expense, account: Account) -> dict:
    data = {column.key: getattr(expense, column.key) for column in Expense.__table__.columns}
    data.update(account_code=account.code, account_name=account.name)
    return data


def list_expenses(db: Session, tenant: TenantContext, *, filters: list, limit: int, offset: int):
    base = scoped_select(Expense, tenant)
    query = base.where(*filters)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.execute(
        select(Expense, Account).join(Account, (Account.organization_id == Expense.organization_id) & (Account.id == Expense.account_id))
        .where(Expense.organization_id == tenant.organization_id, *filters).order_by(Expense.expense_date.desc(), Expense.number.desc()).limit(limit).offset(offset)
    ).all()
    return total, rows
