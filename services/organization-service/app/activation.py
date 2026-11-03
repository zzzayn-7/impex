"""Invitation acceptance: validate a token, create the administrator account, mark the invitation used.

Two databases are involved (invitations here, users in the Auth Service), so this is a small saga:

  1. lock the invitation row (concurrent attempts with the same token queue up behind it);
  2. require it to be pending (not accepted / revoked / expired);
  3. ask the Auth Service to create the account. That call is idempotent, so a retry after any
     failure below repeats it harmlessly;
  4. only after the account exists, mark the invitation accepted (and retire other pending ones).

If step 3 fails, nothing changed and the same link can be retried. If the process dies between
steps 3 and 4, the account exists but the invitation is still pending; retrying the same link
re-runs step 3 (a no-op) and completes step 4.

The plaintext token and the password are used only in memory, never stored or logged.
"""
import hmac
import logging
import os
import re
from typing import Optional

import httpx
from fastapi import Header, HTTPException, Request, status
from sqlalchemy import select, text, update
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.invitations import hash_token, invitation_status, utcnow
from app.models import Organization, OrganizationInvitation

logger = logging.getLogger("impex.activation")

TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{20,128}$")
MAX_PASSWORD_LENGTH = 256
AUTH_SERVICE_URL = os.getenv("AUTH_SERVICE_URL", "http://auth-service:8000").rstrip("/")

INVALID = ("invalid", "This invitation link is not valid.")
STATE_ERRORS = {
    "expired": ("expired", "This invitation link has expired. Ask your administrator to send a new invitation."),
    "revoked": ("revoked", "This invitation link has been replaced by a newer invitation. Use the most recent email."),
    "accepted": ("used", "This invitation has already been used."),
}


def fail(status_code: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code, detail={"code": code, "message": message, **extra})


# --- service authentication (frontend -> this service) ----------------------
def require_activation_key(x_internal_key: Optional[str] = Header(default=None)) -> None:
    expected = os.getenv("ACTIVATION_API_KEY")
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Service authentication is not configured")
    if not x_internal_key or not hmac.compare_digest(x_internal_key.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid service credentials")


# --- client for the Auth Service (this service -> auth-service) -------------
def create_internal_auth_client() -> httpx.Client:
    # Synchronous on purpose: the activation endpoints are sync (they hold a row lock while calling out).
    return httpx.Client(base_url=AUTH_SERVICE_URL, timeout=httpx.Timeout(5.0))


def get_internal_auth_client(request: Request) -> httpx.Client:
    return request.app.state.internal_auth_client


# --- token / invitation checks ----------------------------------------------
def find_invitation(db: Session, token: str, *, lock: bool = False) -> OrganizationInvitation:
    if not isinstance(token, str) or not TOKEN_PATTERN.match(token):
        raise fail(status.HTTP_404_NOT_FOUND, *INVALID)
    statement = select(OrganizationInvitation).where(OrganizationInvitation.token_hash == hash_token(token))
    if lock:
        statement = statement.with_for_update()
    invitation = db.scalar(statement)
    if invitation is None:
        raise fail(status.HTTP_404_NOT_FOUND, *INVALID)
    return invitation


def require_pending(invitation: OrganizationInvitation) -> None:
    state = invitation_status(invitation)
    if state != "pending":
        code, message = STATE_ERRORS[state]
        raise fail(status.HTTP_410_GONE, code, message)


def lookup_invitation(db: Session, token: str) -> dict:
    """Read-only check used to show the activation form. Does not consume the token."""
    invitation = find_invitation(db, token)
    require_pending(invitation)
    organization = db.get(Organization, invitation.organization_id)
    return {
        "organization_name": organization.name,
        "email": invitation.email,
        "expires_at": invitation.expires_at.isoformat(),
    }


# --- Auth Service call -------------------------------------------------------
def create_admin_account(
    auth_client: httpx.Client, *, organization_id, full_name: str, email: str, password: str
) -> None:
    try:
        response = auth_client.post(
            "/internal/organization-admins",
            json={
                # Everything here comes from our own invitation record, except the name and password
                # the invited person typed. The role is fixed by the Auth Service.
                "organization_id": str(organization_id),
                "full_name": full_name,
                "email": email,
                "password": password,
            },
            headers={"X-Internal-Key": os.getenv("AUTH_INTERNAL_API_KEY", "")},
        )
    except httpx.HTTPError:
        raise fail(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "temporarily_unavailable",
            "The account service is temporarily unavailable. Please try again in a moment.",
        )

    code = response.status_code
    if code in (status.HTTP_200_OK, status.HTTP_201_CREATED):
        return

    try:
        detail = response.json().get("detail", {})
    except ValueError:
        detail = {}
    if not isinstance(detail, dict):
        detail = {}

    if code == status.HTTP_409_CONFLICT:
        raise fail(status.HTTP_409_CONFLICT, detail.get("code", "account_exists"),
                   detail.get("message", "An account with this email address already exists."))
    if code == 422 and detail.get("code") in ("weak_password", "invalid_name"):
        raise fail(422, detail["code"], detail.get("message", "Invalid value."),
                   problems=detail.get("problems", []))
    if code in (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN) or (
        code == status.HTTP_503_SERVICE_UNAVAILABLE and "not configured" in str(response.text)
    ):
        # Our own configuration is wrong; say so in the log (never the key) and fail safely.
        logger.error("Auth Service rejected the service credentials (HTTP %s)", code)
        raise fail(status.HTTP_502_BAD_GATEWAY, "service_error", "Activation is temporarily unavailable.")
    logger.warning("Auth Service returned HTTP %s while creating an administrator account", code)
    raise fail(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "temporarily_unavailable",
        "The account service is temporarily unavailable. Please try again in a moment.",
    )


# --- completion --------------------------------------------------------------
def finalize(db: Session, invitation: OrganizationInvitation) -> None:
    """Mark the invitation accepted and retire any other pending invitation for the organization."""
    now = utcnow()
    invitation.accepted_at = now
    db.execute(
        update(OrganizationInvitation)
        .where(
            OrganizationInvitation.organization_id == invitation.organization_id,
            OrganizationInvitation.id != invitation.id,
            OrganizationInvitation.accepted_at.is_(None),
            OrganizationInvitation.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )
    db.commit()


def accept_invitation(db: Session, auth_client: httpx.Client, *, token: str, full_name: str, password: str) -> dict:
    if not isinstance(full_name, str) or not isinstance(password, str) or len(password) > MAX_PASSWORD_LENGTH:
        raise fail(422, "invalid_request", "Invalid request.")

    try:
        db.execute(text("SET LOCAL lock_timeout = '8s'"))
        invitation = find_invitation(db, token, lock=True)  # concurrent attempts wait here
    except OperationalError:
        db.rollback()
        raise fail(status.HTTP_503_SERVICE_UNAVAILABLE, "busy", "This invitation is being processed. Please try again.")

    try:
        require_pending(invitation)  # a concurrent winner makes this 'used'
        organization = db.get(Organization, invitation.organization_id)
        create_admin_account(
            auth_client,
            organization_id=invitation.organization_id,
            full_name=full_name,
            email=invitation.email,
            password=password,
        )
    except HTTPException:
        db.rollback()  # release the lock; nothing was changed
        raise

    try:
        finalize(db, invitation)
    except SQLAlchemyError:
        db.rollback()
        # The account exists but the invitation could not be marked used. Retrying the same link
        # is safe: the Auth Service call is idempotent and this step will run again.
        logger.error("Administrator account created but invitation %s was not marked accepted yet", invitation.id)
        raise fail(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "temporarily_unavailable",
            "Your account was created but activation could not be completed. Please try the link again.",
        )

    logger.info("Invitation %s accepted for organization %s", invitation.id, invitation.organization_id)
    return {"organization_name": organization.name, "email": invitation.email}
