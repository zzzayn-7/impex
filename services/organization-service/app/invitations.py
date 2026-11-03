"""Organization administrator invitations: token handling and the invite/resend workflow.

Security rules enforced here:
  * tokens come from `secrets` (256 bits), are single-use and expire after 24 hours;
  * only a SHA-256 hash is stored; the plaintext token lives only in the email;
  * the plaintext token and the activation link are never logged or returned by the API.
"""
import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.mailer import EmailDeliveryError, send_invitation_email
from app.models import Organization, OrganizationInvitation

logger = logging.getLogger("impex.invitations")

INVITATION_TTL = timedelta(hours=24)


# --- tokens -----------------------------------------------------------------
def generate_token() -> str:
    return secrets.token_urlsafe(32)  # 32 random bytes -> 43 URL-safe characters


def hash_token(token: str) -> str:
    # A plain SHA-256 is appropriate for a high-entropy random token (unlike a human password).
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def build_activation_link(token: str) -> str:
    base = os.getenv("APP_BASE_URL", "http://localhost").rstrip("/")
    # The token is in the URL fragment, which browsers never send to servers, so it does not
    # end up in the NGINX/proxy access logs when the link is opened.
    return f"{base}/activate#token={token}"


# --- state ------------------------------------------------------------------
def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def invitation_status(invitation: OrganizationInvitation, now: Optional[datetime] = None) -> str:
    now = now or utcnow()
    if invitation.accepted_at is not None:
        return "accepted"
    if invitation.revoked_at is not None:
        return "revoked"
    if invitation.expires_at <= now:
        return "expired"
    return "pending"


def is_active(invitation: OrganizationInvitation, now: Optional[datetime] = None) -> bool:
    return invitation_status(invitation, now) == "pending"


def build_login_url() -> str:
    base = os.getenv("TENANT_PORTAL_URL", "http://localhost:3001").rstrip("/")
    return f"{base}/login"


# --- workflow ---------------------------------------------------------------
def issue_invitation(
    db: Session,
    organization: Organization,
    *,
    resend: bool,
    email: Optional[str] = None,
    full_name: Optional[str] = None,
    now: Optional[datetime] = None,
) -> OrganizationInvitation:
    """Create (or, with resend=True, replace) the invitation for ONE administrator of the organization.

    Without `email` the organization's primary administrator email is used. An organization may have
    several administrators; each (organization, email) pair has at most one live invitation.

    Everything happens in one transaction, including the email: if the email cannot be sent,
    nothing changes and any previous invitation stays valid, so a retry can never create duplicates.
    """
    now = now or utcnow()
    email = (email or organization.primary_admin_email or "").strip().lower()

    if not email:
        raise HTTPException(status.HTTP_409_CONFLICT, "This organization has no primary administrator email.")

    # Serialize concurrent invite/resend requests for the same organization.
    db.execute(select(Organization.id).where(Organization.id == organization.id).with_for_update())

    # Lock the pending invitation too: if the administrator is activating right now, wait for that to
    # finish (the row then no longer matches) instead of revoking a token that is being accepted.
    pending = db.scalar(
        select(OrganizationInvitation)
        .where(
            OrganizationInvitation.organization_id == organization.id,
            OrganizationInvitation.email == email,
            OrganizationInvitation.accepted_at.is_(None),
            OrganizationInvitation.revoked_at.is_(None),
        )
        .with_for_update()
    )

    accepted = db.scalar(
        select(OrganizationInvitation.id).where(
            OrganizationInvitation.organization_id == organization.id,
            OrganizationInvitation.email == email,
            OrganizationInvitation.accepted_at.is_not(None),
        )
    )
    if accepted is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "The administrator has already accepted an invitation.")

    if resend and pending is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "There is no pending invitation to resend.")
    if not resend and pending is not None and is_active(pending, now):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "An active invitation already exists. Use resend to replace it.",
        )

    carried_name = full_name or (pending.full_name if pending is not None else None)

    if pending is not None:
        pending.revoked_at = now  # invalidates the previous token (also when it had merely expired)
        db.flush()  # must hit the database before the new row, or the pending-unique index would clash

    token = generate_token()
    invitation = OrganizationInvitation(
        organization_id=organization.id,
        email=email,
        full_name=carried_name,
        token_hash=hash_token(token),
        expires_at=now + INVITATION_TTL,
        created_at=now,
    )
    db.add(invitation)
    try:
        db.flush()
    except IntegrityError:  # lost a race despite the row lock (e.g. a different writer)
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "An active invitation already exists. Use resend to replace it.")

    try:
        send_invitation_email(
            to_email=invitation.email,
            organization_name=organization.name,
            activation_link=build_activation_link(token),
            expires_at=invitation.expires_at,
            recipient_name=invitation.full_name,
            login_url=build_login_url(),
        )
    except EmailDeliveryError as exc:
        db.rollback()
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"The invitation email could not be sent ({exc}). Nothing was changed; please try again.",
        )

    db.commit()
    db.refresh(invitation)
    logger.info(
        "Invitation %s issued for organization %s (resend=%s)", invitation.id, organization.id, resend
    )
    return invitation
