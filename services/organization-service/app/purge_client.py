"""Asks every service that stores organization data to delete everything one organization owns (the Super Admin deleting an organization from the CRM).

Each service answers POST /internal/v1/organizations/{id}/purge (the Auth Service: POST /internal/organizations/{id}/purge) for ITS database only, authenticated with a
shared secret (PURGE_API_KEY; the Auth Service's own INTERNAL_API_KEY), never a user's token. Every purge is idempotent, so a deletion that failed half way is simply run again.
A service that cannot be reached, or answers anything but 200, makes the whole deletion STOP: the organization is then NOT deleted (see app/lifecycle.py).
"""
import logging
import os
import uuid
from typing import Dict, List, Tuple

import httpx
from fastapi import Request

logger = logging.getLogger("impex.lifecycle")

# (name, environment variable of its address, default address, path). Order: the business data first, the accounts last.
SERVICES: List[Tuple[str, str, str, str]] = [
    ("finance", "FINANCE_SERVICE_URL", "http://finance-service:8006", "/internal/v1/organizations/{id}/purge"),
    ("sales", "SALES_SERVICE_URL", "http://sales-service:8003", "/internal/v1/organizations/{id}/purge"),
    ("purchasing", "PURCHASING_SERVICE_URL", "http://purchasing-service:8004", "/internal/v1/organizations/{id}/purge"),
    ("inventory", "INVENTORY_SERVICE_URL", "http://inventory-service:8002", "/internal/v1/organizations/{id}/purge"),
    ("support", "SUPPORT_SERVICE_URL", "http://support-service:8005", "/internal/v1/organizations/{id}/purge"),
    ("auth", "AUTH_SERVICE_URL", "http://auth-service:8000", "/internal/organizations/{id}/purge"),
]


class PurgeFailed(RuntimeError):
    def __init__(self, service: str, message: str) -> None:
        super().__init__(f"{service}: {message}")
        self.service, self.message = service, message


class PurgeClient:
    def __init__(self, timeout: float = 120.0) -> None:
        self._timeout = timeout

    def _key(self, service: str) -> str:
        if service == "auth":
            return os.getenv("AUTH_INTERNAL_API_KEY", "")
        return os.getenv("PURGE_API_KEY", "")

    def purge(self, service: str, organization_id: uuid.UUID) -> Dict[str, int]:
        """Delete everything the organization owns in `service`. Returns {table: rows deleted}. Raises PurgeFailed."""
        entry = next((s for s in SERVICES if s[0] == service), None)
        if entry is None:
            raise PurgeFailed(service, "unknown service")
        _, variable, default, path = entry
        key = self._key(service)
        if not key:
            raise PurgeFailed(service, "no service key is configured")
        try:
            response = httpx.post(os.getenv(variable, default).rstrip("/") + path.format(id=organization_id), headers={"X-Internal-Key": key}, timeout=httpx.Timeout(self._timeout))
        except httpx.HTTPError as exc:
            logger.warning("purge of %s in %s could not be asked: %s", organization_id, service, type(exc).__name__)
            raise PurgeFailed(service, "the service could not be reached") from exc
        if response.status_code != 200:
            logger.warning("purge of %s in %s answered %s", organization_id, service, response.status_code)
            raise PurgeFailed(service, f"the service refused the deletion (HTTP {response.status_code})")
        try:
            deleted = response.json().get("deleted")
        except ValueError:
            deleted = None
        if not isinstance(deleted, dict):
            raise PurgeFailed(service, "the service gave an unreadable answer")
        return {str(k): int(v) for k, v in deleted.items()}


def get_purge_client(request: Request) -> PurgeClient:
    # Created at startup (see lifespan in main.py); tests override this dependency.
    return request.app.state.purge_client
