import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import Depends, FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.activation import (
    accept_invitation,
    create_internal_auth_client,
    get_internal_auth_client,
    lookup_invitation,
    require_activation_key,
)
from app.administrators import (
    ADMINISTRATOR_ROLE,
    administrator_status,
    delete_administrator,
    invite_administrator,
    list_administrators,
    resend_administrator_invitation,
    update_administrator,
)
from app.auth import create_auth_client, require_super_admin
from app.database import get_db
from app.invitations import invitation_status, issue_invitation
from app.models import Organization, OrganizationInvitation
from app.onboarding import logo_version, router as onboarding_router
from app.tenancy import require_tenant_organization


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.auth_client = create_auth_client()
    app.state.internal_auth_client = create_internal_auth_client()
    yield
    await app.state.auth_client.aclose()
    app.state.internal_auth_client.close()


app = FastAPI(
    title="Impex Organization Service",
    version="1.0.0",
    docs_url="/docs",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

# Organization management is restricted to active Super Admins (verified by the Auth Service).
# Health endpoints below intentionally do not use this.
super_admin_only = [Depends(require_super_admin)]

# First-time company setup (tenant administrators only; see app/onboarding.py).
app.include_router(onboarding_router)

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Schemas
# max_length values match the database column sizes
class OrganizationCreate(BaseModel):
    name: str = Field(max_length=255)
    slug: str = Field(max_length=100)
    country_code: str = Field(max_length=10)
    tax_identifier: Optional[str] = Field(default=None, max_length=100)
    contact_email: str = Field(max_length=320)
    # Recorded now; the invitation flow that uses it comes later.
    primary_admin_email: Optional[EmailStr] = Field(default=None, max_length=320)


class OrganizationResponse(BaseModel):
    id: str
    name: str
    slug: str
    country_code: str
    tax_identifier: Optional[str] = None
    contact_email: str
    primary_admin_email: Optional[str] = None
    is_active: bool
    created_at: str


def to_response(org: Organization) -> OrganizationResponse:
    return OrganizationResponse(
        id=str(org.id),
        name=org.name,
        slug=org.slug,
        country_code=org.country_code,
        tax_identifier=org.tax_identifier,
        contact_email=org.contact_email,
        primary_admin_email=org.primary_admin_email,
        is_active=org.is_active,
        created_at=org.created_at.isoformat(),
    )


class TenantOrganizationResponse(BaseModel):
    """What an organization's own administrator may see about their organization. Nothing about any other tenant."""
    id: str
    name: str
    slug: str
    country_code: str
    tax_identifier: Optional[str] = None
    contact_email: str
    is_active: bool
    created_at: str
    # First-time setup (never anything about another tenant): where it stands and whether a logo exists. The logo itself is
    # fetched from /api/v1/tenant/organization/logo; its storage key is never exposed.
    setup_status: str
    has_logo: bool
    logo_version: Optional[str] = None


def to_tenant_response(org: Organization) -> TenantOrganizationResponse:
    return TenantOrganizationResponse(
        id=str(org.id),
        name=org.name,
        slug=org.slug,
        country_code=org.country_code,
        tax_identifier=org.tax_identifier,
        contact_email=org.contact_email,
        is_active=org.is_active,
        created_at=org.created_at.isoformat(),
        setup_status=org.setup_status,
        has_logo=bool(org.logo_storage_key),
        logo_version=logo_version(org),
    )


class InvitationResponse(BaseModel):
    """Invitation metadata. The token is never part of any API response; it only exists in the email."""
    id: str
    organization_id: str
    email: str
    status: str
    expires_at: str
    accepted_at: Optional[str] = None
    created_at: str


def to_invitation_response(invitation: OrganizationInvitation) -> InvitationResponse:
    return InvitationResponse(
        id=str(invitation.id),
        organization_id=str(invitation.organization_id),
        email=invitation.email,
        status=invitation_status(invitation),
        expires_at=invitation.expires_at.isoformat(),
        accepted_at=invitation.accepted_at.isoformat() if invitation.accepted_at else None,
        created_at=invitation.created_at.isoformat(),
    )


class AdministratorCreate(BaseModel):
    """Only a name and an email. The role is fixed and the organization comes from the URL."""
    full_name: Optional[str] = Field(default=None, max_length=255)
    email: EmailStr


class AdministratorUpdate(BaseModel):
    """Editable fields only. The role and the organization can never be changed here."""
    full_name: Optional[str] = Field(default=None, max_length=255)
    email: Optional[EmailStr] = None


class AdministratorResponse(BaseModel):
    """An administrator and their invitation/account state. Never contains a token or hash."""
    id: str
    organization_id: str
    organization_name: str
    organization_slug: str
    full_name: Optional[str] = None
    email: str
    role: str
    status: str  # pending | active | expired
    invited_at: str
    expires_at: str
    activated_at: Optional[str] = None


def to_administrator_response(invitation: OrganizationInvitation, organization: Organization) -> AdministratorResponse:
    return AdministratorResponse(
        id=str(invitation.id),
        organization_id=str(organization.id),
        organization_name=organization.name,
        organization_slug=organization.slug,
        full_name=invitation.full_name,
        email=invitation.email,
        role=ADMINISTRATOR_ROLE,
        status=administrator_status(invitation),
        invited_at=invitation.created_at.isoformat(),
        expires_at=invitation.expires_at.isoformat(),
        activated_at=invitation.accepted_at.isoformat() if invitation.accepted_at else None,
    )


def find_organization(db: Session, org_id: str) -> Organization:
    # Look up by id (UUID) or by slug.
    org = None
    try:
        org = db.get(Organization, uuid.UUID(org_id))
    except ValueError:
        pass
    if org is None:
        org = db.scalar(select(Organization).where(Organization.slug == org_id))
    if org is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Organization '{org_id}' not found."
        )
    return org


def slug_exists(db: Session, slug: str) -> bool:
    return db.scalar(select(Organization.id).where(Organization.slug == slug)) is not None


# Routes
@app.get("/health", tags=["Health"])
@app.get("/api/v1/organizations/health", tags=["Health"])
async def health_check():
    return {
        "status": "healthy",
        "service": "organization-service",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


# ---------------------------------------------------------------------------
# Tenant API: an organization administrator's view of their OWN organization.
# Deliberately has no id, query, header or body input: the organization is taken only from the authenticated
# user's record (see app/auth.py and docs/multi-tenancy.md), so there is nothing to manipulate.
# ---------------------------------------------------------------------------
@app.get("/api/v1/tenant/organization", response_model=TenantOrganizationResponse, tags=["Tenant"])
def get_my_organization(organization: Organization = Depends(require_tenant_organization)):
    return to_tenant_response(organization)


@app.get("/api/v1/organizations", response_model=List[OrganizationResponse], tags=["Organizations"], dependencies=super_admin_only)
def list_organizations(db: Session = Depends(get_db)):
    orgs = db.scalars(select(Organization).order_by(Organization.created_at, Organization.id)).all()
    return [to_response(org) for org in orgs]


@app.post("/api/v1/organizations", response_model=OrganizationResponse, status_code=status.HTTP_201_CREATED, tags=["Organizations"], dependencies=super_admin_only)
def create_organization(payload: OrganizationCreate, db: Session = Depends(get_db)):
    slug_conflict = HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"Organization slug '{payload.slug}' already exists."
    )
    if slug_exists(db, payload.slug):
        raise slug_conflict

    org = Organization(
        name=payload.name,
        slug=payload.slug,
        country_code=payload.country_code,
        tax_identifier=payload.tax_identifier,
        contact_email=payload.contact_email,
        primary_admin_email=str(payload.primary_admin_email).lower() if payload.primary_admin_email else None,
    )
    db.add(org)
    try:
        db.commit()
    except IntegrityError:  # two requests with the same slug raced past the check above
        db.rollback()
        raise slug_conflict
    db.refresh(org)
    return to_response(org)


@app.get("/api/v1/organizations/administrators", response_model=List[AdministratorResponse], tags=["Administrators"], dependencies=super_admin_only)
def list_organization_administrators(db: Session = Depends(get_db)):
    return [to_administrator_response(invitation, org) for invitation, org in list_administrators(db)]


@app.get("/api/v1/organizations/{org_id}", response_model=OrganizationResponse, tags=["Organizations"], dependencies=super_admin_only)
def get_organization(org_id: str, db: Session = Depends(get_db)):
    return to_response(find_organization(db, org_id))


@app.post("/api/v1/organizations/{org_id}/invitations", response_model=InvitationResponse, status_code=status.HTTP_201_CREATED, tags=["Invitations"], dependencies=super_admin_only)
def invite_primary_admin(org_id: str, db: Session = Depends(get_db)):
    """Email an activation link (valid 24 hours, single use) to the organization's primary administrator."""
    org = find_organization(db, org_id)
    return to_invitation_response(issue_invitation(db, org, resend=False))


@app.post("/api/v1/organizations/{org_id}/administrators", response_model=AdministratorResponse, status_code=status.HTTP_201_CREATED, tags=["Administrators"], dependencies=super_admin_only)
def add_organization_administrator(
    org_id: str, payload: AdministratorCreate, db: Session = Depends(get_db), auth_client=Depends(get_internal_auth_client)
):
    """Invite a person to administer the organization: creates a pending invitation and emails the activation link."""
    org = find_organization(db, org_id)
    invitation = invite_administrator(db, auth_client, org, email=str(payload.email), full_name=payload.full_name)
    return to_administrator_response(invitation, org)


@app.patch("/api/v1/organizations/{org_id}/administrators/{admin_id}", response_model=AdministratorResponse, tags=["Administrators"], dependencies=super_admin_only)
def edit_organization_administrator(
    org_id: str, admin_id: str, payload: AdministratorUpdate, db: Session = Depends(get_db), auth_client=Depends(get_internal_auth_client)
):
    """Edit an administrator's name and/or email."""
    if payload.full_name is None and payload.email is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Provide a name or an email to change.")
    org = find_organization(db, org_id)
    invitation = update_administrator(
        db, auth_client, org, admin_id,
        full_name=payload.full_name, email=str(payload.email) if payload.email else None,
    )
    return to_administrator_response(invitation, org)


@app.delete("/api/v1/organizations/{org_id}/administrators/{admin_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["Administrators"], dependencies=super_admin_only)
def remove_organization_administrator(
    org_id: str, admin_id: str, db: Session = Depends(get_db), auth_client=Depends(get_internal_auth_client)
):
    """Remove an administrator: their account (if activated) and their invitations."""
    org = find_organization(db, org_id)
    delete_administrator(db, auth_client, org, admin_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/api/v1/organizations/{org_id}/administrators/{admin_id}/resend", response_model=AdministratorResponse, status_code=status.HTTP_201_CREATED, tags=["Administrators"], dependencies=super_admin_only)
def resend_organization_administrator(
    org_id: str, admin_id: str, db: Session = Depends(get_db), auth_client=Depends(get_internal_auth_client)
):
    """Replace a pending or expired invitation with a fresh one (the old link stops working)."""
    org = find_organization(db, org_id)
    invitation = resend_administrator_invitation(db, auth_client, org, admin_id)
    return to_administrator_response(invitation, org)


@app.post("/api/v1/organizations/{org_id}/invitations/resend", response_model=InvitationResponse, status_code=status.HTTP_201_CREATED, tags=["Invitations"], dependencies=super_admin_only)
def resend_primary_admin_invitation(org_id: str, db: Session = Depends(get_db)):
    """Invalidate the pending invitation and email a new one."""
    org = find_organization(db, org_id)
    return to_invitation_response(issue_invitation(db, org, resend=True))


# ---------------------------------------------------------------------------
# Internal activation API. Called only by the Super Admin portal's server-side routes, which hold
# ACTIVATION_API_KEY. Not routed by the gateway and hidden from the public docs. The invitation
# token in the request body is the invited person's credential; the organization, email and role
# are always taken from our own records, never from the request.
# ---------------------------------------------------------------------------
class ActivationLookup(BaseModel):
    token: str


class ActivationAccept(BaseModel):
    token: str
    full_name: str
    password: str


@app.post("/internal/invitations/lookup", include_in_schema=False, dependencies=[Depends(require_activation_key)])
def lookup_activation(payload: ActivationLookup, db: Session = Depends(get_db)):
    return lookup_invitation(db, payload.token)


@app.post("/internal/invitations/accept", status_code=status.HTTP_201_CREATED, include_in_schema=False,
          dependencies=[Depends(require_activation_key)])
def accept_activation(payload: ActivationAccept, db: Session = Depends(get_db), auth_client=Depends(get_internal_auth_client)):
    return accept_invitation(db, auth_client, token=payload.token, full_name=payload.full_name, password=payload.password)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)

