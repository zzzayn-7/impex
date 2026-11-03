"""Internal provisioning of organization administrator accounts.

Called only by the Organization Service, authenticated with a shared service key
(INTERNAL_API_KEY). The role is fixed here and the organization id comes from the
caller's trusted invitation record: no public endpoint can set either.

The operation is idempotent so the cross-service activation can be retried safely:
repeating it for the same organization + email + password succeeds without changes.
"""
import hmac
import os
import uuid
from dataclasses import dataclass
from typing import Optional

from fastapi import Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import User
from app.security import hash_password, password_problems, verify_password

ORGANIZATION_ADMIN_ROLE = "organization-admin"
MAX_PASSWORD_LENGTH = 256


def require_internal_key(x_internal_key: Optional[str] = Header(default=None)) -> None:
    expected = os.getenv("INTERNAL_API_KEY")
    if not expected:
        # Fail closed: without a configured key nobody may call internal endpoints.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Internal service authentication is not configured")
    if not x_internal_key or not hmac.compare_digest(x_internal_key.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid service credentials")


@dataclass
class ProvisionResult:
    user: User
    created: bool


def _error(code: int, error_code: str, message: str, **extra) -> HTTPException:
    return HTTPException(code, detail={"code": error_code, "message": message, **extra})


def _existing_result(existing: User, organization_id: uuid.UUID, password: str) -> ProvisionResult:
    same_account = existing.role == ORGANIZATION_ADMIN_ROLE and existing.organization_id == organization_id
    if not same_account:
        raise _error(status.HTTP_409_CONFLICT, "email_taken", "An account with this email address already exists.")
    if not verify_password(password, existing.password_hash):
        raise _error(
            status.HTTP_409_CONFLICT,
            "account_exists",
            "An administrator account for this email address already exists. Use your existing password.",
        )
    return ProvisionResult(existing, created=False)  # a retry of an already completed request


def provision_organization_admin(
    db: Session, *, organization_id: uuid.UUID, full_name: str, email: str, password: str
) -> ProvisionResult:
    email = email.strip().lower()
    full_name = " ".join(full_name.split())

    if not full_name or len(full_name) > 255:
        raise _error(422, "invalid_name", "Full name is required (max 255 characters).")
    problems = password_problems(password, email) if len(password) <= MAX_PASSWORD_LENGTH else ["at most 256 characters"]
    if problems:
        raise _error(
            422,
            "weak_password",
            "Password must contain: " + ", ".join(problems) + ".",
            problems=problems,
        )

    existing = db.scalar(select(User).where(User.email == email))
    if existing is not None:
        return _existing_result(existing, organization_id, password)

    user = User(
        full_name=full_name,
        email=email,
        password_hash=hash_password(password),
        role=ORGANIZATION_ADMIN_ROLE,
        organization_id=organization_id,
        is_active=True,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        # A concurrent request created the same email first: evaluate against the winner.
        db.rollback()
        winner = db.scalar(select(User).where(User.email == email))
        if winner is None:
            raise
        return _existing_result(winner, organization_id, password)
    db.refresh(user)
    return ProvisionResult(user, created=True)
