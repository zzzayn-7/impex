"""The chart of accounts: the starter chart every organization gets on first use, and account management.

SYSTEM accounts are the ones Finance itself posts to (receivables, revenue, tax payable ...). They are found by a stable `system_key`, never by
their code or name, and the database refuses to delete, deactivate, re-type or re-code them. Everything else is the organization's own.
"""
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import HTTPException, status
from sqlalchemy import exists, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

from app.auth import TenantContext
from app.common import Actor, audit, conflict, unprocessable
from app.models import Account, Expense, FinanceOrganization, JournalLine
from app.tenancy import scoped_select

# (system_key, code, name, type, description) - the accounts Finance posts to.
SYSTEM_ACCOUNTS = (
    ("payments_received", "1050", "Payments Received", "asset", "Customer payments recorded in Sales. Recording a payment does not mean it has reached a bank account: reconcile it with your bank statement."),
    ("accounts_receivable", "1100", "Accounts Receivable", "asset", "What customers owe on issued invoices."),
    ("inventory", "1200", "Inventory", "asset", "Goods received into stock, valued at the purchase order price of what was accepted."),
    ("sales_tax_payable", "2100", "Sales Tax Payable", "liability", "Tax charged on issued invoices."),
    ("goods_received_not_invoiced", "2200", "Goods Received Not Invoiced", "liability", "Goods accepted from suppliers that have not been billed yet. Recognised when a goods receipt is confirmed - never from a purchase order alone."),
    ("accrued_expenses", "2300", "Accrued Expenses Payable", "liability", "Expenses recorded but not yet settled. Recording an expense does not move money."),
    ("opening_balance_equity", "3000", "Opening Balance Equity", "equity", "The balancing side of opening balances entered by hand."),
    ("sales_revenue", "4000", "Sales Revenue", "revenue", "Invoiced sales, net of discounts."),
)
# A starter set of expense categories (the organization's own: rename, deactivate or add as needed).
STARTER_ACCOUNTS = (
    ("5000", "General Expenses", "expense", "Anything that fits no other category."),
    ("5100", "Rent and Utilities", "expense", None),
    ("5200", "Salaries and Wages", "expense", None),
    ("5300", "Transport and Shipping", "expense", None),
    ("5400", "Office and Administration", "expense", None),
    ("5500", "Professional Fees", "expense", None),
)


def ensure_setup(db: Session, organization_id: uuid.UUID, activated_at: Optional[datetime] = None) -> bool:
    """Mark the organization as using Finance and give it the starter chart. Idempotent and race-safe: the unique key on the organization row
    makes a concurrent second caller wait for the first, then do nothing. Returns True when this call did the setup.

    `activated_at` is the cut-over for synchronisation: only Sales / Purchasing events dated AFTER it are posted (earlier history is not
    back-filled; an opening-balance entry is how a business brings it in)."""
    values = {"organization_id": organization_id}
    if activated_at is not None:
        values["activated_at"] = activated_at
    created = db.execute(pg_insert(FinanceOrganization).values(**values).on_conflict_do_nothing(index_elements=["organization_id"]).returning(FinanceOrganization.organization_id)).first()
    if created is None:
        db.rollback()
        return False
    for key, code, name, kind, description in SYSTEM_ACCOUNTS:
        db.add(Account(organization_id=organization_id, code=code, name=name, account_type=kind, description=description, is_system=True, system_key=key))
    for code, name, kind, description in STARTER_ACCOUNTS:
        db.add(Account(organization_id=organization_id, code=code, name=name, account_type=kind, description=description))
    audit(db, organization_id, "account", None, "chart_created", Actor.sync() if activated_at is not None else Actor(None, None, "user"), "Starter chart of accounts created")
    db.commit()
    return True


def activated_at(db: Session, organization_id: uuid.UUID) -> Optional[datetime]:
    return db.scalar(select(FinanceOrganization.activated_at).where(FinanceOrganization.organization_id == organization_id))


def system_account(db: Session, organization_id: uuid.UUID, key: str) -> Account:
    account = db.scalar(select(Account).where(Account.organization_id == organization_id, Account.system_key == key))
    if account is None:
        raise RuntimeError(f"System account {key} is missing for {organization_id}")  # cannot happen after ensure_setup: the database forbids deleting it
    return account


# --- management -----------------------------------------------------------------------------------------------------------------
def has_postings(db: Session, organization_id: uuid.UUID, account_id: uuid.UUID) -> bool:
    return bool(db.scalar(select(exists().where(JournalLine.organization_id == organization_id, JournalLine.account_id == account_id))))


def get_account_or_404(db: Session, tenant: TenantContext, account_id: uuid.UUID, *, lock: bool = False) -> Account:
    query = scoped_select(Account, tenant).where(Account.id == account_id)
    account = db.scalar(query.with_for_update() if lock else query)
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")
    return account


def list_accounts(db: Session, tenant: TenantContext, *, account_type: Optional[str], active: Optional[bool], q: Optional[str]) -> List[Account]:
    query = scoped_select(Account, tenant).order_by(Account.code)
    if account_type:
        query = query.where(Account.account_type == account_type)
    if active is not None:
        query = query.where(Account.is_active.is_(active))
    if q:
        pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.where(Account.code.ilike(pattern, escape="\\") | Account.name.ilike(pattern, escape="\\"))
    return list(db.scalars(query))


def used_account_ids(db: Session, organization_id: uuid.UUID) -> set:
    return set(db.scalars(select(JournalLine.account_id).where(JournalLine.organization_id == organization_id).distinct()))


def _refusal(exc: DBAPIError) -> HTTPException:
    text = str(exc.orig) if exc.orig is not None else ""
    if "uq_accounts_organization_id_code" in text:
        return conflict("duplicate_code", "Another account already uses this code.")
    for phrase in ("system account", "keeps its code and type"):
        if phrase in text:
            return conflict("account_protected", text.splitlines()[0].split("ERROR:")[-1].strip() or "This account is protected.")
    return conflict("account_conflict", "The account could not be saved.")


def create_account(db: Session, tenant: TenantContext, actor: Actor, payload) -> Account:
    account = Account(organization_id=tenant.organization_id, code=payload.code, name=payload.name, account_type=payload.account_type, description=payload.description, created_by=actor.user_id)
    db.add(account)
    try:
        db.flush()
        audit(db, tenant.organization_id, "account", account.id, "created", actor, f"{account.code} {account.name} ({account.account_type})")
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise _refusal(exc)
    db.refresh(account)
    return account


def update_account(db: Session, tenant: TenantContext, actor: Actor, account_id: uuid.UUID, payload) -> Account:
    account = get_account_or_404(db, tenant, account_id, lock=True)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise unprocessable("nothing_to_change", "Send at least one field to change.")
    if account.is_system:
        if changes.get("is_active") is False:
            raise conflict("account_protected", "A system account is used by Finance itself and cannot be deactivated.")
        for field in ("code", "account_type"):
            if field in changes and changes[field] != getattr(account, field):
                raise conflict("account_protected", "A system account keeps its code and type.")
    elif ("code" in changes and changes["code"] != account.code) or ("account_type" in changes and changes["account_type"] != account.account_type):
        if has_postings(db, tenant.organization_id, account.id):
            raise conflict("account_in_use", "This account already has postings, so its code and type can no longer change. Deactivate it and add a new account instead.")
    described = []
    for field, value in changes.items():
        if value is None and field in ("code", "name", "account_type", "is_active"):
            raise unprocessable("invalid_value", f"{field} cannot be empty.")
        if getattr(account, field) != value:
            described.append(f"{field}: {getattr(account, field)!r} -> {value!r}")
            setattr(account, field, value)
    if described:
        try:
            db.flush()
            audit(db, tenant.organization_id, "account", account.id, "reactivated" if changes.get("is_active") is True and len(described) == 1 else ("deactivated" if changes.get("is_active") is False and len(described) == 1 else "updated"), actor, "; ".join(described))
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise _refusal(exc)
        db.refresh(account)
    return account


def delete_account(db: Session, tenant: TenantContext, actor: Actor, account_id: uuid.UUID) -> None:
    account = get_account_or_404(db, tenant, account_id, lock=True)
    if account.is_system:
        raise conflict("account_protected", "A system account is used by Finance itself and cannot be deleted.")
    in_expenses = db.scalar(select(exists().where(Expense.organization_id == tenant.organization_id, Expense.account_id == account.id)))
    if has_postings(db, tenant.organization_id, account.id) or in_expenses:
        raise conflict("account_in_use", "This account is used by journal entries or expenses and cannot be deleted. Deactivate it instead.")
    detail = f"{account.code} {account.name}"
    try:
        db.delete(account)
        db.flush()
        audit(db, tenant.organization_id, "account", account.id, "deleted", actor, detail)
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        raise _refusal(exc)
