from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.auth import create_auth_client, require_super_admin


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
class OrganizationCreate(BaseModel):
    name: str
    slug: str
    country_code: str
    tax_identifier: Optional[str] = None
    contact_email: str


class OrganizationResponse(BaseModel):
    id: str
    name: str
    slug: str
    country_code: str
    tax_identifier: Optional[str] = None
    contact_email: str
    is_active: bool
    created_at: str


# In-memory mock storage
organizations_db: List[dict] = [
    {
        "id": "org_default_01",
        "name": "Global Trade Logistics Corp",
        "slug": "global-trade-logistics",
        "country_code": "US",
        "tax_identifier": "US-987654321",
        "contact_email": "ops@globaltrade.local",
        "is_active": True,
        "created_at": "2026-01-15T08:00:00Z"
    }
]


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
async def list_organizations():
    return organizations_db


@app.post("/api/v1/organizations", response_model=OrganizationResponse, status_code=status.HTTP_201_CREATED, tags=["Organizations"], dependencies=super_admin_only)
async def create_organization(payload: OrganizationCreate):
    for org in organizations_db:
        if org["slug"] == payload.slug:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Organization slug '{payload.slug}' already exists."
            )
    new_org = {
        "id": f"org_{len(organizations_db) + 1:04d}",
        "name": payload.name,
        "slug": payload.slug,
        "country_code": payload.country_code,
        "tax_identifier": payload.tax_identifier,
        "contact_email": payload.contact_email,
        "is_active": True,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    organizations_db.append(new_org)
    return new_org


@app.get("/api/v1/organizations/{org_id}", response_model=OrganizationResponse, tags=["Organizations"], dependencies=super_admin_only)
async def get_organization(org_id: str):
    for org in organizations_db:
        if org["id"] == org_id or org["slug"] == org_id:
            return org
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Organization '{org_id}' not found."
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)

