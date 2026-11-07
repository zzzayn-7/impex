"""Organization Settings: company profile, branding and business preferences, for the organization's own administrators.

  GET    /api/v1/tenant/settings              everything on the Settings page (company, read-only facts, branding, preferences, version)
  PATCH  /api/v1/tenant/settings/company      partial update of the editable company fields
  PATCH  /api/v1/tenant/settings/preferences  partial update of the business preferences
  PUT    /api/v1/tenant/settings/logo         replace the company logo (the SAME validation and storage the first-time setup uses)
  DELETE /api/v1/tenant/settings/logo         remove the logo (the portal then shows a monogram)
  GET    /api/v1/tenant/settings/history      who changed what, and when
  (the logo itself is served by GET /api/v1/tenant/organization/logo, which already exists and is tenant-bound)

Rules, in one place:
  * The organization and the person come ONLY from the verified token (see app/auth.py). No id is accepted from the request, and every
    request model refuses fields it does not name (422): the id, slug, country, tax id, status, ownership and setup state cannot be sent.
  * Settings open once first-time setup is completed (403 `setup_required` before). Saving settings never touches the setup state.
  * Every change names the settings version it was made from (`expected_version`). The organization row is locked while checking and
    writing, so two administrators cannot silently overwrite each other: the later one gets 409 `version_conflict` together with the
    current settings. Each successful change adds one to the version.
  * Every change is recorded in an append-only history (field, previous value, new value, who, when). Never a secret, never a storage key.
  * PREFERENCES ARE DEFAULTS AND PRESENTATION ONLY. Nothing here reads, converts or rewrites an invoice, purchase order, payment, stock
    quantity or timestamp: those live in other services and keep the values (and the company-name snapshots) they were made with.
"""
import logging
import re
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit
from zoneinfo import available_timezones

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth import TenantContext, require_tenant_admin
from app.currencies import ISO_4217
from app.database import get_db
from app.images import LogoRejected, STORED_CONTENT_TYPE, max_bytes, normalize_logo
from app.models import Organization, OrganizationSettingsHistory
from app.onboarding import clean_company_name, fail, get_org, logo_version
from app.storage import LogoStorage, StorageError, get_logo_storage

logger = logging.getLogger("impex.settings")
router = APIRouter(prefix="/api/v1/tenant/settings", tags=["Settings"])

DATE_FORMATS = ("DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD")
NUMBER_FORMATS = ("comma_dot", "dot_comma", "space_comma", "indian")  # 1,234,567.89 | 1.234.567,89 | 1 234 567,89 | 12,34,567.89
COMPANY_FIELDS = ("name", "contact_email", "contact_phone", "address_street", "address_city", "address_state", "address_postal_code", "website", "description")
PREFERENCE_FIELDS = ("default_currency", "timezone", "date_format", "number_format")
EMAIL_RE = re.compile(r"^[^\s@<>\",;:\\]+@[^\s@<>\",;:\\]+\.[^\s@<>\",;:\\]+$")
PHONE_ALLOWED = re.compile(r"^[0-9+()\-./ ]+$")


# ------------------------------------------------------------------------------------------------------ validation
def invalid(field: str, message: str) -> HTTPException:
    return HTTPException(422, detail={"code": "invalid_field", "field": field, "message": message})


def _clean_line(value: Any, field: str, label: str, maximum: int, *, required: bool = False) -> Optional[str]:
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise invalid(field, f"Enter the {label}.")
        return None
    if not isinstance(value, str):
        raise invalid(field, f"Enter a valid {label}.")
    text = " ".join(unicodedata.normalize("NFC", value).split())
    if any(unicodedata.category(ch)[0] == "C" for ch in text) or "<" in text or ">" in text:
        raise invalid(field, f"The {label} contains characters that are not allowed.")
    if len(text) > maximum:
        raise invalid(field, f"The {label} can be at most {maximum} characters.")
    return text


def clean_email(value: Any) -> str:
    text = _clean_line(value, "contact_email", "business contact e-mail", 320, required=True)
    assert text is not None
    text = text.lower()
    if not EMAIL_RE.match(text):
        raise invalid("contact_email", "Enter a valid e-mail address, for example office@yourcompany.com.")
    return text


def clean_phone(value: Any) -> Optional[str]:
    text = _clean_line(value, "contact_phone", "phone number", 40)
    if text is None:
        return None
    if not PHONE_ALLOWED.match(text) or sum(ch.isdigit() for ch in text) < 5:
        raise invalid("contact_phone", "Enter a phone number with digits and + ( ) - . / only, for example +92 21 1234567.")
    return text


def clean_website(value: Any) -> Optional[str]:
    text = _clean_line(value, "website", "website", 255)
    if text is None:
        return None
    candidate = text if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", text) else f"https://{text}"
    try:
        parts = urlsplit(candidate)
        host = parts.hostname or ""
    except ValueError:
        raise invalid("website", "Enter a valid website address, for example https://www.yourcompany.com.")
    if parts.scheme not in ("http", "https") or "@" in parts.netloc or " " in text or "." not in host or len(host) < 4 or not re.match(r"^[A-Za-z0-9.-]+$", host):
        raise invalid("website", "Enter a valid website address starting with http:// or https://, for example https://www.yourcompany.com.")
    normalized = f"{parts.scheme}://{host.lower()}" + (f":{parts.port}" if parts.port else "") + (parts.path if parts.path != "/" else "") + (f"?{parts.query}" if parts.query else "")
    if len(normalized) > 255:
        raise invalid("website", "The website address can be at most 255 characters.")
    return normalized


def clean_description(value: Any) -> Optional[str]:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if not isinstance(value, str):
        raise invalid("description", "Enter a valid description.")
    lines = [" ".join(unicodedata.normalize("NFC", line).split()) for line in value.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    text = "\n".join(lines).strip("\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    if any(unicodedata.category(ch)[0] == "C" and ch != "\n" for ch in text) or "<" in text or ">" in text:
        raise invalid("description", "The description contains characters that are not allowed.")
    if len(text) > 1000:
        raise invalid("description", "The description can be at most 1000 characters.")
    return text or None


def clean_currency(value: Any) -> str:
    code = value.strip().upper() if isinstance(value, str) else ""
    if code not in ISO_4217:
        raise invalid("default_currency", "Choose a valid ISO 4217 currency code such as PKR, USD, EUR, GBP or AED.")
    return code


def clean_timezone(value: Any) -> str:
    name = value.strip() if isinstance(value, str) else ""
    if not name or name not in available_timezones():
        raise invalid("timezone", "Choose a valid time zone such as Asia/Karachi, America/New_York or Europe/London.")
    return name


def clean_choice(value: Any, field: str, allowed: tuple, label: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise invalid(field, f"Choose one of the available {label} formats.")
    return value


CLEANERS = {
    "name": lambda v: clean_company_name(v),
    "contact_email": clean_email,
    "contact_phone": clean_phone,
    "address_street": lambda v: _clean_line(v, "address_street", "street address", 255),
    "address_city": lambda v: _clean_line(v, "address_city", "city", 120),
    "address_state": lambda v: _clean_line(v, "address_state", "state or province", 120),
    "address_postal_code": lambda v: _clean_line(v, "address_postal_code", "postal code", 30),
    "website": clean_website,
    "description": clean_description,
    "default_currency": clean_currency,
    "timezone": clean_timezone,
    "date_format": lambda v: clean_choice(v, "date_format", DATE_FORMATS, "date"),
    "number_format": lambda v: clean_choice(v, "number_format", NUMBER_FORMATS, "number"),
}


# ------------------------------------------------------------------------------------------------------ schemas
class CompanyPatch(BaseModel):
    """The editable company fields. Anything else (id, slug, country, tax id, status, ownership, setup state) is refused with 422."""

    model_config = ConfigDict(extra="forbid")

    expected_version: int = Field(ge=1)
    name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    address_street: Optional[str] = None
    address_city: Optional[str] = None
    address_state: Optional[str] = None
    address_postal_code: Optional[str] = None
    website: Optional[str] = None
    description: Optional[str] = None


class PreferencesPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: int = Field(ge=1)
    default_currency: Optional[str] = None
    timezone: Optional[str] = None
    date_format: Optional[str] = None
    number_format: Optional[str] = None


class CompanyView(BaseModel):
    name: str
    contact_email: str
    contact_phone: Optional[str]
    address_street: Optional[str]
    address_city: Optional[str]
    address_state: Optional[str]
    address_postal_code: Optional[str]
    website: Optional[str]
    description: Optional[str]


class RestrictedView(BaseModel):
    """Facts the administrator can see but not edit here: a change goes through Help & Support."""

    id: str
    slug: str
    country_code: str
    tax_identifier: Optional[str]
    owner_email: Optional[str]
    status: str
    created_at: str


class BrandingView(BaseModel):
    has_logo: bool
    logo_version: Optional[str]


class PreferencesView(BaseModel):
    default_currency: str
    timezone: str
    date_format: str
    number_format: str


class SettingsView(BaseModel):
    version: int
    setup_status: str
    updated_at: Optional[str]
    company: CompanyView
    restricted: RestrictedView
    branding: BrandingView
    preferences: PreferencesView


class HistoryItem(BaseModel):
    id: str
    section: str
    field: str
    old_value: Optional[str]
    new_value: Optional[str]
    changed_by_name: Optional[str]
    changed_by_email: Optional[str]
    source: str
    version: int
    batch_id: str
    created_at: str


class HistoryPage(BaseModel):
    items: List[HistoryItem]
    total: int


def to_view(org: Organization) -> SettingsView:
    return SettingsView(
        version=org.settings_version,
        setup_status=org.setup_status,
        updated_at=org.settings_updated_at.isoformat() if org.settings_updated_at else None,
        company=CompanyView(**{f: getattr(org, f) for f in COMPANY_FIELDS}),
        restricted=RestrictedView(
            id=str(org.id), slug=org.slug, country_code=org.country_code, tax_identifier=org.tax_identifier, owner_email=org.primary_admin_email,
            status="Active" if org.is_active else "Inactive", created_at=org.created_at.isoformat(),
        ),
        branding=BrandingView(has_logo=bool(org.logo_storage_key), logo_version=logo_version(org)),
        preferences=PreferencesView(**{f: getattr(org, f) for f in PREFERENCE_FIELDS}),
    )


# ------------------------------------------------------------------------------------------------------ helpers
def require_completed(org: Organization) -> None:
    """Settings belong to a configured organization. First-time setup is its own flow (and is never restarted from here)."""
    if org.setup_status != "completed":
        raise fail(403, "setup_required", "Finish the first-time setup before using Settings.")


def conflict(org: Organization) -> HTTPException:
    return HTTPException(409, detail={"code": "version_conflict", "message": "These settings were changed by someone else while you were editing. The current values are shown; review them and save again.", "current": to_view(org).model_dump()})


def locked_org(db: Session, tenant: TenantContext, expected_version: int) -> Organization:
    """The caller's organization, locked, completed, and at the version the caller saw. (An inactive organization is the usual 403.)"""
    org = get_org(db, tenant, lock=True)
    require_completed(org)
    if org.settings_version != expected_version:
        raise conflict(org)
    return org


def record(db: Session, org: Organization, tenant: TenantContext, section: str, changes: Dict[str, tuple]) -> None:
    """Bump the version once and write one history row per changed field, all in the caller's transaction."""
    org.settings_version += 1
    org.settings_updated_at = datetime.now(timezone.utc)
    org.settings_updated_by = uuid.UUID(tenant.user_id)
    batch = uuid.uuid4()
    for field, (old, new) in changes.items():
        db.add(OrganizationSettingsHistory(
            organization_id=org.id, section=section, field=field, old_value=old, new_value=new, changed_by=uuid.UUID(tenant.user_id),
            changed_by_name=tenant.full_name or None, changed_by_email=tenant.email or None, source="settings", version=org.settings_version, batch_id=batch,
        ))


def apply_patch(db: Session, org: Organization, tenant: TenantContext, payload: BaseModel, fields: tuple, section: str) -> None:
    sent = payload.model_fields_set - {"expected_version"}
    if not sent:
        raise HTTPException(422, detail={"code": "nothing_to_change", "message": "Send at least one field to change."})
    cleaned: Dict[str, Any] = {}
    for field in fields:
        if field in sent:
            value = getattr(payload, field)
            if value is None and field in ("name", "contact_email", "default_currency", "timezone", "date_format", "number_format"):
                raise invalid(field, "This field cannot be empty.")
            cleaned[field] = CLEANERS[field](value)
    changes = {f: (getattr(org, f), v) for f, v in cleaned.items() if getattr(org, f) != v}
    if not changes:
        db.rollback()  # nothing differs: no version bump, no history
        return
    for field, (_old, new) in changes.items():
        setattr(org, field, new)
    record(db, org, tenant, section, {f: (None if o is None else str(o), None if n is None else str(n)) for f, (o, n) in changes.items()})
    db.commit()


# ------------------------------------------------------------------------------------------------------ endpoints
@router.get("", response_model=SettingsView)
def get_settings(tenant: TenantContext = Depends(require_tenant_admin), db: Session = Depends(get_db)):
    org = get_org(db, tenant)
    require_completed(org)
    return to_view(org)


@router.patch("/company", response_model=SettingsView)
def patch_company(payload: CompanyPatch, tenant: TenantContext = Depends(require_tenant_admin), db: Session = Depends(get_db)):
    """Partial update: only the fields that are sent change. The slug and the id never do, whatever the name becomes."""
    try:
        org = locked_org(db, tenant, payload.expected_version)
        apply_patch(db, org, tenant, payload, COMPANY_FIELDS, "company")
    except (HTTPException, SQLAlchemyError):
        db.rollback()
        raise
    return to_view(org)


@router.patch("/preferences", response_model=SettingsView)
def patch_preferences(payload: PreferencesPatch, tenant: TenantContext = Depends(require_tenant_admin), db: Session = Depends(get_db)):
    """Defaults and presentation only: no stored record anywhere is converted or rewritten by changing these."""
    try:
        org = locked_org(db, tenant, payload.expected_version)
        apply_patch(db, org, tenant, payload, PREFERENCE_FIELDS, "preferences")
    except (HTTPException, SQLAlchemyError):
        db.rollback()
        raise
    return to_view(org)


@router.put("/logo", response_model=SettingsView)
def put_logo(
    file: UploadFile = File(...),
    expected_version: int = Form(..., ge=1),
    tenant: TenantContext = Depends(require_tenant_admin),
    db: Session = Depends(get_db),
    storage: LogoStorage = Depends(get_logo_storage),
):
    """Replace the logo. Same validation and storage as the first-time setup (PNG, JPEG or WebP, size and dimension limits, decoded and
    re-encoded); the previous file is deleted only after the new one is committed. Invoices already issued keep their own snapshots."""
    org = get_org(db, tenant)
    require_completed(org)
    data = file.file.read(max_bytes() + 1)  # never read more than the limit allows
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
        org = locked_org(db, tenant, expected_version)
        old_key = org.logo_storage_key
        org.logo_storage_key, org.logo_content_type, org.logo_updated_at = key, STORED_CONTENT_TYPE, datetime.now(timezone.utc)
        record(db, org, tenant, "branding", {"logo": ("present" if old_key else "none", "replaced" if old_key else "added")})
        db.commit()
    except (HTTPException, SQLAlchemyError):
        db.rollback()
        storage.delete(key)  # nothing refers to the new file: do not leave it behind
        raise
    if old_key:
        storage.delete(old_key)
    return to_view(org)


@router.delete("/logo", response_model=SettingsView)
def delete_logo(
    expected_version: int = Query(..., ge=1),
    tenant: TenantContext = Depends(require_tenant_admin),
    db: Session = Depends(get_db),
    storage: LogoStorage = Depends(get_logo_storage),
):
    """Remove the logo: the portal falls back to the company's monogram. (Removing no logo is a harmless no-op.)"""
    try:
        org = locked_org(db, tenant, expected_version)
        old_key = org.logo_storage_key
        if old_key:
            org.logo_storage_key = org.logo_content_type = org.logo_updated_at = None
            record(db, org, tenant, "branding", {"logo": ("present", "removed")})
            db.commit()
        else:
            db.rollback()
    except (HTTPException, SQLAlchemyError):
        db.rollback()
        raise
    if old_key:
        storage.delete(old_key)
    return to_view(org)


@router.get("/history", response_model=HistoryPage)
def get_history(limit: int = Query(default=25, ge=1, le=100), offset: int = Query(default=0, ge=0), tenant: TenantContext = Depends(require_tenant_admin), db: Session = Depends(get_db)):
    org = get_org(db, tenant)
    require_completed(org)
    where = OrganizationSettingsHistory.organization_id == org.id
    total = db.scalar(select(func.count()).select_from(OrganizationSettingsHistory).where(where)) or 0
    rows = db.scalars(select(OrganizationSettingsHistory).where(where).order_by(OrganizationSettingsHistory.seq.desc()).limit(limit).offset(offset)).all()
    return HistoryPage(total=total, items=[
        HistoryItem(
            id=str(r.id), section=r.section, field=r.field, old_value=r.old_value, new_value=r.new_value, changed_by_name=r.changed_by_name,
            changed_by_email=r.changed_by_email, source=r.source, version=r.version, batch_id=str(r.batch_id), created_at=r.created_at.isoformat(),
        ) for r in rows
    ])
