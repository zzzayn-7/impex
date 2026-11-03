"""Send ONE real invitation email to an address you control, to test your SMTP setup end to end.

    docker compose exec organization-service python -m app.scripts.send_test_invitation --to you@gmail.com
    docker compose exec organization-service python -m app.scripts.send_test_invitation --to you@gmail.com --cleanup

It uses exactly the same code as the API (single-use token, SHA-256 hash stored, 24-hour expiry, email
with the activation link). It creates a clearly named test organization whose primary administrator is the
address you give. Running it again resends (the previous token is invalidated). --cleanup deletes that
test organization and its invitations. Neither the SMTP password nor any token is ever printed.
"""
import argparse
import hashlib
import logging
import sys
from typing import List, Tuple

from fastapi import HTTPException
from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.invitations import INVITATION_TTL, issue_invitation
from app.mailer import SmtpSettings, load_smtp_settings
from app.models import Organization, OrganizationInvitation

TEST_ORG_NAME = "Impex Invitation Test"
_email_adapter = TypeAdapter(EmailStr)


def org_slug_for(email: str) -> str:
    # Deterministic per address, so repeated runs reuse (and resend for) the same test organization.
    return "invitation-test-" + hashlib.sha256(email.encode()).hexdigest()[:6]


def parse_email(raw: str) -> str:
    try:
        return str(_email_adapter.validate_python(raw.strip())).lower()
    except ValidationError:
        raise argparse.ArgumentTypeError(f"'{raw}' is not a valid email address")


def check_settings(settings: SmtpSettings) -> Tuple[List[str], List[str]]:
    """Return (errors, notes) for the SMTP configuration. Never includes the password."""
    errors, notes = [], []
    if settings.host == "mailpit":
        notes.append(
            "SMTP_HOST is 'mailpit': the email will only appear in the local Mailpit inbox "
            "(http://localhost:8025), NOT in a real mailbox. Set SMTP_* in .env to send real email."
        )
    if bool(settings.username) != bool(settings.password):
        errors.append("SMTP_USERNAME and SMTP_PASSWORD must both be set (or both empty).")
    if settings.username and not (settings.starttls or settings.use_ssl):
        errors.append(
            "Credentials are configured but neither SMTP_STARTTLS nor SMTP_SSL is enabled; "
            "they would be sent unencrypted. Set SMTP_STARTTLS=true (port 587)."
        )
    if settings.host != "mailpit" and settings.from_address.endswith("@impex.local"):
        notes.append(
            f"SMTP_FROM_ADDRESS is '{settings.from_address}'. Real providers reject or rewrite unverified "
            "senders; for Gmail set it to your Gmail address."
        )
    return errors, notes


def describe_settings(settings: SmtpSettings) -> str:
    security = "SSL" if settings.use_ssl else "STARTTLS" if settings.starttls else "none"
    login = "yes" if settings.username else "no"
    return (
        f"SMTP server: {settings.host}:{settings.port} | encryption: {security} | login: {login} | "
        f"from: {settings.from_name} <{settings.from_address}>"
    )


def send_test_invitation(db: Session, email: str) -> OrganizationInvitation:
    org = db.scalar(select(Organization).where(Organization.slug == org_slug_for(email)))
    if org is None:
        org = Organization(
            name=TEST_ORG_NAME,
            slug=org_slug_for(email),
            country_code="US",
            contact_email=email,
            primary_admin_email=email,
        )
        db.add(org)
        db.commit()
        db.refresh(org)

    has_pending = db.scalar(
        select(OrganizationInvitation.id).where(
            OrganizationInvitation.organization_id == org.id,
            OrganizationInvitation.accepted_at.is_(None),
            OrganizationInvitation.revoked_at.is_(None),
        )
    )
    # An existing pending invitation (even an expired one) is replaced; otherwise a new one is created.
    return issue_invitation(db, org, resend=has_pending is not None)


def cleanup(db: Session, email: str) -> bool:
    org = db.scalar(select(Organization).where(Organization.slug == org_slug_for(email)))
    if org is None:
        return False
    db.delete(org)  # its invitations are removed by the database (ON DELETE CASCADE)
    db.commit()
    return True


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Send one real test invitation email.")
    parser.add_argument("--to", required=True, type=parse_email, metavar="EMAIL",
                        help="your own email address (becomes the test organization's primary administrator)")
    parser.add_argument("--cleanup", action="store_true", help="delete the test organization and its invitations")
    args = parser.parse_args(argv)

    # Show delivery problems (safe, secret-free reasons) on screen, whatever the logging setup is.
    problem_handler = logging.StreamHandler(sys.stderr)
    problem_handler.setFormatter(logging.Formatter("  ! %(message)s"))
    mail_logger = logging.getLogger("impex.mailer")
    mail_logger.addHandler(problem_handler)
    try:
        return _run(args)
    finally:
        mail_logger.removeHandler(problem_handler)


def _run(args) -> int:
    try:
        with SessionLocal() as db:
            if args.cleanup:
                removed = cleanup(db, args.to)
                print("Test organization and its invitations deleted." if removed else "Nothing to clean up.")
                return 0

            settings = load_smtp_settings()
            print(describe_settings(settings))
            errors, notes = check_settings(settings)
            for note in notes:
                print(f"Note: {note}")
            if errors:
                for error in errors:
                    print(f"Error: {error}", file=sys.stderr)
                return 2

            try:
                invitation = send_test_invitation(db, args.to)
            except HTTPException as exc:
                print(f"\nFAILED ({exc.status_code}): {exc.detail}", file=sys.stderr)
                if exc.status_code == 502:
                    print("See the '!' line above for the cause. Nothing was changed in the database.", file=sys.stderr)
                return 1

            expires = invitation.expires_at.strftime("%Y-%m-%d %H:%M UTC")
            hours = int(INVITATION_TTL.total_seconds() // 3600)
            print(
                f"\nInvitation sent to {args.to}.\n"
                f"  Single-use link valid for {hours} hours (expires {expires}).\n"
                "  Check your inbox - and your spam folder the first time.\n"
                "  Running this again resends and invalidates the previous link."
            )
            return 0
    except ProgrammingError:
        print("Error: tables are missing. Run: alembic upgrade head", file=sys.stderr)
    except OperationalError:
        print("Error: could not connect to the database (is the postgres service healthy?).", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
