"""Bootstrap command: create the initial Super Admin account.

Run inside Docker (interactive terminal required so the password stays hidden):

    docker compose exec auth-service python -m app.scripts.create_super_admin

Only one Super Admin can be created this way. This is deliberately a CLI-only
operation; there is no API endpoint for it.
"""
import getpass
import sys
from typing import List

from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import User
from app.security import hash_password

ROLE = "super-admin"
MAX_ATTEMPTS = 3
MIN_PASSWORD_LENGTH = 12
# Arbitrary constant key. Serialises concurrent runs of this command so two
# terminals can never both create a Super Admin.
ADVISORY_LOCK_KEY = 7_340_001

_email_adapter = TypeAdapter(EmailStr)


class BootstrapError(Exception):
    """Expected, user-facing failure (printed without a traceback)."""


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
def validate_email(raw: str) -> str:
    try:
        return str(_email_adapter.validate_python(raw.strip())).lower()
    except ValidationError as exc:
        reason = exc.errors()[0].get("msg", "invalid email address")
        raise ValueError(reason.removeprefix("value is not a valid email address: "))


def password_problems(password: str, email: str) -> List[str]:
    problems = []
    if len(password) < MIN_PASSWORD_LENGTH:
        problems.append(f"at least {MIN_PASSWORD_LENGTH} characters")
    if not any(c.islower() for c in password):
        problems.append("a lowercase letter")
    if not any(c.isupper() for c in password):
        problems.append("an uppercase letter")
    if not any(c.isdigit() for c in password):
        problems.append("a digit")
    if all(c.isalnum() for c in password):
        problems.append("a symbol (e.g. ! @ # $ %)")
    local_part = email.split("@")[0]
    if len(local_part) >= 3 and local_part in password.lower():
        problems.append("no part of your email address")
    return problems


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
def super_admin_exists(db: Session) -> bool:
    return db.scalar(select(User.id).where(User.role == ROLE).limit(1)) is not None


def email_taken(db: Session, email: str) -> bool:
    return db.scalar(select(User.id).where(User.email == email)) is not None


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
def prompt_full_name() -> str:
    for _ in range(MAX_ATTEMPTS):
        name = input("Full name: ").strip()
        if name and len(name) <= 255:
            return name
        print("  Full name is required (max 255 characters).")
    raise BootstrapError("Too many invalid attempts.")


def prompt_email(db: Session) -> str:
    for _ in range(MAX_ATTEMPTS):
        raw = input("Email: ")
        try:
            email = validate_email(raw)
        except ValueError as exc:
            print(f"  Invalid email: {exc}")
            continue
        if email_taken(db, email):
            print("  A user with this email already exists.")
            continue
        return email
    raise BootstrapError("Too many invalid attempts.")


def prompt_password(email: str) -> str:
    for _ in range(MAX_ATTEMPTS):
        password = getpass.getpass("Password: ")
        problems = password_problems(password, email)
        if problems:
            print("  Password is too weak. It needs: " + ", ".join(problems) + ".")
            continue
        if getpass.getpass("Confirm password: ") != password:
            print("  Passwords do not match.")
            continue
        return password
    raise BootstrapError("Too many invalid attempts.")


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------
def create_super_admin(db: Session, full_name: str, email: str, password: str) -> User:
    # Hold a transaction-scoped lock, then re-check everything, so the
    # "only one Super Admin" rule holds even with concurrent runs.
    db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ADVISORY_LOCK_KEY})
    if super_admin_exists(db):
        db.rollback()
        raise BootstrapError("A Super Admin already exists. Nothing was created.")
    if email_taken(db, email):
        db.rollback()
        raise BootstrapError("A user with this email already exists. Nothing was created.")

    user = User(
        full_name=full_name,
        email=email,
        password_hash=hash_password(password),
        role=ROLE,
        is_active=True,
    )
    db.add(user)
    db.commit()  # also releases the advisory lock
    db.refresh(user)
    return user


def main() -> int:
    try:
        with SessionLocal() as db:
            if super_admin_exists(db):
                raise BootstrapError(
                    "A Super Admin already exists. This bootstrap command can only be used once."
                )
            print("Create the initial Super Admin (the password will not be shown).\n")
            full_name = prompt_full_name()
            email = prompt_email(db)
            password = prompt_password(email)
            user = create_super_admin(db, full_name, email, password)
        print(f"\nSuper Admin created: {user.email} (id: {user.id}, role: {user.role})")
        return 0
    except BootstrapError as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("\nAborted. Nothing was created.", file=sys.stderr)
        return 1
    except ProgrammingError:
        print("\nError: the users table is missing. Run: alembic upgrade head", file=sys.stderr)
        return 1
    except OperationalError:
        print("\nError: could not connect to the database (is the postgres service healthy?).", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
