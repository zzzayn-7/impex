"""Goods receipts. Every route depends on `require_active_tenant`; none accepts an organization id.

Drafting, editing and reviewing a receipt NEVER changes stock. Only POST .../confirm can, and only through the Inventory
Service's audited operation: see app/receipts.py for the workflow and its guarantees.
"""
import re
import uuid
from datetime import date
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy import exists
from sqlalchemy.orm import Session

from app import receipts
from app.auth import TenantContext, require_active_tenant, require_active_tenant_for_recovery
from app.database import get_db
from app.inventory import InventoryGateway, get_gateway
from app.models import GoodsReceipt, GoodsReceiptLine, PurchaseOrder, Supplier
from app.schemas import ReceiptCreate, ReceiptDetail, ReceiptLines, ReceiptPage, ReceiptUpdate
from app.search import like_pattern
from app.tenancy import scoped_count, scoped_select

router = APIRouter(prefix="/api/v1/purchasing")
Tenant = Depends(require_active_tenant)
# Confirming is the one route that must still work for a receipt that is already `posting` when Purchasing is switched off (see app/auth.py).
Recovery = Depends(require_active_tenant_for_recovery)

IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,100}$")


def idempotency_key(key: Optional[str] = Header(default=None, alias="Idempotency-Key")) -> str:
    key = (key or "").strip()
    if not key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The Idempotency-Key header is required to create a goods receipt.")
    if not IDEMPOTENCY_KEY_RE.match(key):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key must be 8-100 characters: letters, digits and . _ : -")
    return key


@router.post("/goods-receipts", response_model=ReceiptDetail, status_code=status.HTTP_201_CREATED, tags=["Goods receipts"])
def create_goods_receipt(
    payload: ReceiptCreate, response: Response, tenant: TenantContext = Tenant, key: str = Depends(idempotency_key),
    gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db),
):
    """Start a DRAFT receipt against an Ordered / Partially Received order, optionally with its lines. Changes no stock.
    The first request answers 201; a retry with the same Idempotency-Key and body answers 200 with the same receipt."""
    receipt, replayed = receipts.create_receipt(db, tenant, gateway, payload, key)
    response.status_code = status.HTTP_200_OK if replayed else status.HTTP_201_CREATED
    return receipts.detail(db, tenant, receipt)


@router.get("/goods-receipts", response_model=ReceiptPage, tags=["Goods receipts"])
def list_goods_receipts(
    purchase_order_id: Optional[uuid.UUID] = None,
    supplier_id: Optional[uuid.UUID] = None,
    status_filter: Optional[Literal["draft", "posting", "confirmed", "cancelled"]] = Query(default=None, alias="status"),
    product_id: Optional[uuid.UUID] = None,
    q: Optional[str] = Query(default=None, max_length=100, description="Search receipt number, order number, supplier reference or supplier name"),
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    filters = []
    if purchase_order_id:
        filters.append(GoodsReceipt.purchase_order_id == purchase_order_id)
    if supplier_id:
        filters.append(PurchaseOrder.supplier_id == supplier_id)
    if status_filter:
        filters.append(GoodsReceipt.status == status_filter)
    if date_from:
        filters.append(GoodsReceipt.received_date >= date_from)
    if date_to:
        filters.append(GoodsReceipt.received_date <= date_to)
    if product_id:
        filters.append(
            exists().where(
                GoodsReceiptLine.organization_id == GoodsReceipt.organization_id, GoodsReceiptLine.goods_receipt_id == GoodsReceipt.id,
                GoodsReceiptLine.product_id == product_id,
            )
        )
    if q and q.strip():
        filters.append(receipts.search_filter(like_pattern(q.strip())))
    order_join = (PurchaseOrder.id == GoodsReceipt.purchase_order_id) & (PurchaseOrder.organization_id == GoodsReceipt.organization_id)
    supplier_join = (Supplier.id == PurchaseOrder.supplier_id) & (Supplier.organization_id == PurchaseOrder.organization_id)
    total = db.scalar(scoped_count(GoodsReceipt, tenant).join(PurchaseOrder, order_join).join(Supplier, supplier_join).where(*filters))
    rows = db.scalars(
        scoped_select(GoodsReceipt, tenant).join(PurchaseOrder, order_join).join(Supplier, supplier_join).where(*filters)
        .order_by(GoodsReceipt.received_date.desc(), GoodsReceipt.created_at.desc(), GoodsReceipt.number.desc()).limit(limit).offset(offset)
    ).all()
    return ReceiptPage(items=receipts.summaries(db, tenant, list(rows)), total=total, limit=limit, offset=offset)


@router.get("/goods-receipts/{receipt_id}", response_model=ReceiptDetail, tags=["Goods receipts"])
def get_goods_receipt(receipt_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return receipts.detail(db, tenant, receipts.get_receipt_or_404(db, tenant, receipt_id))


@router.patch("/goods-receipts/{receipt_id}", response_model=ReceiptDetail, tags=["Goods receipts"])
def update_goods_receipt(receipt_id: uuid.UUID, payload: ReceiptUpdate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Edit the date, supplier reference or notes of a DRAFT receipt."""
    receipt = receipts.update_header(db, tenant, receipt_id, payload.model_dump(exclude_unset=True))
    return receipts.detail(db, tenant, receipt)


@router.put("/goods-receipts/{receipt_id}/lines", response_model=ReceiptDetail, tags=["Goods receipts"])
def save_goods_receipt_lines(
    receipt_id: uuid.UUID, payload: ReceiptLines, tenant: TenantContext = Tenant,
    gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db),
):
    """Replace the lines of a DRAFT receipt with exactly these. Changes no stock."""
    receipt = receipts.save_lines(db, tenant, gateway, receipt_id, payload.lines)
    return receipts.detail(db, tenant, receipt)


@router.post("/goods-receipts/{receipt_id}/confirm", response_model=ReceiptDetail, tags=["Goods receipts"])
def confirm_goods_receipt(
    receipt_id: uuid.UUID, response: Response, tenant: TenantContext = Recovery,
    gateway: InventoryGateway = Depends(get_gateway), db: Session = Depends(get_db),
):
    """Add the ACCEPTED quantities to stock through the Inventory Service and mark the receipt confirmed.

    200: confirmed (also when it already was: repeating this call never adds stock twice).
    202: the receipt is `posting` and the Inventory Service's answer could not be verified yet (it may be down, slow, or its
         answer was lost). Nothing is lost: call this endpoint again later - the same Idempotency-Key is used for the Inventory
         Service, which replays the first result instead of adding the goods a second time."""
    receipt, confirmed = receipts.confirm_receipt(db, tenant, gateway, receipt_id)
    response.status_code = status.HTTP_200_OK if confirmed else status.HTTP_202_ACCEPTED
    return receipts.detail(db, tenant, receipt)


@router.post("/goods-receipts/{receipt_id}/cancel", response_model=ReceiptDetail, tags=["Goods receipts"])
def cancel_goods_receipt(receipt_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Cancel a DRAFT receipt (kept for history). A receipt that is being posted or confirmed cannot be cancelled."""
    return receipts.detail(db, tenant, receipts.cancel_receipt(db, tenant, receipt_id))
