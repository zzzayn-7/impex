"""First-time company setup: the company name and logo, and the status that gates the portal.

This module owns the COMPANY side of onboarding (the administrator's own profile lives in the Auth Service). Every endpoint:

  * belongs to an ACTIVE organization administrator and works on THEIR organization only - the organization comes from the
    verified token, never from the URL, query string, headers or body (see app/auth.py and docs/multi-tenancy.md);
  * can change nothing about the organization's slug, id, country, tax id, contact e-mail or ownership: only the name, the logo
    and the setup status;
  * is serialized by a row lock on the organization, so two administrators logging in for the first time at the same moment
    cannot corrupt the setup: the first to complete wins and the other simply sees it completed;
  * stops working for editing once setup is completed (409 `setup_completed`): later changes belong to a future Organization
    Settings screen, not to the first-time wizard.

Setup states: pending -> in_progress (something was saved) -> completed. Completing requires a stored, readable logo and a valid
company name, and records when and by whom.
"""
import logging
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth import TenantContext, require_tenant_admin
from app.database import get_db
from app.images import LogoRejected, STORED_CONTENT_TYPE, max_bytes, normalize_logo
from app.models import Organization
from app.storage import LogoStorage, StorageError, get_logo_storage

logger = logging.getLogger("impex.onboarding")

router = APIRouter(prefix="/api/v1/tenant", tags=["Onboarding"])

COMPANY_NAME_MIN, COMPANY_NAME_MAX = 2, 120
_NAME_PUNCTUATION = set(" .,'’()-/+:;!@#&\"")


def fail(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code, detail={"code": code, "message": message})


def clean_company_name(value: object) -> str:
    """Whitespace collapsed; 2-120 characters of letters, digits, accents, spaces and common business punctuation."""
    if not isinstance(value, str):
        raise fail(422, "invalid_company_name", "Enter your company name.")
    name = " ".join(unicodedata.normalize("NFC", value).split())
    if len(name) < COMPANY_NAME_MIN or len(name) > COMPANY_NAME_MAX:
        raise fail(422, "invalid_company_name", f"The company name must be {COMPANY_NAME_MIN} to {COMPANY_NAME_MAX} characters.")
    for ch in name:
        if not (ch.isalnum() or ch in _NAME_PUNCTUATION or unicodedata.category(ch).startswith("M")):
            raise fail(422, "invalid_company_name", "Use letters, numbers, spaces and . , ' ( ) - / & + : ; ! @ # only.")
    if not any(ch.isalnum() for ch in name):
        raise fail(422, "invalid_company_name", "Enter your company name.")
    return name


# --- schemas ------------------------------------------------------------------------------------------------------
class CompanyUpdate(BaseModel):
    """Only the name. Slug, id, country, tax id, contact e-mail and ownership are not accepted (422)."""

    model_config = ConfigDict(extra="forbid")

    name: str


class CompleteSetup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    company_name: str  # the name the administrator confirmed; saved in the same transaction as the completion


class OnboardingStatus(BaseModel):
    setup_status: str  # pending | in_progress | completed
    setup_completed_at: Optional[str] = None
    company_name: str
    has_logo: bool
    logo_version: Optional[str] = None  # changes whenever the logo does (cache-busting for the image URL)
    can_edit: bool  # False once setup is completed: the first-time wizard is closed


def logo_version(org: Organization) -> Optional[str]:
    return str(int(org.logo_updated_at.timestamp() * 1000)) if org.logo_storage_key and org.logo_updated_at else None


def to_status(org: Organization) -> OnboardingStatus:
    return OnboardingStatus(
        setup_status=org.setup_status,
        setup_completed_at=org.setup_completed_at.isoformat() if org.setup_completed_at else None,
        company_name=org.name,
        has_logo=bool(org.logo_storage_key),
        logo_version=logo_version(org),
        can_edit=org.setup_status != "completed",
    )


# --- the organization behind the token -------------------------------------------------------------------------------
def get_org(db: Session, tenant: TenantContext, *, lock: bool = False) -> Organization:
    """The caller's own organization (an inactive or missing one is the same 403). `lock=True` serializes concurrent changes."""
    statement = select(Organization).where(Organization.id == tenant.organization_id)
    if lock:
        statement = statement.with_for_update()
    org = db.scalar(statement)
    if org is None or not org.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your organization is not active.")
    return org


def require_open(org: Organization) -> None:
    if org.setup_status == "completed":
        raise fail(409, "setup_completed", "Company setup is already completed.")


def begin(org: Organization) -> None:
    if org.setup_status == "pending":
        org.setup_status = "in_progress"


# --- status -----------------------------------------------------------------------------------------------------------
@router.get("/onboarding", response_model=OnboardingStatus)
def get_onboarding(tenant: TenantContext = Depends(require_tenant_admin), db: Session = Depends(get_db)):
    """Where company setup stands. Safe to call repeatedly (a page refresh simply asks again)."""
    return to_status(get_org(db, tenant))


# --- company name ------------------------------------------------------------------------------------------------------
@router.put("/onboarding/company", response_model=OnboardingStatus)
def save_company(payload: CompanyUpdate, tenant: TenantContext = Depends(require_tenant_admin), db: Session = Depends(get_db)):
    name = clean_company_name(payload.name)
    org = get_org(db, tenant, lock=True)
    try:
        require_open(org)
        org.name = name
        begin(org)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    return to_status(org)


# --- logo --------------------------------------------------------------------------------------------------------------
@router.put("/onboarding/logo", response_model=OnboardingStatus)
def upload_logo(
    file: UploadFile = File(...),
    tenant: TenantContext = Depends(require_tenant_admin),
    db: Session = Depends(get_db),
    storage: LogoStorage = Depends(get_logo_storage),
):
    """Upload or replace the company logo (PNG, JPEG or WebP). The bytes are decoded and re-encoded; see app/images.py."""
    get_org(db, tenant)  # 403 for an inactive organization before any work is done
    limit = max_bytes()
    data = file.file.read(limit + 1)  # never read more than the limit allows
    try:
        logo = normalize_logo(data, file.content_type or "")
    except LogoRejected as exc:
        raise fail(exc.status_code, exc.code, exc.message)

    key = storage.new_key()
    try:
        storage.write(key, logo.data)
    except StorageError:
        logger.exception("logo storage write failed")
        raise fail(503, "storage_unavailable", "The logo could not be saved right now. Please try again in a moment.")

    old_key: Optional[str] = None
    try:
        org = get_org(db, tenant, lock=True)
        require_open(org)
        old_key = org.logo_storage_key
        org.logo_storage_key, org.logo_content_type, org.logo_updated_at = key, STORED_CONTENT_TYPE, datetime.now(timezone.utc)
        begin(org)
        db.commit()
    except (HTTPException, SQLAlchemyError):
        db.rollback()
        storage.delete(key)  # nothing refers to the new file: do not leave it behind
        raise
    if old_key:
        storage.delete(old_key)  # only after the new logo is committed
    return to_status(org)


@router.delete("/onboarding/logo", response_model=OnboardingStatus)
def remove_logo(
    tenant: TenantContext = Depends(require_tenant_admin), db: Session = Depends(get_db), storage: LogoStorage = Depends(get_logo_storage)
):
    org = get_org(db, tenant, lock=True)
    try:
        require_open(org)
        old_key = org.logo_storage_key
        org.logo_storage_key = org.logo_content_type = org.logo_updated_at = None
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    if old_key:
        storage.delete(old_key)
    return to_status(org)


@router.get("/organization/logo")
def get_logo(
    request: Request,
    tenant: TenantContext = Depends(require_tenant_admin),
    db: Session = Depends(get_db),
    storage: LogoStorage = Depends(get_logo_storage),
):
    """The caller's own organization's logo. Authenticated and tenant-bound: there is no id to change, and the storage key is
    never exposed. Served as a plain image with `nosniff` and a CSP that forbids everything, so it can never run as a page."""
    org = get_org(db, tenant)
    if not org.logo_storage_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No logo.")
    etag = f'"{logo_version(org)}"'
    headers = {"ETag": etag, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    try:
        data = storage.read(org.logo_storage_key)
    except StorageError:
        raise fail(503, "storage_unavailable", "The logo is temporarily unavailable.")
    if data is None:
        logger.error("organization %s refers to a logo file that is missing from storage", org.id)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No logo.")
    return Response(content=data, media_type=org.logo_content_type or STORED_CONTENT_TYPE, headers=headers)


# --- completing --------------------------------------------------------------------------------------------------------
@router.post("/onboarding/complete", response_model=OnboardingStatus)
def complete_setup(
    payload: CompleteSetup,
    tenant: TenantContext = Depends(require_tenant_admin),
    db: Session = Depends(get_db),
    storage: LogoStorage = Depends(get_logo_storage),
):
    """Finish company setup: the confirmed name and a stored logo are required. One transaction; repeating it (a retry, or a second
    administrator arriving at the same moment) changes nothing and answers with the completed state."""
    name = clean_company_name(payload.company_name)
    org = get_org(db, tenant, lock=True)
    try:
        if org.setup_status == "completed":
            db.rollback()  # idempotent: the first completion (time, person, name) stands
            return to_status(org)
        if not org.logo_storage_key:
            raise fail(409, "logo_required", "Upload your company logo to finish setup.")
        try:
            durable = storage.exists(org.logo_storage_key)
        except StorageError:
            raise fail(503, "storage_unavailable", "The logo could not be verified right now. Please try again in a moment.")
        if not durable:
            raise fail(409, "logo_required", "Your logo could not be found. Please upload it again.")
        org.name = name
        org.setup_status = "completed"
        org.setup_completed_at = datetime.now(timezone.utc)
        org.setup_completed_by = uuid.UUID(tenant.user_id)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    logger.info("organization %s completed company setup (by user %s)", org.id, tenant.user_id)
    return to_status(org)
