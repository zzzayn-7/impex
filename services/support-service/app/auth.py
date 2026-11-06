"""Authentication for the Support Service: two kinds of caller that can never use each other's endpoints.

  * require_tenant  - an ACTIVE `organization-admin` of an ACTIVE organization. The organization comes ONLY from the Auth Service's
                      record of the caller (never from the URL, query, headers or body), and its name from the Organization Service.
                      Support does NOT depend on first-time setup being completed: a new administrator with an onboarding problem
                      must be able to ask for help.
  * require_super_admin - an ACTIVE `super-admin`, verified by the Auth Service. An organization administrator never passes.

Tokens are never decoded here: the Auth Service (GET /api/v1/auth/me) is the single source of truth. Errors: 401 invalid, missing or
expired token (also an account that was deactivated: the Auth Service stops answering for it), 403 not allowed (including an inactive
organization), 503 a dependency cannot answer.
"""
import os
import uuid
from dataclasses import dataclass
from typing import Optional

import httpx
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

AUTH_SERVICE_URL = os.getenv("AUTH_SERVICE_URL", "http://auth-service:8000").rstrip("/")
ORG_SERVICE_URL = os.getenv("ORG_SERVICE_URL", "http://organization-service:8001").rstrip("/")
TENANT_ADMIN_ROLE = "organization-admin"
SUPER_ADMIN_ROLE = "super-admin"

bearer_scheme = HTTPBearer(auto_error=False)


def create_auth_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=AUTH_SERVICE_URL, timeout=httpx.Timeout(5.0))


def create_org_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=ORG_SERVICE_URL, timeout=httpx.Timeout(5.0))


def get_auth_client(request: Request) -> httpx.AsyncClient:
    return request.app.state.auth_client  # created at startup (see main.py); tests override this dependency


def get_org_client(request: Request) -> httpx.AsyncClient:
    return request.app.state.org_client


def _unauthorized() -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing, invalid or expired token", headers={"WWW-Authenticate": "Bearer"})


async def authenticated_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    client: httpx.AsyncClient = Depends(get_auth_client),
) -> dict:
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
class Caller:
    """Who is calling. `organization_id` / `organization_name` are set for tenants only."""

    user_id: uuid.UUID
    email: str
    full_name: str
    role: str
    organization_id: Optional[uuid.UUID] = None
    organization_name: str = ""


def _user_id(user: dict) -> uuid.UUID:
    try:
        return uuid.UUID(str(user.get("id")))
    except ValueError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed")


async def require_super_admin(user: dict = Depends(authenticated_user)) -> Caller:
    if user.get("is_active") is not True or user.get("role") != SUPER_ADMIN_ROLE:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Super Admin permission required")
    return Caller(user_id=_user_id(user), email=str(user.get("email", "")), full_name=str(user.get("full_name", "")), role=SUPER_ADMIN_ROLE)


async def require_tenant(
    user: dict = Depends(authenticated_user),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    org_client: httpx.AsyncClient = Depends(get_org_client),
) -> Caller:
    forbidden = HTTPException(status.HTTP_403_FORBIDDEN, "Organization administrator permission required")
    if user.get("is_active") is not True or user.get("role") != TENANT_ADMIN_ROLE:
        raise forbidden
    try:
        organization_id = uuid.UUID(str(user.get("organization_id")))
    except ValueError:
        raise forbidden
    inactive = HTTPException(status.HTTP_403_FORBIDDEN, "Your organization is not active.")
    unavailable = HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Organization service unavailable")
    try:
        response = await org_client.get("/api/v1/tenant/organization", headers={"Authorization": f"Bearer {credentials.credentials}"})  # type: ignore[union-attr]
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
    # It must be exactly the organization the Auth Service gave us, and active.
    if not isinstance(organization, dict) or str(organization.get("id")) != str(organization_id) or organization.get("is_active") is not True:
        raise inactive
    return Caller(
        user_id=_user_id(user), email=str(user.get("email", "")), full_name=str(user.get("full_name", "")), role=TENANT_ADMIN_ROLE,
        organization_id=organization_id, organization_name=" ".join(str(organization.get("name") or "").split()),
    )
