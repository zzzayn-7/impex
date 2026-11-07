"""Service-to-service reads for the other services' BACKGROUND workers.

A worker has no user token (nobody is logged in when it runs), but it must still respect the Super Admin's decisions: it asks here whether an
organization is active, has completed first-time setup, and which modules it can use. The caller proves itself with the shared secret
MODULE_INTERNAL_API_KEY; the route is hidden from the public documentation and is not reachable from a browser. It only READS.
"""
import hmac
import os
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Organization, OrganizationModule
from app.modules_api import usable_modules

router = APIRouter(include_in_schema=False)


def require_internal_key(x_internal_key: Optional[str] = Header(default=None)) -> None:
    expected = os.getenv("MODULE_INTERNAL_API_KEY", "")
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Service authentication is not configured")
    if not x_internal_key or not hmac.compare_digest(x_internal_key.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid service credentials")


class Entitlements(BaseModel):
    organization_id: str
    is_active: bool
    setup_completed: bool
    modules: List[str]
    default_currency: str


@router.get("/internal/v1/organizations/{organization_id}/entitlements", response_model=Entitlements, dependencies=[Depends(require_internal_key)])
def entitlements(organization_id: uuid.UUID, db: Session = Depends(get_db)):
    organization = db.get(Organization, organization_id)
    if organization is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Organization not found.")
    return Entitlements(
        organization_id=str(organization.id), is_active=organization.is_active, setup_completed=organization.setup_status == "completed",
        modules=usable_modules(db, organization.id), default_currency=organization.default_currency,
    )


class ModuleOrganization(BaseModel):
    organization_id: str
    enabled_at: datetime  # when the Super Admin last changed this entitlement (the Finance cut-over time)
    default_currency: str


@router.get("/internal/v1/modules/{module_key}/organizations", response_model=List[ModuleOrganization], dependencies=[Depends(require_internal_key)])
def organizations_using(module_key: str, db: Session = Depends(get_db)):
    """The organizations that can use a module right now: active, first-time setup completed, the module switched on and its prerequisites met.
    The Finance worker asks this each cycle, so a disabled organization is simply not synchronised."""
    rows = db.execute(
        select(Organization, OrganizationModule.updated_at)
        .join(OrganizationModule, OrganizationModule.organization_id == Organization.id)
        .where(OrganizationModule.module_key == module_key, OrganizationModule.enabled.is_(True), Organization.is_active.is_(True), Organization.setup_status == "completed")
        .order_by(Organization.created_at, Organization.id)
    ).all()
    return [
        ModuleOrganization(organization_id=str(org.id), enabled_at=enabled_at, default_currency=org.default_currency)
        for org, enabled_at in rows if module_key in usable_modules(db, org.id)
    ]
