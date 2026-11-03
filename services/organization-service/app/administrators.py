"""Organization administrators, managed by the Super Admin: create, read, update, delete.

Normal mode builds on the invitation workflow (secure single-use tokens, 24-hour expiry, SMTP email,
activation through the Auth Service).

DEMO MODE (DEMO_MODE=true) skips the activation step for demonstrations: the account is created at once
with a fixed demo password and the sign-in details are emailed. That deliberately trades security for
convenience; never enable it on a real deployment.
"""
import logging
import os
import uuid
from typing import List, Optional, Tuple

import httpx
from fastapi import HTTPException, status
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.invitations import (
    INVITATION_TTL,
    build_login_url,
    generate_token,
    hash_token,
    invitation_status,
    issue_invitation,
    utcnow,
)
from app.mailer import EmailDeliveryError, send_credentials_email
from app.models import Organization, OrganizationInvitation

logger = logging.getLogger("impex.administrators")

ADMINISTRATOR_ROLE = "organization-admin"  # fixed here; never taken from a request

# Invitation state -> what the Super Admin sees
STATUS_LABELS = {"pending": "pending", "expired": "expired", "accepted": "active"}

UNAVAILABLE = "The account service is temporarily unavailable. Please try again in a moment."


# --- demo mode --------------------------------------------------------------
def demo_mode() -> bool:
    return os.getenv("DEMO_MODE", "").strip().lower() in ("1", "true", "yes", "on")


def demo_password() -> str:
    return os.getenv("DEMO_ADMIN_PASSWORD") or "12345678"


# --- talking to the Auth Service ---------------------------------------------
def _auth_post(auth_client: httpx.Client, path: str, payload: dict) -> httpx.Response:
    try:
        return auth_client.post(path, json=payload, headers={"X-Internal-Key": os.getenv("AUTH_INTERNAL_API_KEY", "")})
    except httpx.HTTPError:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, UNAVAILABLE)


def _detail(response: httpx.Response) -> dict:
    try:
        detail = response.json().get("detail", {})
    except ValueError:
        return {}
    return detail if isinstance(detail, dict) else {}


def _raise_for_account_service(response: httpx.Response) -> None:
    """Translate an unexpected Auth Service answer into a safe error for the Super Admin."""
    code, detail = response.status_code, _detail(response)
    if code == status.HTTP_409_CONFLICT:
        raise HTTPException(status.HTTP_409_CONFLICT, detail.get("message") or "This email address already belongs to another account.")
    if code == status.HTTP_404_NOT_FOUND:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "The administrator's account was not found.")
    if code == status.HTTP_422_UNPROCESSABLE_ENTITY:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail.get("message") or "The account service rejected these details.")
    if code == status.HTTP_403_FORBIDDEN and detail.get("code") == "demo_disabled":
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Demo mode is on here but not in the account service. Set DEMO_MODE=true for both.")
    if code in (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN):
        logger.error("Auth Service rejected the service credentials (HTTP %s)", code)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Administrator accounts are temporarily unavailable.")
    raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, UNAVAILABLE)


def email_state(auth_client: httpx.Client, organization_id: uuid.UUID, email: str) -> str:
    """'available' | 'already_administrator' | 'email_taken' (Auth Service precheck)."""
    response = _auth_post(
        auth_client, "/internal/organization-admins/precheck", {"organization_id": str(organization_id), "email": email}
    )
    if response.status_code != status.HTTP_200_OK:
        _raise_for_account_service(response)
    state = response.json().get("state")
    if state not in ("available", "already_administrator", "email_taken"):
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Administrator accounts are temporarily unavailable.")
    return state


def check_email_available(auth_client: httpx.Client, organization_id: uuid.UUID, email: str) -> None:
    """Reject people who already have an account, before anything is sent or stored."""
    state = email_state(auth_client, organization_id, email)
    if state == "already_administrator":
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This person already has an active administrator account for this organization."
        )
    if state == "email_taken":
        raise HTTPException(status.HTTP_409_CONFLICT, "This email address already belongs to another account.")


def _delete_account(auth_client: httpx.Client, organization_id: uuid.UUID, email: str) -> None:
    response = _auth_post(auth_client, "/internal/organization-admins/delete", {"organization_id": str(organization_id), "email": email})
    if response.status_code != status.HTTP_200_OK:
        _raise_for_account_service(response)


# --- helpers ----------------------------------------------------------------
def clean_name(full_name: Optional[str]) -> Optional[str]:
    cleaned = " ".join(full_name.split()) if full_name else ""
    return cleaned or None


def _find_row(db: Session, organization: Organization, admin_id: str) -> OrganizationInvitation:
    """The administrator must belong to the organization named in the request."""
    try:
        row = db.get(OrganizationInvitation, uuid.UUID(admin_id))
    except ValueError:
        row = None
    if row is None or row.organization_id != organization.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Administrator not found for this organization.")
    return row


def _email_in_use(db: Session, organization: Organization, email: str, exclude: Optional[uuid.UUID] = None) -> bool:
    query = select(OrganizationInvitation.id).where(
        OrganizationInvitation.organization_id == organization.id,
        OrganizationInvitation.email == email,
        OrganizationInvitation.revoked_at.is_(None),
    )
    if exclude is not None:
        query = query.where(OrganizationInvitation.id != exclude)
    return db.scalar(query) is not None


# --- demo mode: create the account now and email the sign-in details ---------------
def _provision_and_email(db: Session, auth_client: httpx.Client, organization: Organization, row: OrganizationInvitation) -> None:
    """Create the account with the demo password (idempotent), then email it. Nothing is committed here."""
    password = demo_password()
    name = row.full_name or row.email.split("@")[0].replace(".", " ").title()
    response = _auth_post(
        auth_client,
        "/internal/organization-admins",
        {
            "organization_id": str(organization.id),
            "full_name": name,
            "email": row.email,
            "password": password,
            "allow_weak_password": True,
        },
    )
    if response.status_code not in (status.HTTP_200_OK, status.HTTP_201_CREATED):
        _raise_for_account_service(response)
    created = response.status_code == status.HTTP_201_CREATED
    try:
        send_credentials_email(
            to_email=row.email,
            organization_name=organization.name,
            login_url=build_login_url(),
            password=password,
            recipient_name=row.full_name,
        )
    except EmailDeliveryError as exc:
        if created:  # undo the account we just made so a retry starts clean
            try:
                _delete_account(auth_client, organization.id, row.email)
            except HTTPException:
                logger.error("Could not remove the account created for a failed credentials email (organization %s)", organization.id)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"The credentials email could not be sent ({exc}). Nothing was changed; please try again.",
        )


def _invite_demo(db: Session, auth_client: httpx.Client, organization: Organization, *, email: str, full_name: Optional[str]) -> OrganizationInvitation:
    check_email_available(auth_client, organization.id, email)
    now = utcnow()
    db.execute(select(Organization.id).where(Organization.id == organization.id).with_for_update())  # serialize per organization
    if _email_in_use(db, organization, email):
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "This person is already listed as an administrator of this organization.")

    row = OrganizationInvitation(
        organization_id=organization.id,
        email=email,
        full_name=full_name,
        token_hash=hash_token(generate_token()),  # never emailed: demo accounts need no activation link
        expires_at=now + INVITATION_TTL,
        created_at=now,
        accepted_at=now,
    )
    db.add(row)
    try:
        db.flush()
        _provision_and_email(db, auth_client, organization, row)
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(row)
    return row


# --- create ------------------------------------------------------------------
def invite_administrator(
    db: Session, auth_client: httpx.Client, organization: Organization, *, email: str, full_name: Optional[str]
) -> OrganizationInvitation:
    email = email.strip().lower()
    if demo_mode():
        return _invite_demo(db, auth_client, organization, email=email, full_name=clean_name(full_name))
    check_email_available(auth_client, organization.id, email)
    return issue_invitation(db, organization, resend=False, email=email, full_name=clean_name(full_name))


# --- resend ------------------------------------------------------------------
def resend_administrator_invitation(
    db: Session, auth_client: httpx.Client, organization: Organization, admin_id: str
) -> OrganizationInvitation:
    row = _find_row(db, organization, admin_id)
    if demo_mode():
        # Demo: (re)send the sign-in details, creating the account first if the row was still only invited.
        try:
            _provision_and_email(db, auth_client, organization, row)
            if row.accepted_at is None:
                row.accepted_at = utcnow()
            db.commit()
        except Exception:
            db.rollback()
            raise
        db.refresh(row)
        return row

    if row.accepted_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This administrator has already activated their account.")
    check_email_available(auth_client, organization.id, row.email)
    return issue_invitation(db, organization, resend=True, email=row.email, full_name=row.full_name)


# --- update ------------------------------------------------------------------
def update_administrator(
    db: Session,
    auth_client: httpx.Client,
    organization: Organization,
    admin_id: str,
    *,
    full_name: Optional[str],
    email: Optional[str],
) -> OrganizationInvitation:
    """Change an administrator's name and/or email.

    Active account: the Auth Service account is updated first (idempotent), then our records.
    Not yet active: the name is edited in place; a new email replaces the invitation (the old link dies).
    """
    row = _find_row(db, organization, admin_id)
    new_name = clean_name(full_name)
    new_email = email.strip().lower() if email else None
    changes_email = bool(new_email) and new_email != row.email
    if not new_name and not changes_email:
        return row

    if changes_email:
        if _email_in_use(db, organization, new_email, exclude=row.id):
            raise HTTPException(status.HTTP_409_CONFLICT, "This email address is already listed for this organization.")
        check_email_available(auth_client, organization.id, new_email)

    if row.accepted_at is not None:  # an active account
        body = {"organization_id": str(organization.id), "email": row.email}
        if new_name:
            body["new_full_name"] = new_name
        if changes_email:
            body["new_email"] = new_email
        response = _auth_post(auth_client, "/internal/organization-admins/update", body)
        if response.status_code != status.HTTP_200_OK:
            _raise_for_account_service(response)
        values = {}
        if new_name:
            values["full_name"] = new_name
        if changes_email:
            values["email"] = new_email
        db.execute(
            update(OrganizationInvitation)
            .where(OrganizationInvitation.organization_id == organization.id, OrganizationInvitation.email == row.email)
            .values(**values)
        )
        db.commit()
        db.refresh(row)
        if changes_email and demo_mode():  # the new address owner needs to know the sign-in details
            try:
                send_credentials_email(
                    to_email=row.email, organization_name=organization.name, login_url=build_login_url(),
                    password=demo_password(), recipient_name=row.full_name,
                )
            except EmailDeliveryError:
                logger.warning("Administrator email changed but the credentials email could not be sent")
        return row

    # not yet active
    if not changes_email:
        row.full_name = new_name
        db.commit()
        db.refresh(row)
        return row

    # a new address means a new invitation; the old one is revoked in the same transaction, so if the
    # new email cannot be sent the old invitation is still there
    row.revoked_at = utcnow()
    db.flush()
    try:
        if demo_mode():
            return _invite_demo(db, auth_client, organization, email=new_email, full_name=new_name or row.full_name)
        return issue_invitation(db, organization, resend=False, email=new_email, full_name=new_name or row.full_name)
    except Exception:
        db.rollback()
        raise


# --- delete ------------------------------------------------------------------
def delete_administrator(db: Session, auth_client: httpx.Client, organization: Organization, admin_id: str) -> None:
    """Remove an administrator: their account (if it exists) and every invitation record for that email."""
    row = _find_row(db, organization, admin_id)
    if row.accepted_at is not None:
        _delete_account(auth_client, organization.id, row.email)  # if this fails nothing is deleted
    db.execute(
        delete(OrganizationInvitation).where(
            OrganizationInvitation.organization_id == organization.id, OrganizationInvitation.email == row.email
        )
    )
    db.commit()


# --- list --------------------------------------------------------------------
def list_administrators(db: Session) -> List[Tuple[OrganizationInvitation, Organization]]:
    """One row per administrator invitation, newest first. Replaced (revoked) invitations are hidden."""
    return list(
        db.execute(
            select(OrganizationInvitation, Organization)
            .join(Organization, Organization.id == OrganizationInvitation.organization_id)
            .where(OrganizationInvitation.revoked_at.is_(None))
            .order_by(OrganizationInvitation.created_at.desc(), OrganizationInvitation.id)
        ).all()
    )


def administrator_status(invitation: OrganizationInvitation) -> str:
    return STATUS_LABELS[invitation_status(invitation)]
