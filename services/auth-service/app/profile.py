"""An organization administrator's own profile and first-time confirmation.

Only the authenticated person's full name can change here. The role, e-mail, organization, password and every other
user are unreachable: the user comes from the verified token, and the request model accepts nothing but the name.
"""
import unicodedata
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models import User

ORGANIZATION_ADMIN_ROLE = "organization-admin"
NAME_MIN, NAME_MAX = 2, 100
_NAME_PUNCTUATION = set(" .'’-")


def _error(code: int, error_code: str, message: str) -> HTTPException:
    return HTTPException(code, detail={"code": error_code, "message": message})


def clean_full_name(value: object) -> str:
    """Whitespace collapsed; 2-100 characters of letters (any alphabet), accents, spaces, and . ' ’ - only."""
    if not isinstance(value, str):
        raise _error(422, "invalid_name", "Enter your full name.")
    name = " ".join(unicodedata.normalize("NFC", value).split())
    if len(name) < NAME_MIN or len(name) > NAME_MAX:
        raise _error(422, "invalid_name", f"Your name must be {NAME_MIN} to {NAME_MAX} characters.")
    for ch in name:
        if not (ch.isalpha() or ch in _NAME_PUNCTUATION or unicodedata.category(ch).startswith("M")):
            raise _error(422, "invalid_name", "Use letters, spaces, apostrophes, hyphens and full stops only.")
    if not any(ch.isalpha() for ch in name):
        raise _error(422, "invalid_name", "Enter your full name.")
    return name


def require_profile_owner(user: User) -> None:
    if user.role != ORGANIZATION_ADMIN_ROLE or user.organization_id is None:
        raise _error(403, "not_an_organization_admin", "Profile setup is only for organization administrators.")


def update_profile(db: Session, user: User, full_name: str) -> User:
    require_profile_owner(user)
    user.full_name = clean_full_name(full_name)
    db.commit()
    db.refresh(user)
    return user


def complete_profile(db: Session, user: User, full_name: Optional[str]) -> User:
    """Optionally correct the name, then mark the profile confirmed. One transaction; repeating it changes nothing
    (the first completion time is kept)."""
    require_profile_owner(user)
    if full_name is not None:
        user.full_name = clean_full_name(full_name)
    if user.profile_setup_completed_at is None:
        user.profile_setup_completed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user)
    return user
