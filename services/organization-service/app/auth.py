"""Authentication and authorization for the Organization Service.

Tokens are never decoded here. Every request's Bearer token is verified by the Auth Service
(GET /api/v1/auth/me), which is the single source of truth for who the user is, their role,
their organization and whether they are active. Role, identity and organization headers sent by
the client are never read.

Two kinds of callers are supported, and they can never use each other's endpoints:
  * require_super_admin  - platform administrators (organization management APIs)
  * require_tenant_admin - an organization's own administrator. The organization is taken ONLY from the
                           authenticated user's record, never from the URL, query string, headers or body.

Errors are consistent everywhere:  401 invalid/missing/expired token,  403 authenticated but not allowed,
503 the Auth Service is unavailable.
"""
import os
import uuid
from dataclasses import dataclass
from typing import Optional

import httpx
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

AUTH_SERVICE_URL = os.getenv("AUTH_SERVICE_URL", "http://auth-service:8000").rstrip("/")
SUPER_ADMIN_ROLE = "super-admin"
TENANT_ADMIN_ROLE = "organization-admin"

bearer_scheme = HTTPBearer(auto_error=False)


def create_auth_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=AUTH_SERVICE_URL, timeout=httpx.Timeout(5.0))


def get_auth_client(request: Request) -> httpx.AsyncClient:
    # Created at startup (see lifespan in main.py); tests override this dependency.
    return request.app.state.auth_client


async def authenticated_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    client: httpx.AsyncClient = Depends(get_auth_client),
) -> dict:
    """Validate the Bearer token with the Auth Service and return that service's record of the user.

    401 for a missing/invalid/expired token; 503 if the Auth Service cannot answer (not the caller's fault).
    This says who the caller is; it does not decide what they may do.
    """
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing, invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    unavailable = HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Authentication service unavailable",
    )
    if credentials is None or not credentials.credentials:
        raise unauthorized

    try:
        response = await client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {credentials.credentials}"},
        )
    except httpx.HTTPError:
        raise unavailable

    if response.status_code == status.HTTP_401_UNAUTHORIZED:
        raise unauthorized
    if response.status_code != status.HTTP_200_OK:
        raise unavailable

    try:
        user = response.json()
    except ValueError:
        raise unavailable
    if not isinstance(user, dict):
        raise unavailable
    return user


async def require_super_admin(user: dict = Depends(authenticated_user)) -> dict:
    if user.get("is_active") is not True or user.get("role") != SUPER_ADMIN_ROLE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Super Admin permission required",
        )
    return user


@dataclass(frozen=True)
class TenantContext:
    """Who is calling and which organization they belong to. Built only from the Auth Service's answer."""

    organization_id: uuid.UUID
    user_id: str
    email: str
    full_name: str


async def require_tenant_admin(user: dict = Depends(authenticated_user)) -> TenantContext:
    """Allow only an ACTIVE `organization-admin` that belongs to an organization.

    A Super Admin never passes (their role is not `organization-admin`), whatever else is true of the account.
    """
    forbidden = HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Organization administrator permission required",
    )
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
