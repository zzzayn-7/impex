"""INTERNAL: delete EVERYTHING one organization owns in this service's database (the Super Admin deleting an organization from the CRM).

Called only by the Organization Service, which first locks the organization and only then asks every service in turn. The call carries a shared secret
(PURGE_API_KEY, falling back to the other internal keys in docker-compose), never a user's token; the route is hidden from the public documentation and is not
reachable from a browser. It is idempotent: purging an organization that has nothing here (or was already purged) deletes nothing and succeeds, so a deletion that
failed half way can simply be repeated.

What is deleted is decided by the schema, not by a list somebody has to remember: every table that has an `organization_id` column is emptied of that organization's
rows (children before parents, in one transaction: either all of it is deleted or none), plus the tables named in DERIVED below, which hold rows that belong to an
organization only through a parent row. A table that is in neither list makes the purge REFUSE to run (and a test fails), so a new table can never be left behind.

The append-only guards on the ledgers (stock movements, journal, issued invoices ...) are lifted for this one transaction with the out-of-band maintenance switch
(`app.allow_ledger_maintenance`) that the application itself never sets anywhere else.
"""
import hmac
import logging
import os
import uuid
from typing import Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy import delete, text
from sqlalchemy.orm import Session

from app import models  # noqa: F401  (registers every model on Base.metadata)
from app.database import Base, get_db

SERVICE = "purchasing"
logger = logging.getLogger("impex.purge")

# Tables that hold nothing of any organization (shared counters ...): never touched.
GLOBAL_TABLES = set()
# table -> SQL condition (with :org) for rows that belong to an organization only through a parent row.
DERIVED = {}

router = APIRouter(include_in_schema=False)


def require_purge_key(x_internal_key: Optional[str] = Header(default=None)) -> None:
    expected = os.getenv("PURGE_API_KEY", "")
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Service authentication is not configured")
    if not x_internal_key or not hmac.compare_digest(x_internal_key.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid service credentials")


def uncovered_tables() -> list:
    """Tables the purge would not know how to empty. Must always be empty (a test asserts it)."""
    return [t.name for t in Base.metadata.sorted_tables if "organization_id" not in t.c and t.name not in DERIVED and t.name not in GLOBAL_TABLES]


def purge_organization(db: Session, organization_id: uuid.UUID) -> Dict[str, int]:
    """Delete every row the organization owns here, in ONE transaction. Returns {table: rows deleted} for the tables that had any."""
    missing = uncovered_tables()
    if missing:
        raise RuntimeError(f"the organization purge does not cover these tables: {', '.join(missing)}")
    deleted: Dict[str, int] = {}
    try:
        db.execute(text("SET LOCAL app.allow_ledger_maintenance = 'on'"))
        for table in reversed(Base.metadata.sorted_tables):  # children before the parents they reference
            if table.name in GLOBAL_TABLES:
                continue
            if "organization_id" in table.c:
                statement = delete(table).where(table.c.organization_id == organization_id)
            else:
                statement = delete(table).where(text(DERIVED[table.name]).bindparams(org=organization_id))
            count = db.execute(statement).rowcount
            if count:
                deleted[table.name] = count
        db.commit()
    except Exception:
        db.rollback()  # all or nothing
        raise
    return deleted


@router.post("/internal/v1/organizations/{organization_id}/purge", dependencies=[Depends(require_purge_key)])
def purge(organization_id: uuid.UUID, db: Session = Depends(get_db)):
    try:
        deleted = purge_organization(db, organization_id)
    except Exception:  # noqa: BLE001
        logger.exception("purge of organization %s failed in %s", organization_id, SERVICE)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "The organization's data could not be deleted here. Nothing was changed.")
    logger.info("purged organization %s from %s: %s", organization_id, SERVICE, deleted)
    return {"service": SERVICE, "organization_id": str(organization_id), "deleted": deleted, "total": sum(deleted.values())}
