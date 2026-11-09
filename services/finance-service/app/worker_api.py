"""One synchronisation pass, on request, for a SCHEDULER.

The Finance Service normally keeps itself up to date with a background thread (see `Worker` in app/sync.py). A serverless function cannot run such a thread
reliably, so on Vercel a schedule calls this route instead (through the dashboard's /api/cron/finance-sync, which holds the binding to this service). It does
exactly what one turn of the loop does (`sync.run_cycle`): pull the Sales and Purchasing feeds for every organization that has Finance and post what is due,
each fact exactly once. It is safe to call as often as you like and from several places at once: posting is idempotent.

The caller proves itself with the shared secret MODULE_INTERNAL_API_KEY (no user is logged in), the same secret the feeds themselves use. It is not part of the
public API (it is not in the OpenAPI document).
"""
import hmac
import os
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session, sessionmaker

from app import sync
from app.database import get_db

router = APIRouter(include_in_schema=False)


def require_internal_key(x_internal_key: Optional[str] = Header(default=None)) -> None:
    expected = os.getenv("MODULE_INTERNAL_API_KEY", "")
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Service authentication is not configured")
    if not x_internal_key or not hmac.compare_digest(x_internal_key.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid service credentials")


@router.post("/internal/v1/finance/sync-cycle", dependencies=[Depends(require_internal_key)])
def run_sync_cycle(request: Request, db: Session = Depends(get_db)):
    client = getattr(request.app.state, "feed_client", None)
    if client is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Synchronisation is not configured.")
    factory = sessionmaker(bind=db.get_bind(), autoflush=False, expire_on_commit=False)
    return {"organizations": sync.run_cycle(factory, client)}
