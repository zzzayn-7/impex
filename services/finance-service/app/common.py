"""Small shared pieces: who did it (an Actor), the audit trail, numbering, idempotency, and consistent error responses."""
import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from typing import Any, Optional

from fastapi import HTTPException, status
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.auth import TenantContext
from app.models import FinanceCounter, FinanceEvent, FinanceRequest
from app.tenancy import scoped_select

IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,100}$")


@dataclass(frozen=True)
class Actor:
    """Who caused a change: an administrator (id + email), or the synchronisation (no person)."""

    user_id: Optional[uuid.UUID]
    email: Optional[str]
    source: str = "user"  # 'user' | 'sync'

    @classmethod
    def of(cls, tenant: TenantContext) -> "Actor":
        try:
            user_id = uuid.UUID(tenant.user_id)
        except ValueError:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Organization administrator permission required")
        return cls(user_id, tenant.email, "user")

    @classmethod
    def sync(cls) -> "Actor":
        return cls(None, None, "sync")


def fail(status_code: int, code: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code, {"code": code, "message": message, **extra})


def conflict(code: str, message: str, **extra: Any) -> HTTPException:
    return fail(status.HTTP_409_CONFLICT, code, message, **extra)


def unprocessable(code: str, message: str, **extra: Any) -> HTTPException:
    return fail(status.HTTP_422_UNPROCESSABLE_ENTITY, code, message, **extra)


def audit(db: Session, organization_id: uuid.UUID, entity_type: str, entity_id: Optional[uuid.UUID], action: str, actor: Actor, detail: Optional[str] = None) -> None:
    """Append one line to the audit trail (inside the caller's transaction, so it exists if and only if the change does)."""
    db.add(FinanceEvent(
        organization_id=organization_id, entity_type=entity_type, entity_id=entity_id, action=action, actor_id=actor.user_id, actor_email=actor.email,
        source=actor.source, detail=(detail[:500] if detail else None),
    ))


def next_number(db: Session, organization_id: uuid.UUID, counter: str, prefix: str) -> str:
    """JE-000001, EXP-000001 ... per organization. The counter row is locked until the caller's transaction ends, so concurrent posters are
    serialized, two never share a number, and a failed posting rolls its number back (posted numbers have no gaps)."""
    row = db.execute(
        pg_insert(FinanceCounter)
        .values(organization_id=organization_id, name=counter, last_number=1)
        .on_conflict_do_update(index_elements=["organization_id", "name"], set_={"last_number": FinanceCounter.last_number + 1})
        .returning(FinanceCounter.last_number)
    ).one()
    return f"{prefix}-{row[0]:06d}"


# --- idempotency -------------------------------------------------------------------------------------------------------------------
def idempotency_key_value(raw: Optional[str], *, required: bool = True) -> Optional[str]:
    key = (raw or "").strip()
    if not key:
        if required:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "The Idempotency-Key header is required.")
        return None
    if not IDEMPOTENCY_KEY_RE.match(key):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key must be 8-100 characters: letters, digits and . _ : -")
    return key


def request_hash(payload: Any) -> str:
    body = payload.model_dump(mode="json") if hasattr(payload, "model_dump") else payload
    return hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()


def claim_request(db: Session, tenant: TenantContext, key: str, scope: str, payload: Any) -> Optional[uuid.UUID]:
    """Claim an Idempotency-Key for this request. Returns None when the key is new (the caller does the work and then `attach_request`s the
    created entity in the SAME transaction), or the id of the entity the first request created (the caller returns it again, creating nothing)."""
    digest = request_hash(payload)
    claimed = db.execute(
        pg_insert(FinanceRequest)
        .values(organization_id=tenant.organization_id, idempotency_key=key, scope=scope, request_hash=digest)
        .on_conflict_do_nothing(index_elements=["organization_id", "idempotency_key"])
        .returning(FinanceRequest.id)
    ).first()  # a concurrent duplicate waits here for the first request to commit, then finds the key taken
    if claimed is not None:
        return None
    previous = db.scalar(scoped_select(FinanceRequest, tenant).where(FinanceRequest.idempotency_key == key))
    db.rollback()
    if previous is None or previous.entity_id is None:
        raise conflict("request_in_progress", "The request was being processed. Please retry.")
    if previous.request_hash != digest or previous.scope != scope:
        raise conflict("idempotency_key_reused", "This Idempotency-Key was already used for a different request. Use a new key for a new request.")
    return previous.entity_id


def attach_request(db: Session, tenant: TenantContext, key: str, entity_id: uuid.UUID) -> None:
    db.execute(
        FinanceRequest.__table__.update()
        .where(FinanceRequest.organization_id == tenant.organization_id, FinanceRequest.idempotency_key == key)
        .values(entity_id=entity_id)
    )
