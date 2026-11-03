"""Super Admin authorization for the Organization Service.

Tokens are never decoded here. Every request's Bearer token is verified by the
Auth Service (GET /api/v1/auth/me), which is the single source of truth for who
the user is, their role and whether they are active. Role/identity headers sent
by the client are never read.
"""
import os
from typing import Optional

import httpx
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

AUTH_SERVICE_URL = os.getenv("AUTH_SERVICE_URL", "http://auth-service:8000").rstrip("/")
SUPER_ADMIN_ROLE = "super-admin"

bearer_scheme = HTTPBearer(auto_error=False)


def create_auth_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=AUTH_SERVICE_URL, timeout=httpx.Timeout(5.0))


def get_auth_client(request: Request) -> httpx.AsyncClient:
    # Created at startup (see lifespan in main.py); tests override this dependency.
    return request.app.state.auth_client


async def require_super_admin(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    client: httpx.AsyncClient = Depends(get_auth_client),
) -> dict:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing, invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if credentials is None or not credentials.credentials:
        raise unauthorized

    try:
        response = await client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {credentials.credentials}"},
        )
    except httpx.HTTPError:
        # Auth Service unreachable or timed out: this is not the caller's fault, so not a 401.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        )

    if response.status_code == status.HTTP_401_UNAUTHORIZED:
        raise unauthorized
    if response.status_code != status.HTTP_200_OK:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    try:
        user = response.json()
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    if user.get("is_active") is not True or user.get("role") != SUPER_ADMIN_ROLE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Super Admin permission required",
        )
    return user
