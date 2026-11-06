"""What an organization has IN PROGRESS in a module, asked of the service that owns the records.

Before a module is switched off the Super Admin is told (and the change is refused) when the organization has operations that are
half way through: a dispatch that is posting stock out, a goods receipt that is posting stock in. Switching the module off then would strand
them. Records that are merely open (drafts, orders awaiting goods, unpaid invoices) never block: they are kept intact and come back when the
module is enabled again; they are reported as warnings.

The services answer GET /internal/v1/organizations/{organization_id}/module-usage for this service only: the call carries a shared secret
(MODULE_INTERNAL_API_KEY), never a user's token, and is not reachable from a browser. If a service cannot answer, the answer here is
"unknown", and unknown blocks the change: nothing is ever switched off on a guess.
"""
import logging
import os
import uuid
from typing import Dict, List, Optional

import httpx
from fastapi import Request

logger = logging.getLogger("impex.modules")

# module key -> (environment variable, default address)
USAGE_SERVICES: Dict[str, tuple] = {
    "purchasing": ("PURCHASING_SERVICE_URL", "http://purchasing-service:8004"),
    "sales": ("SALES_SERVICE_URL", "http://sales-service:8003"),
}


class UsageClient:
    """Asks the Purchasing and Sales services about one organization. `fetch` returns None when a service cannot be asked."""

    def __init__(self, timeout: float = 5.0) -> None:
        self._timeout = timeout
        self._clients: Dict[str, httpx.Client] = {}

    def _client(self, module: str) -> httpx.Client:
        if module not in self._clients:
            variable, default = USAGE_SERVICES[module]
            self._clients[module] = httpx.Client(base_url=os.getenv(variable, default).rstrip("/"), timeout=httpx.Timeout(self._timeout))
        return self._clients[module]

    def fetch(self, module: str, organization_id: uuid.UUID) -> Optional[dict]:
        key = os.getenv("MODULE_INTERNAL_API_KEY", "")
        if module not in USAGE_SERVICES or not key:
            return None
        try:
            response = self._client(module).get(f"/internal/v1/organizations/{organization_id}/module-usage", headers={"X-Internal-Key": key})
        except httpx.HTTPError:
            logger.warning("module usage of %s could not be asked", module)
            return None
        if response.status_code != 200:
            logger.warning("module usage of %s answered %s", module, response.status_code)
            return None
        try:
            data = response.json()
        except ValueError:
            return None
        if not isinstance(data, dict) or data.get("module") != module or not isinstance(data.get("blocking"), list) or not isinstance(data.get("warnings"), list):
            return None
        return data

    def close(self) -> None:
        for client in self._clients.values():
            client.close()


def get_usage_client(request: Request) -> UsageClient:
    # Created at startup (see lifespan in main.py); tests override this dependency.
    return request.app.state.usage_client


def modules_to_ask(disabling: List[str]) -> List[str]:
    """Which services to ask when these modules are being switched off. Inventory is required by Purchasing and Sales, so an operation
    in flight in either of them also matters when Inventory goes."""
    ask: List[str] = []
    for key in disabling:
        for module in ([key] if key in USAGE_SERVICES else []) + (list(USAGE_SERVICES) if key == "inventory" else []):
            if module not in ask:
                ask.append(module)
    return ask
