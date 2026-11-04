"""The Purchasing Service's view of the Inventory Service.

Purchasing does not keep products or stock; the Inventory Service owns them. Whenever a product matters (adding it to a delivery
list, showing its stock, marking a list Ready) it is asked, using the CALLER'S OWN bearer token. That is the "trusted tenant
credential": the Inventory Service derives the organization from the token, so Purchasing can only ever see the caller's own
products, and nothing a browser claims about a product (name, SKU, unit, stock) is believed.

This module only READS. Delivery lists never move stock, so no write call to the Inventory Service exists here (a test
asserts that every request it makes is a GET).
"""
import os
import uuid
from decimal import Decimal
from typing import Dict, Iterable, List, Optional

import httpx
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials

from app.auth import bearer_scheme

INVENTORY_SERVICE_URL = os.getenv("INVENTORY_SERVICE_URL", "http://inventory-service:8002").rstrip("/")
CHUNK = 50  # ids per request (the Inventory Service accepts up to 100)


def create_inventory_client() -> httpx.Client:
    return httpx.Client(base_url=INVENTORY_SERVICE_URL, timeout=httpx.Timeout(5.0))


def get_inventory_client(request: Request) -> httpx.Client:
    # Created at startup (see lifespan in main.py); tests override this dependency.
    return request.app.state.inventory_client


class InventoryUnavailable(Exception):
    """The Inventory Service could not give a usable answer."""


class ProductInfo:
    """One product as the Inventory Service reports it, with its stock."""

    def __init__(self, data: dict):
        self.id = uuid.UUID(str(data["product_id"]))
        self.sku: str = data["sku"]
        self.name: str = data["name"]
        self.unit: str = data["unit"]
        self.is_active: bool = bool(data["is_active"])
        self.allows_fractions: bool = bool(data["unit_allows_fractions"])
        self.total = Decimal(str(data["total_quantity"]))
        self.available = Decimal(str(data["available_quantity"]))


class InventoryGateway:
    def __init__(self, client: httpx.Client, token: str):
        self._client = client
        self._headers = {"Authorization": f"Bearer {token}"}

    def _get(self, path: str, params=None) -> httpx.Response:
        try:
            response = self._client.get(path, params=params, headers=self._headers)
        except httpx.HTTPError:
            raise InventoryUnavailable()
        if response.status_code == status.HTTP_401_UNAUTHORIZED:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing, invalid or expired token", headers={"WWW-Authenticate": "Bearer"})
        if response.status_code == status.HTTP_403_FORBIDDEN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Your organization is not active.")
        return response

    def products(self, product_ids: Iterable[uuid.UUID]) -> Dict[uuid.UUID, ProductInfo]:
        """The caller's own products among these ids, with stock. Ids that are not found are simply absent."""
        wanted: List[uuid.UUID] = list(dict.fromkeys(product_ids))
        found: Dict[uuid.UUID, ProductInfo] = {}
        for start in range(0, len(wanted), CHUNK):
            chunk = wanted[start:start + CHUNK]
            response = self._get("/api/v1/inventory/stock/summary", params=[("product_id", str(i)) for i in chunk])
            if response.status_code != status.HTTP_200_OK:
                raise InventoryUnavailable()
            try:
                for raw in response.json()["items"]:
                    info = ProductInfo(raw)
                    if info.id in chunk:  # never accept a product that was not asked for
                        found[info.id] = info
            except (ValueError, KeyError, TypeError, ArithmeticError):
                raise InventoryUnavailable()
        return found

    def warehouse(self, warehouse_id: uuid.UUID) -> Optional[dict]:
        """The caller's own warehouse, or None if it does not exist (or belongs to someone else)."""
        response = self._get(f"/api/v1/inventory/warehouses/{warehouse_id}")
        if response.status_code == status.HTTP_404_NOT_FOUND:
            return None
        if response.status_code != status.HTTP_200_OK:
            raise InventoryUnavailable()
        try:
            data = response.json()
            return {"id": uuid.UUID(str(data["id"])), "code": data["code"], "is_active": bool(data["is_active"])}
        except (ValueError, KeyError, TypeError):
            raise InventoryUnavailable()


def unavailable_error() -> HTTPException:
    return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The inventory service is unavailable, so products cannot be checked right now. Please try again.")


def get_gateway(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    client: httpx.Client = Depends(get_inventory_client),
) -> InventoryGateway:
    # Endpoints list the tenant dependency first, so the token has already been accepted; this is a safety net.
    if credentials is None or not credentials.credentials:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing, invalid or expired token", headers={"WWW-Authenticate": "Bearer"})
    return InventoryGateway(client, credentials.credentials)
