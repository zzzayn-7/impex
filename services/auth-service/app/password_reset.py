"""Password reset by the Super Admin, and the person's own change of password.

THE FLOW. A person forgets the password of their organization portal. The Super Admin presses "Reset password" on that administrator. Here:
  1. a strong TEMPORARY password is generated (app/security.py) and becomes the account's password at once (the old one stops working, and so does every sign-in made before);
  2. the Organization Service emails it to the address the administrator registered with (that service owns the mailer; the password is never logged, never stored in plain text, never
     shown to the Super Admin);
  3. the person signs in with it (it works for 24 hours) and the portal sends them straight to choose their own password (`must_change_password`); nothing else opens until they have.

Only an active organization administrator of the named organization can be reset: a Super Admin, an account of another organization or any other kind of account is unreachable.
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import User
from app.organization_admins import ORGANIZATION_ADMIN_ROLE
from app.security import generate_temporary_password, hash_password, password_problems, verify_password

TEMPORARY_PASSWORD_TTL = timedelta(hours=24)
RESET_COOLDOWN = timedelta(seconds=60)
MAX_PASSWORD_LENGTH = 256


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _refuse(http: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(http, detail={"code": code, "message": message, **extra})


def reset_organization_admin_password(db: Session, *, organization_id: uuid.UUID, email: str, now: Optional[datetime] = None) -> Tuple[User, str, datetime]:
    """(the account, the temporary password, when it expires). The password is returned ONCE to the trusted caller that emails it; only its hash is kept."""
    now = now or _now()
    user = db.scalar(
        select(User).where(User.email == email.strip().lower(), User.role == ORGANIZATION_ADMIN_ROLE, User.organization_id == organization_id).with_for_update()
    )
    if user is None:
        raise _refuse(404, "not_found", "Administrator account not found.")
    if not user.is_active:
        raise _refuse(409, "account_disabled", "This account is disabled, so its password cannot be reset.")
    if user.password_reset_sent_at is not None and now - user.password_reset_sent_at < RESET_COOLDOWN:
        wait = int((RESET_COOLDOWN - (now - user.password_reset_sent_at)).total_seconds()) + 1
        db.rollback()
        raise _refuse(429, "reset_too_soon", f"A new password was sent a moment ago. Wait {wait} seconds before sending another.", retry_after=wait)
    password = generate_temporary_password(user.email)
    user.password_hash = hash_password(password)
    user.must_change_password = True
    user.password_changed_at = now
    user.password_reset_sent_at = now
    user.password_reset_expires_at = now + TEMPORARY_PASSWORD_TTL
    db.commit()
    db.refresh(user)
    return user, password, user.password_reset_expires_at


def temporary_password_expired(user: User, now: Optional[datetime] = None) -> bool:
    return bool(user.must_change_password and user.password_reset_expires_at is not None and (now or _now()) >= user.password_reset_expires_at)


def change_own_password(db: Session, user: User, current_password: str, new_password: str, now: Optional[datetime] = None) -> User:
    """The person chooses their own password. The current one (the temporary one, after a reset) must be right; the new one must be strong and different. Everything older is signed out."""
    if len(current_password) > MAX_PASSWORD_LENGTH or not verify_password(current_password, user.password_hash):
        raise _refuse(403, "wrong_password", "The current password is not right.")
    if len(new_password) > MAX_PASSWORD_LENGTH:
        raise _refuse(422, "weak_password", "Password must be at most 256 characters.", problems=["at most 256 characters"])
    problems = password_problems(new_password, user.email)
    if problems:
        raise _refuse(422, "weak_password", "Password must contain: " + ", ".join(problems) + ".", problems=problems)
    if verify_password(new_password, user.password_hash):
        raise _refuse(422, "same_password", "Choose a password you have not used just now: the new password must differ from the current one.")
    user.password_hash = hash_password(new_password)
    user.must_change_password = False
    user.password_reset_expires_at = None
    user.password_changed_at = now or _now()
    db.commit()
    db.refresh(user)
    return user

