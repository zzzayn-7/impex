"""Module management API.

Super Admin (role verified by the Auth Service on every call):
  GET  /api/v1/organizations/{org}/modules           the modules, what is enabled, dependencies and the current revision
  POST /api/v1/organizations/{org}/modules/preview   what a change would do: result, blockers (it cannot be applied) and warnings
  PUT  /api/v1/organizations/{org}/modules           apply a reviewed change (needs the revision the review was based on)
  GET  /api/v1/organizations/{org}/modules/history   who changed what, and when (append-only)

Organization administrator (the organization comes only from the verified token):
  GET  /api/v1/tenant/modules                        the modules the organization can use. The same list is part of
                                                     GET /api/v1/tenant/organization, which is what the other services ask.

Only an authorized Super Admin action changes entitlements. Nothing else (a support ticket, a request from a browser) can.
"""
import uuid
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.auth import require_super_admin
from app.database import get_db
from app.module_usage import UsageClient, get_usage_client, modules_to_ask
from app.models import Organization, OrganizationModule, OrganizationModuleHistory
from app.modules import PERMANENT, REGISTRY, Blocker, default_enabled, effective, new_batch_id, validate_target
from app.tenancy import require_tenant_organization

router = APIRouter(tags=["Modules"])


# ------------------------------------------------------------------------------------------------ state
def stored_state(db: Session, organization_id: uuid.UUID) -> Dict[str, bool]:
    """module key -> enabled, from the database; a module with no recorded row has its default (Inventory on, the rest off)."""
    state = default_enabled()
    for row in db.scalars(select(OrganizationModule).where(OrganizationModule.organization_id == organization_id)):
        if row.module_key in state:
            state[row.module_key] = row.enabled
    return state


def usable_modules(db: Session, organization_id: uuid.UUID) -> List[str]:
    """The module keys the organization can use right now (enabled, available, with every requirement also usable).

    A LOCKED organization (the Super Admin's decision, see app/lifecycle.py) can use none: this one answer is what the other services enforce and what the portal shows,
    so a lock cuts every module everywhere at once. The stored entitlements are untouched, so unlocking restores exactly what the organization had."""
    if db.scalar(select(Organization.is_locked).where(Organization.id == organization_id)):
        return []
    return sorted(effective(stored_state(db, organization_id)))


def revision_of(db: Session, organization_id: uuid.UUID) -> int:
    return db.scalar(select(func.coalesce(func.max(OrganizationModuleHistory.seq), 0)).where(OrganizationModuleHistory.organization_id == organization_id)) or 0


def seed_new_organization(db: Session, organization_id: uuid.UUID) -> None:
    """A new organization starts with Inventory enabled and everything optional disabled. Written in the caller's transaction."""
    batch = new_batch_id()
    for key, enabled in default_enabled().items():
        db.add(OrganizationModule(organization_id=organization_id, module_key=key, enabled=enabled))
        db.add(OrganizationModuleHistory(
            organization_id=organization_id, module_key=key, action="seeded", old_enabled=None, new_enabled=enabled, changed_by_name="System",
            reason="Default for a new organization", batch_id=batch,
        ))


def find_organization(db: Session, org_id: str) -> Organization:
    try:
        organization = db.get(Organization, uuid.UUID(org_id))
    except ValueError:
        organization = db.scalar(select(Organization).where(Organization.slug == org_id))
    if organization is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Organization '{org_id}' not found.")
    return organization


# ------------------------------------------------------------------------------------------------ planning
class Plan:
    def __init__(self, target: Dict[str, bool], changes: Dict[str, bool], current: Dict[str, bool], blockers: List[Blocker], warnings: List[dict], revision: int):
        self.target, self.changes, self.current, self.blockers, self.warnings, self.revision = target, changes, current, blockers, warnings, revision

    @property
    def can_apply(self) -> bool:
        return bool(self.changes) and not self.blockers


def make_plan(db: Session, organization: Organization, requested: Dict[str, bool], usage: UsageClient) -> Plan:
    """What a requested change would do. Asks the owning services what is in progress (no database lock is held while doing so)."""
    for key in requested:
        if key not in REGISTRY:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "unknown_module", "module": key, "message": f"'{key}' is not a module that can be managed. Authentication, Organization Management, Onboarding and Help & Support are always on."})
    current = stored_state(db, organization.id)
    revision = revision_of(db, organization.id)
    changes = {key: wanted for key, wanted in requested.items() if current[key] != wanted}
    target, blockers = validate_target(current, changes)
    warnings: List[dict] = []
    disabling = [key for key, wanted in changes.items() if not wanted]
    for module in modules_to_ask(disabling):
        answer = usage.fetch(module, organization.id)
        name = REGISTRY[module].name
        if answer is None:
            blockers.append(Blocker("usage_unavailable", module, f"{name} could not be checked for operations in progress, so it was not switched off. Try again in a moment."))
            continue
        pending = [item for item in answer["blocking"] if int(item.get("count", 0)) > 0]
        if pending:
            blockers.append(Blocker("pending_operations", module, f"{name} has operations in progress that must finish first. Wait for them to complete, then try again.", counts=[{"code": p["code"], "label": p["label"], "count": int(p["count"])} for p in pending]))
        if module in disabling:
            for item in answer["warnings"]:
                if int(item.get("count", 0)) > 0:
                    warnings.append({"module": module, "code": item["code"], "label": item["label"], "count": int(item["count"])})
    return Plan(target, changes, current, blockers, warnings, revision)


# ------------------------------------------------------------------------------------------------ schemas
class ChangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # module key -> wanted state. Only entries that differ from the current state are changes.
    changes: Dict[str, StrictBool] = Field(min_length=1, max_length=len(REGISTRY))


class ApplyRequest(ChangeRequest):
    expected_revision: int = Field(ge=0)  # the revision the review was based on: a change made meanwhile makes this stale
    reason: Optional[str] = Field(default=None, max_length=500)


class ModuleView(BaseModel):
    key: str
    name: str
    description: str
    features: List[str]
    requires: List[str]
    available: bool
    enabled: bool
    effective: bool
    updated_at: Optional[datetime]
    updated_by_name: Optional[str]


class PermanentView(BaseModel):
    key: str
    name: str
    description: str


class ModulesState(BaseModel):
    organization_id: str
    organization_name: str
    revision: int
    modules: List[ModuleView]
    permanent: List[PermanentView]


class ChangeView(BaseModel):
    module: str
    name: str
    from_enabled: bool
    to_enabled: bool


class PreviewResponse(BaseModel):
    revision: int
    changes: List[ChangeView]
    blockers: List[dict]
    warnings: List[dict]
    can_apply: bool


class HistoryItem(BaseModel):
    id: str
    module: str
    module_name: str
    action: str
    old_enabled: Optional[bool]
    new_enabled: bool
    changed_by_name: Optional[str]
    changed_by_email: Optional[str]
    reason: Optional[str]
    batch_id: str
    created_at: datetime


class HistoryPage(BaseModel):
    items: List[HistoryItem]
    total: int


class TenantModules(BaseModel):
    modules: List[str]


def build_state(db: Session, organization: Organization) -> ModulesState:
    rows = {row.module_key: row for row in db.scalars(select(OrganizationModule).where(OrganizationModule.organization_id == organization.id))}
    current = stored_state(db, organization.id)
    usable = effective(current)
    # who changed it last, by name: from the newest history entry of each module
    last_by = {}
    for item in db.scalars(select(OrganizationModuleHistory).where(OrganizationModuleHistory.organization_id == organization.id).order_by(OrganizationModuleHistory.seq)):
        last_by[item.module_key] = item.changed_by_name or item.changed_by_email
    modules = [
        ModuleView(
            key=key, name=d.name, description=d.description, features=list(d.features), requires=list(d.requires), available=d.available,
            enabled=current[key], effective=key in usable, updated_at=rows[key].updated_at if key in rows else None, updated_by_name=last_by.get(key),
        )
        for key, d in REGISTRY.items()
    ]
    return ModulesState(organization_id=str(organization.id), organization_name=organization.name, revision=revision_of(db, organization.id), modules=modules, permanent=[PermanentView(key=k, name=n, description=d) for k, n, d in PERMANENT])


def build_preview(plan: Plan) -> PreviewResponse:
    return PreviewResponse(
        revision=plan.revision,
        changes=[ChangeView(module=k, name=REGISTRY[k].name, from_enabled=plan.current[k], to_enabled=v) for k, v in plan.changes.items()],
        blockers=[b.as_dict() for b in plan.blockers], warnings=plan.warnings, can_apply=plan.can_apply,
    )


# ------------------------------------------------------------------------------------------------ Super Admin
@router.get("/api/v1/organizations/{org_id}/modules", response_model=ModulesState)
def get_modules(org_id: str, db: Session = Depends(get_db), admin: dict = Depends(require_super_admin)):
    return build_state(db, find_organization(db, org_id))


@router.post("/api/v1/organizations/{org_id}/modules/preview", response_model=PreviewResponse)
def preview_modules(org_id: str, payload: ChangeRequest, db: Session = Depends(get_db), admin: dict = Depends(require_super_admin), usage: UsageClient = Depends(get_usage_client)):
    """Review step: nothing is changed. Shows the result, what blocks it and what the Super Admin should know."""
    return build_preview(make_plan(db, find_organization(db, org_id), payload.changes, usage))


@router.put("/api/v1/organizations/{org_id}/modules", response_model=ModulesState)
def apply_modules(org_id: str, payload: ApplyRequest, db: Session = Depends(get_db), admin: dict = Depends(require_super_admin), usage: UsageClient = Depends(get_usage_client)):
    """Apply a reviewed change atomically. Refused when it is blocked (a dependency, an operation in progress, an unavailable module) or
    when the entitlements changed since the review (409 stale_revision): the Super Admin reviews the new state and confirms again."""
    organization = find_organization(db, org_id)
    plan = make_plan(db, organization, payload.changes, usage)  # (HTTP to the services happens here, before any lock is taken)
    if plan.blockers:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "blocked", "message": "This change cannot be applied.", "blockers": [b.as_dict() for b in plan.blockers]})
    if not plan.changes:
        db.rollback()
        return build_state(db, organization)
    try:
        # Changes to one organization's entitlements are serialized on the organization row. The revision check below makes a change
        # that was reviewed against an older state fail instead of silently overwriting a newer one.
        db.execute(select(Organization.id).where(Organization.id == organization.id).with_for_update())
        if revision_of(db, organization.id) != payload.expected_revision:
            raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "stale_revision", "message": "The module settings changed since you reviewed them. Review the current state and confirm again."})
        locked_now = stored_state(db, organization.id)
        if locked_now != plan.current:  # (cannot differ when the revision matches; belt and braces)
            raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "stale_revision", "message": "The module settings changed since you reviewed them. Review the current state and confirm again."})
        batch = new_batch_id()
        who = {"changed_by": uuid.UUID(str(admin.get("id"))), "changed_by_name": str(admin.get("full_name") or "") or None, "changed_by_email": str(admin.get("email") or "") or None}
        for key, wanted in plan.changes.items():
            statement = pg_insert(OrganizationModule).values(organization_id=organization.id, module_key=key, enabled=wanted, updated_by=who["changed_by"], updated_at=func.now())
            db.execute(statement.on_conflict_do_update(index_elements=["organization_id", "module_key"], set_={"enabled": wanted, "updated_by": who["changed_by"], "updated_at": func.now()}))
            db.add(OrganizationModuleHistory(
                organization_id=organization.id, module_key=key, action="enabled" if wanted else "disabled", old_enabled=plan.current[key], new_enabled=wanted,
                reason=(payload.reason or "").strip() or None, batch_id=batch, **who,
            ))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise
    return build_state(db, organization)


@router.get("/api/v1/organizations/{org_id}/modules/history", response_model=HistoryPage)
def module_history(org_id: str, limit: int = Query(default=50, ge=1, le=200), offset: int = Query(default=0, ge=0), db: Session = Depends(get_db), admin: dict = Depends(require_super_admin)):
    organization = find_organization(db, org_id)
    base = select(OrganizationModuleHistory).where(OrganizationModuleHistory.organization_id == organization.id)
    total = db.scalar(select(func.count()).select_from(OrganizationModuleHistory).where(OrganizationModuleHistory.organization_id == organization.id)) or 0
    rows = db.scalars(base.order_by(OrganizationModuleHistory.seq.desc()).limit(limit).offset(offset)).all()
    return HistoryPage(total=total, items=[
        HistoryItem(
            id=str(r.id), module=r.module_key, module_name=REGISTRY[r.module_key].name if r.module_key in REGISTRY else r.module_key, action=r.action, old_enabled=r.old_enabled,
            new_enabled=r.new_enabled, changed_by_name=r.changed_by_name, changed_by_email=r.changed_by_email, reason=r.reason, batch_id=str(r.batch_id), created_at=r.created_at,
        ) for r in rows
    ])


# ------------------------------------------------------------------------------------------------ the organization's own administrator
@router.get("/api/v1/tenant/modules", response_model=TenantModules, tags=["Tenant"])
def my_modules(organization: Organization = Depends(require_tenant_organization), db: Session = Depends(get_db)):
    return TenantModules(modules=usable_modules(db, organization.id))
