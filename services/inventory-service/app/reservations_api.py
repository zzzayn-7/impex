"""Stock reservation endpoints. Called by the Sales Service only.

Writing a reservation needs BOTH the administrator's own bearer token (so the organization is always the token's, never a request
field) AND (checked after the tenant, so the usual 401/403 come first) the shared secret RESERVATION_API_KEY in `X-Internal-Key` (so a browser, or any other client holding an administrator's
token, cannot book or release stock by inventing a sales order id). Reading is open to the organization's administrators.
"""
import hmac
import os
import re
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from sqlalchemy.orm import Session

from app import reservations
from app.auth import TenantContext, require_active_tenant
from app.database import get_db
from app.schemas import ReservationList, ReservationRelease, ReservationResult, ReservationSet

router = APIRouter(prefix="/api/v1/inventory")
Tenant = Depends(require_active_tenant)

KEY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,100}$")


def internal_key_ok(x_internal_key: Optional[str]) -> bool:
    expected = os.getenv("RESERVATION_API_KEY", "")
    return bool(expected) and bool(x_internal_key) and hmac.compare_digest(x_internal_key.encode(), expected.encode())


def require_trusted_caller(x_internal_key: Optional[str] = Header(default=None)) -> None:
    if not os.getenv("RESERVATION_API_KEY", ""):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Service authentication is not configured")
    if not internal_key_ok(x_internal_key):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the Sales Service can change reservations.")


def idempotency_key(key: Optional[str] = Header(default=None, alias="Idempotency-Key")) -> str:
    key = (key or "").strip()
    if not key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The Idempotency-Key header is required for reservation changes.")
    if not KEY_RE.match(key):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key must be 8-100 characters: letters, digits and . _ : -")
    return key


@router.post("/reservations", response_model=ReservationResult, status_code=status.HTTP_201_CREATED, tags=["Reservations"])
def set_reservations(payload: ReservationSet, response: Response, tenant: TenantContext = Tenant, _trusted: None = Depends(require_trusted_caller), key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Make the reservations of one order exactly the given totals: book more, release less, all lines or none (409 with the
    shortages when the AVAILABLE stock - on hand minus reserved - is not enough). 201 the first time, 200 on a replay."""
    result = reservations.reserve(db, tenant, payload, key)
    response.status_code = status.HTTP_200_OK if result.replayed else status.HTTP_201_CREATED
    return result


@router.post("/reservations/release", response_model=ReservationResult, status_code=status.HTTP_201_CREATED, tags=["Reservations"])
def release_reservations(payload: ReservationRelease, response: Response, tenant: TenantContext = Tenant, _trusted: None = Depends(require_trusted_caller), key: str = Depends(idempotency_key), db: Session = Depends(get_db)):
    """Give back everything the order still holds (cancellation). Dispatched quantities stay dispatched."""
    result = reservations.release(db, tenant, payload, key)
    response.status_code = status.HTTP_200_OK if result.replayed else status.HTTP_201_CREATED
    return result


@router.get("/reservations/by-key/{key}", response_model=ReservationResult, tags=["Reservations"])
def reservation_by_key(key: str, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Read-only check whether the request made with this Idempotency-Key happened (404 = it did not)."""
    if not KEY_RE.match(key):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No reservation was made with this key.")
    return reservations.by_key(db, tenant, key)


@router.get("/reservations/source/{source_id}", response_model=ReservationList, tags=["Reservations"])
def reservations_of_source(source_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """What one order currently has reserved, line by line. Read-only."""
    return reservations.of_source(db, tenant, source_id)
