import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import create_auth_client, require_super_admin
from app.database import get_db
from app.models import Organization


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.auth_client = create_auth_client()
    yield
    await app.state.auth_client.aclose()


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


@app.get("/api/v1/organizations/{org_id}", response_model=OrganizationResponse, tags=["Organizations"], dependencies=super_admin_only)
def get_organization(org_id: str, db: Session = Depends(get_db)):
    # Look up by id (UUID) or by slug, as before.
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
    return to_response(org)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)

