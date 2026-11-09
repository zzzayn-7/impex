"""One pass of the e-mail outbox, on request, for a SCHEDULER.

Notification e-mails are queued in a durable outbox and sent by a background task (`run_worker` in app/outbox.py). A serverless function cannot run such a task
reliably, so on Vercel a schedule calls this route instead (through the dashboard's /api/cron/support-outbox, which holds the binding to this service). It does
exactly what one turn of the loop does (`process_batch`): claim what is due, send it, settle each message as sent / to retry / failed. Safe to call as often as
you like and from several places at once: a message is claimed by one caller only.

The caller proves itself with the shared secret MODULE_INTERNAL_API_KEY (no user is logged in). It is not part of the public API (not in the OpenAPI document).
"""
import hmac
import os
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.orm import Session, sessionmaker

from app import outbox
from app.database import get_db

router = APIRouter(include_in_schema=False)


def require_internal_key(x_internal_key: Optional[str] = Header(default=None)) -> None:
    expected = os.getenv("MODULE_INTERNAL_API_KEY", "")
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Service authentication is not configured")
    if not x_internal_key or not hmac.compare_digest(x_internal_key.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid service credentials")


@router.post("/internal/v1/support/outbox-run", dependencies=[Depends(require_internal_key)])
def run_outbox(limit: int = Query(default=25, ge=1, le=100), db: Session = Depends(get_db)):
    factory = sessionmaker(bind=db.get_bind(), autoflush=False, expire_on_commit=False)
    return outbox.process_batch(factory, limit)
