"""Locking and deleting an organization: the Super Admin's two decisions about a customer that stops paying or leaves the CRM.

LOCK (reversible): the organization's administrators can still sign in, but every business module is switched off for them: the tenant answer reports no usable
modules (so every service refuses the module routes, whatever a browser shows) and only Settings and Help & Support remain. The STORED module entitlements are left exactly as
they are, so unlocking gives back precisely what the organization had. Nothing of its data is touched.

DELETE (irreversible): for an organization that is no longer part of the CRM. It is locked first (so nobody can use it while it is being removed), then EVERY service
deletes everything it owns (finance, sales, purchasing, inventory, support, the administrators' accounts), then the logo file and the organization itself are removed. The
sequence is safe to repeat: if a service cannot be reached the organization stays locked and marked "being deleted", nothing further is removed, and running the deletion again
continues where it stopped. The Super Admin must type the organization's exact name to confirm. The only thing kept is an append-only record that it happened (who, when, the
name and how many rows each service removed): no business data.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.auth import require_super_admin
from app.database import get_db
from app.models import Organization, OrganizationLifecycleEvent
from app.modules_api import find_organization
from app.purge_client import SERVICES, PurgeClient, PurgeFailed, get_purge_client
from app.storage import LogoStorage, StorageError, get_logo_storage

logger = logging.getLogger("impex.lifecycle")
router = APIRouter(tags=["Lifecycle"])


# ------------------------------------------------------------------------------------------------ helpers
def _who(admin: dict) -> dict:
    try:
        actor_id: Optional[uuid.UUID] = uuid.UUID(str(admin.get("id")))
    except ValueError:
        actor_id = None
    return {"actor_id": actor_id, "actor_name": str(admin.get("full_name") or "") or None, "actor_email": str(admin.get("email") or "") or None}


def record(db: Session, organization: Organization, action: str, admin: dict, reason: Optional[str] = None, details: Optional[dict] = None) -> None:
    db.add(OrganizationLifecycleEvent(
        organization_id=organization.id, organization_name=organization.name, organization_slug=organization.slug, action=action, reason=reason, details=details, **_who(admin),
    ))


def _lock_row(db: Session, organization: Organization) -> Organization:
    """Serialize concurrent lock/unlock/delete of one organization on its row, and read its current state."""
    db.execute(select(Organization.id).where(Organization.id == organization.id).with_for_update())
    db.refresh(organization)
    return organization


def lock_organization(db: Session, organization: Organization, admin: dict, reason: Optional[str]) -> Organization:
    organization = _lock_row(db, organization)
    note = (reason or "").strip() or None
    if organization.is_locked:  # already locked: nothing to do (a changed note is kept, no second 'locked' record)
        if note and note != organization.lock_reason:
            organization.lock_reason = note
        db.commit()
        return organization
    organization.is_locked, organization.locked_at, organization.locked_by, organization.lock_reason = True, datetime.now(timezone.utc), _who(admin)["actor_id"], note
    record(db, organization, "locked", admin, note)
    db.commit()
    return organization


def unlock_organization(db: Session, organization: Organization, admin: dict) -> Organization:
    organization = _lock_row(db, organization)
    if organization.deletion_requested_at is not None:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "deletion_pending", "message": "This organization is being deleted. Finish or retry the deletion; it cannot be unlocked."})
    if not organization.is_locked:
        db.commit()
        return organization
    organization.is_locked, organization.locked_at, organization.locked_by, organization.lock_reason = False, None, None, None
    record(db, organization, "unlocked", admin)
    db.commit()
    return organization


def delete_organization(db: Session, organization: Organization, admin: dict, confirm_name: str, purge: PurgeClient, storage: LogoStorage) -> Dict[str, Dict[str, int]]:
    if (confirm_name or "").strip() != organization.name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "confirmation_mismatch", "message": "Type the organization's exact name to confirm the deletion."})
    organization = _lock_row(db, organization)
    now = datetime.now(timezone.utc)
    if not organization.is_locked:
        organization.is_locked, organization.locked_at, organization.locked_by = True, now, _who(admin)["actor_id"]
    organization.deletion_requested_at = organization.deletion_requested_at or now
    record(db, organization, "deletion_started", admin)
    db.commit()  # from here on the organization is locked and marked: a failure below leaves it that way, ready to be retried

    organization_id, name, slug = organization.id, organization.name, organization.slug
    purged: Dict[str, Dict[str, int]] = {}
    for service, *_ in SERVICES:
        try:
            purged[service] = purge.purge(service, organization_id)
        except PurgeFailed as exc:
            db.add(OrganizationLifecycleEvent(organization_id=organization_id, organization_name=name, organization_slug=slug, action="deletion_failed",
                                              details={"service": exc.service, "error": exc.message, "completed": list(purged)}, **_who(admin)))
            db.commit()
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail={
                "code": "deletion_failed", "service": exc.service, "completed": list(purged),
                "message": f"The organization was not deleted: the {exc.service} service could not delete its data ({exc.message}). The organization stays locked. Nothing was undone: run the deletion again to continue.",
            })

    if organization.logo_storage_key:
        try:
            storage.delete(organization.logo_storage_key)
        except StorageError:
            logger.warning("the logo file of organization %s could not be removed", organization_id)
    db.execute(text("SET LOCAL app.allow_ledger_maintenance = 'on'"))  # the organization's own append-only history goes with it (never set by any request handler otherwise)
    db.add(OrganizationLifecycleEvent(organization_id=organization_id, organization_name=name, organization_slug=slug, action="deleted",
                                      details={"purged": {k: sum(v.values()) for k, v in purged.items()}}, **_who(admin)))
    db.delete(organization)
    db.commit()
    logger.info("organization %s (%s) deleted by %s: %s", organization_id, slug, admin.get("email"), {k: sum(v.values()) for k, v in purged.items()})
    return purged


# ------------------------------------------------------------------------------------------------ API
class LockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: Optional[str] = Field(default=None, max_length=500)


class DeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm_name: str = Field(max_length=255)


class LifecycleEvent(BaseModel):
    action: str
    reason: Optional[str] = None
    actor_name: Optional[str] = None
    actor_email: Optional[str] = None
    details: Optional[dict] = None
    created_at: str


class DeleteResult(BaseModel):
    deleted: bool = True
    organization_id: str
    name: str
    purged: Dict[str, Dict[str, int]]


def _lifecycle_response(db: Session, organization: Organization):
    from app.main import to_response  # (imported here: main imports this router)

    return to_response(organization)


@router.post("/api/v1/organizations/{org_id}/lock", tags=["Lifecycle"])
def lock(org_id: str, payload: LockRequest, db: Session = Depends(get_db), admin: dict = Depends(require_super_admin)):
    """LOCK: the administrators can sign in but can only use Settings and Help & Support. Reversible; nothing is deleted. Safe to repeat."""
    return _lifecycle_response(db, lock_organization(db, find_organization(db, org_id), admin, payload.reason))


@router.post("/api/v1/organizations/{org_id}/unlock", tags=["Lifecycle"])
def unlock(org_id: str, db: Session = Depends(get_db), admin: dict = Depends(require_super_admin)):
    """UNLOCK: the organization has exactly the modules it had before the lock. Safe to repeat."""
    return _lifecycle_response(db, unlock_organization(db, find_organization(db, org_id), admin))


@router.post("/api/v1/organizations/{org_id}/delete", response_model=DeleteResult, tags=["Lifecycle"])
def delete(org_id: str, payload: DeleteRequest, db: Session = Depends(get_db), admin: dict = Depends(require_super_admin),
           purge: PurgeClient = Depends(get_purge_client), storage: LogoStorage = Depends(get_logo_storage)):
    """DELETE FOR GOOD: every service deletes everything the organization owns, then the organization itself. Irreversible. Needs the organization's exact name."""
    organization = find_organization(db, org_id)
    name, identifier = organization.name, str(organization.id)
    purged = delete_organization(db, organization, admin, payload.confirm_name, purge, storage)
    return DeleteResult(organization_id=identifier, name=name, purged=purged)


@router.get("/api/v1/organizations/{org_id}/lifecycle", response_model=List[LifecycleEvent], tags=["Lifecycle"])
def lifecycle_history(org_id: str, db: Session = Depends(get_db), admin: dict = Depends(require_super_admin)):
    """The lock / unlock / deletion record of an organization, newest first."""
    organization = find_organization(db, org_id)
    rows = db.scalars(select(OrganizationLifecycleEvent).where(OrganizationLifecycleEvent.organization_id == organization.id).order_by(OrganizationLifecycleEvent.seq.desc()).limit(50)).all()
    return [LifecycleEvent(action=r.action, reason=r.reason, actor_name=r.actor_name, actor_email=r.actor_email, details=r.details, created_at=r.created_at.isoformat()) for r in rows]
