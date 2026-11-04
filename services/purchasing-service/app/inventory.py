"""The Purchasing Service's view of the Inventory Service.

Purchasing does not keep products or stock; the Inventory Service owns them. Whenever a product matters (adding it to a delivery
list, showing its stock, marking a list Ready) it is asked, using the CALLER'S OWN bearer token. That is the "trusted tenant
credential": the Inventory Service derives the organization from the token, so Purchasing can only ever see the caller's own
products, and nothing a browser claims about a product (name, SKU, unit, stock) is believed.

This module READS products and warehouses, and makes exactly ONE kind of write: posting a CONFIRMED goods receipt
(`post_goods_receipt`), which adds the accepted quantities to stock through the Inventory Service's own audited, idempotent
operation. Purchase orders, drafts and scanning never reach it (tests assert that the only non-GET request ever made is that
posting, and only on confirmation).
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
POSTING_TIMEOUT = httpx.Timeout(20.0, connect=5.0)  # a receipt of many lines is one atomic operation: give it time before calling it "unknown"


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

    @staticmethod
    def _refuse_bad_credentials(response: httpx.Response) -> None:
        if response.status_code == status.HTTP_401_UNAUTHORIZED:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing, invalid or expired token", headers={"WWW-Authenticate": "Bearer"})
        if response.status_code == status.HTTP_403_FORBIDDEN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Your organization is not active.")

    def _get(self, path: str, params=None) -> httpx.Response:
        try:
            response = self._client.get(path, params=params, headers=self._headers)
        except httpx.HTTPError:
            raise InventoryUnavailable()
        self._refuse_bad_credentials(response)
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


    # --- the one write: adding CONFIRMED goods to stock -----------------------------------------------------------------------
    def post_goods_receipt(self, key: str, body: dict) -> "PostingOutcome":
        """Ask the Inventory Service to add the accepted quantities. Always the same `key` for the same receipt, so a retry after
        a timeout or a crash can never add the goods twice.

        posted   - the Inventory Service answered 200/201 (the caller must still verify the answer);
        rejected - it definitively refused (400/404/409/422): nothing was added;
        unknown  - no usable answer (timeout, connection lost, 5xx, garbled): the goods may or may not have been added.
        """
        try:
            response = self._client.post(
                "/api/v1/inventory/goods-receipts", json=body, headers={**self._headers, "Idempotency-Key": key}, timeout=POSTING_TIMEOUT
            )
        except httpx.HTTPError as exc:
            return PostingOutcome("unknown", message=f"The inventory service did not answer ({type(exc).__name__}).")
        self._refuse_bad_credentials(response)
        if response.status_code in (status.HTTP_200_OK, status.HTTP_201_CREATED):
            try:
                return PostingOutcome("posted", data=response.json())
            except ValueError:
                return PostingOutcome("unknown", message="The inventory service's answer could not be read.")
        if response.status_code in (400, 404, 409, 422):
            return PostingOutcome("rejected", message=_detail(response), status_code=response.status_code)
        return PostingOutcome("unknown", message=f"The inventory service failed ({response.status_code}).")

    def posting_by_key(self, key: str) -> "PostingLookup":
        """Read-only: did the posting made with this key happen? (found / absent / unknown)"""
        try:
            response = self._client.get(f"/api/v1/inventory/goods-receipts/by-key/{key}", headers=self._headers)
        except httpx.HTTPError:
            return PostingLookup("unknown")
        self._refuse_bad_credentials(response)
        if response.status_code == status.HTTP_200_OK:
            try:
                return PostingLookup("found", response.json())
            except ValueError:
                return PostingLookup("unknown")
        if response.status_code == status.HTTP_404_NOT_FOUND:
            return PostingLookup("absent")
        return PostingLookup("unknown")


def _detail(response: httpx.Response) -> str:
    try:
        detail = response.json().get("detail")
        if isinstance(detail, str) and detail:
            return detail[:500]
        if isinstance(detail, list):
            return "The inventory service did not accept the receipt."
    except (ValueError, AttributeError):
        pass
    return f"The inventory service refused the request ({response.status_code})."


class PostingOutcome:
    def __init__(self, kind: str, data: Optional[dict] = None, message: str = "", status_code: Optional[int] = None):
        self.kind, self.data, self.message, self.status_code = kind, data, message, status_code


class PostingLookup:
    def __init__(self, kind: str, data: Optional[dict] = None):
        self.kind, self.data = kind, data


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
