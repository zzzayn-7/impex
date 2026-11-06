"""Authentication for the Inventory Service: tenant administrators only.

This follows the multi-tenancy contract in docs/multi-tenancy.md (the Organization Service is the reference
implementation). In short:

  * Tokens are never decoded here. The Auth Service (GET /api/v1/auth/me) is the single source of truth for who
    the caller is, their role, their organization and whether they are active.
  * The tenant (organization_id) is taken ONLY from that record, never from the URL, query, headers, cookies or body.
  * Only an ACTIVE `organization-admin` with an organization may use this service. Super Admins never pass.
  * The caller's organization must exist and be active (asked of the Organization Service with the caller's own token).

  * The organization must also have this service's MODULE enabled (and the modules it depends on). The Organization Service owns that
    decision and returns it, for the caller's own token, in the same answer that says the organization is active. It is enforced
    HERE, on every request, whatever a browser menu shows. If the answer is missing or malformed the request is refused (503), never
    allowed: an outage cannot grant access.

Errors: 401 invalid/missing/expired token, 403 not allowed (including an inactive organization and a module that is not enabled:
{"code": "module_disabled", "module": ..., "message": ...}), 503 a dependency (Auth Service / Organization Service) cannot answer.
"""
import os
import uuid
from dataclasses import dataclass, replace
from typing import Optional, Tuple

import httpx
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

AUTH_SERVICE_URL = os.getenv("AUTH_SERVICE_URL", "http://auth-service:8000").rstrip("/")
ORG_SERVICE_URL = os.getenv("ORG_SERVICE_URL", "http://organization-service:8001").rstrip("/")
TENANT_ADMIN_ROLE = "organization-admin"

# The business module this service implements, and the modules it cannot work without (see the Organization Service, app/modules.py).
SERVICE_MODULE = "inventory"
MODULE_REQUIRES = ()

bearer_scheme = HTTPBearer(auto_error=False)


def create_auth_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=AUTH_SERVICE_URL, timeout=httpx.Timeout(5.0))


def create_org_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=ORG_SERVICE_URL, timeout=httpx.Timeout(5.0))


def get_auth_client(request: Request) -> httpx.AsyncClient:
    # Created at startup (see lifespan in main.py); tests override these dependencies.
    return request.app.state.auth_client


def get_org_client(request: Request) -> httpx.AsyncClient:
    return request.app.state.org_client


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing, invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def authenticated_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    client: httpx.AsyncClient = Depends(get_auth_client),
) -> dict:
    """Validate the Bearer token with the Auth Service and return that service's record of the user."""
    unavailable = HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Authentication service unavailable")
    if credentials is None or not credentials.credentials:
        raise _unauthorized()
    try:
        response = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {credentials.credentials}"})
    except httpx.HTTPError:
        raise unavailable
    if response.status_code == status.HTTP_401_UNAUTHORIZED:
        raise _unauthorized()
    if response.status_code != status.HTTP_200_OK:
        raise unavailable
    try:
        user = response.json()
    except ValueError:
        raise unavailable
    if not isinstance(user, dict):
        raise unavailable
    return user


@dataclass(frozen=True)
class TenantContext:
    """Who is calling and which organization they belong to. Built only from the Auth Service's answer."""

    organization_id: uuid.UUID
    user_id: str
    email: str
    full_name: str
    # True only on the "finish what was started" routes, when the module has been switched off: see require_active_tenant_for_recovery.
    recovery_only: bool = False


async def require_tenant_admin(user: dict = Depends(authenticated_user)) -> TenantContext:
    """Allow only an ACTIVE `organization-admin` that belongs to an organization (never a Super Admin)."""
    forbidden = HTTPException(status.HTTP_403_FORBIDDEN, "Organization administrator permission required")
    if user.get("is_active") is not True or user.get("role") != TENANT_ADMIN_ROLE:
        raise forbidden
    try:
        organization_id = uuid.UUID(str(user.get("organization_id")))
    except ValueError:
        raise forbidden
    return TenantContext(
        organization_id=organization_id,
        user_id=str(user.get("id", "")),
        email=str(user.get("email", "")),
        full_name=str(user.get("full_name", "")),
    )


async def _verified_tenant(tenant: TenantContext, credentials: Optional[HTTPAuthorizationCredentials], org_client: httpx.AsyncClient) -> Tuple[TenantContext, bool]:
    """The tenant, once their organization is confirmed to exist and be active.

    The Organization Service owns that fact. It answers GET /api/v1/tenant/organization for the caller's own
    token with 403 when the organization is missing or inactive, so no extra secret or endpoint is needed.
    Product access depends on this dependency, so an inactive organization cannot read or change anything.
    """
    inactive = HTTPException(status.HTTP_403_FORBIDDEN, "Your organization is not active.")
    unavailable = HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Organization service unavailable")
    try:
        response = await org_client.get(
            "/api/v1/tenant/organization", headers={"Authorization": f"Bearer {credentials.credentials}"}  # type: ignore[union-attr]
        )
    except httpx.HTTPError:
        raise unavailable
    if response.status_code == status.HTTP_401_UNAUTHORIZED:
        raise _unauthorized()
    if response.status_code == status.HTTP_403_FORBIDDEN:
        raise inactive
    if response.status_code != status.HTTP_200_OK:
        raise unavailable
    try:
        organization = response.json()
    except ValueError:
        raise unavailable
    # Belt and braces: it must be exactly the organization the Auth Service gave us, and active.
    if (
        not isinstance(organization, dict)
        or str(organization.get("id")) != str(tenant.organization_id)
        or organization.get("is_active") is not True
    ):
        raise inactive
    return tenant, _module_allowed(organization, unavailable)


def module_disabled() -> HTTPException:
    """The one error every service gives for a module that is not enabled: the same status and shape everywhere."""
    names = {"inventory": "Inventory", "purchasing": "Purchasing", "sales": "Sales", "finance": "Finance"}
    return HTTPException(
        status.HTTP_403_FORBIDDEN,
        detail={"code": "module_disabled", "module": SERVICE_MODULE, "message": f"The {names.get(SERVICE_MODULE, SERVICE_MODULE)} module is not enabled for your organization."},
    )


def _module_allowed(organization: dict, unavailable: HTTPException) -> bool:
    """Is this service's module (and every module it needs) enabled for the organization the Organization Service just described?

    The list comes from the Organization Service's own answer for the caller's token; nothing from the request is read. A missing or
    malformed list is an outage of that decision, not a "yes": the request is refused with 503."""
    modules = organization.get("modules")
    if not isinstance(modules, list) or not all(isinstance(m, str) for m in modules):
        raise unavailable
    return SERVICE_MODULE in modules and all(dep in modules for dep in MODULE_REQUIRES)


async def require_active_tenant(
    tenant: TenantContext = Depends(require_tenant_admin),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    org_client: httpx.AsyncClient = Depends(get_org_client),
) -> TenantContext:
    """The tenant, once their organization is confirmed to exist, be active AND have this service's module enabled."""
    tenant, allowed = await _verified_tenant(tenant, credentials, org_client)
    if not allowed:
        raise module_disabled()
    return tenant


async def require_active_tenant_for_recovery(
    tenant: TenantContext = Depends(require_tenant_admin),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    org_client: httpx.AsyncClient = Depends(get_org_client),
) -> TenantContext:
    """For the "confirm" routes only. Switching a module off must never strand a transaction that is already half way through (a
    dispatch or goods receipt in `posting`): when the module is off, the caller still gets through with `recovery_only=True`, and the
    route refuses anything except finishing an operation that is already `posting` (see `refuse_unless_recovering`)."""
    tenant, allowed = await _verified_tenant(tenant, credentials, org_client)
    return tenant if allowed else replace(tenant, recovery_only=True)


def refuse_unless_recovering(tenant: TenantContext, status_now: str) -> None:
    """Called by the confirm routes with the record's status. With the module off only a `posting` record may continue."""
    if tenant.recovery_only and status_now != "posting":
        raise module_disabled()
