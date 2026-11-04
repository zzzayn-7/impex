"""Scannable codes, printable labels and scan lookup. Every route depends on `require_active_tenant`: the organization is
always the authenticated administrator's, an inactive organization is refused, and no route accepts an organization id.

Nothing here changes stock. Stock only changes through the existing /stock/* endpoints, which need an Idempotency-Key.
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app import identifiers, stock
from app.auth import TenantContext, require_active_tenant
from app.database import get_db
from app.models import Product, ProductIdentifier
from app.schemas import (
    IdentifierCreate,
    IdentifierList,
    IdentifierResponse,
    LabelProduct,
    LabelResponse,
    ProductResponse,
    ScanResult,
)
from app.tenancy import get_scoped_or_404

router = APIRouter(prefix="/api/v1/inventory")
Tenant = Depends(require_active_tenant)


def _identifier_or_404(db: Session, tenant: TenantContext, product_id: uuid.UUID, identifier_id: uuid.UUID) -> ProductIdentifier:
    identifier = get_scoped_or_404(db, ProductIdentifier, tenant, identifier_id, "Code")
    if identifier.product_id != product_id:  # a real code of this organization, but of another product: same answer
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Code not found.")
    return identifier


@router.post("/products/{product_id}/identifiers/generate", response_model=IdentifierResponse, tags=["Codes"])
def generate_code(product_id: uuid.UUID, response: Response, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Give the product its Impex label code (the QR code and the Code 128 barcode both carry it). Repeating the call
    returns the same code: it is created once and never changes, whatever happens to the SKU."""
    product = get_scoped_or_404(db, Product, tenant, product_id, "Product")
    identifier, created = identifiers.ensure_generated(db, tenant, product)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return identifier


@router.get("/products/{product_id}/identifiers", response_model=IdentifierList, tags=["Codes"])
def list_codes(product_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    get_scoped_or_404(db, Product, tenant, product_id, "Product")
    return IdentifierList(items=identifiers.list_identifiers(db, tenant, product_id))


@router.post("/products/{product_id}/identifiers", response_model=IdentifierResponse, status_code=status.HTTP_201_CREATED, tags=["Codes"])
def register_code(product_id: uuid.UUID, payload: IdentifierCreate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Register a manufacturer or supplier barcode that is already printed on the goods."""
    product = get_scoped_or_404(db, Product, tenant, product_id, "Product")
    return identifiers.register_external(db, tenant, product, payload.kind, payload.value, payload.label)


@router.post("/products/{product_id}/identifiers/{identifier_id}/retire", response_model=IdentifierResponse, tags=["Codes"])
def retire_code(product_id: uuid.UUID, identifier_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Stop a manufacturer/supplier barcode from resolving. It is kept (reserved for this product), never deleted."""
    get_scoped_or_404(db, Product, tenant, product_id, "Product")
    return identifiers.retire(db, tenant, _identifier_or_404(db, tenant, product_id, identifier_id))


@router.get("/products/{product_id}/label", response_model=LabelResponse, tags=["Codes"])
def product_label(
    product_id: uuid.UUID,
    identifier_id: Optional[uuid.UUID] = Query(default=None, description="Print this code instead of the Impex label code"),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    """Product name, SKU and the scannable code as a QR code and a Code 128 barcode (SVG), ready to print."""
    product = get_scoped_or_404(db, Product, tenant, product_id, "Product")
    if identifier_id is None:
        identifier, _ = identifiers.ensure_generated(db, tenant, product)
    else:
        identifier = _identifier_or_404(db, tenant, product_id, identifier_id)
        if not identifier.is_active:
            raise HTTPException(status.HTTP_410_GONE, "This barcode was retired.")
    return LabelResponse(
        product=LabelProduct(id=product.id, sku=product.sku, name=product.name, unit=product.unit),
        identifier=IdentifierResponse.model_validate(identifier),
        code=identifier.value,
        qr_svg=identifiers.render_qr_svg(identifier.value),
        barcode_svg=identifiers.render_code128_svg(identifier.value),
    )


@router.get("/scan/resolve", response_model=ScanResult, tags=["Scan"])
def resolve_scanned_code(
    code: str = Query(min_length=1, max_length=200, description="Text read from a QR code, a barcode, or typed in"),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    """Which product of YOUR organization does this code mean, and how much of it is where?

    Read-only. A QR payload is treated as plain text: it is never fetched or followed. Unknown -> 404, retired barcode
    -> 410, a code that would mean two products -> 409, malformed (or a link) -> 422. Archived products are returned
    with is_active = false so the portal can say so instead of offering stock changes.
    """
    resolution = identifiers.resolve_code(db, tenant, code)
    product = resolution.product
    identifiers.annotate_unit_lock(db, tenant, [product])
    (stock_item,) = stock.stock_items(db, tenant, [product])
    return ScanResult(
        matched_by=resolution.matched_by,
        identifier_kind=resolution.identifier.kind if resolution.identifier else None,
        product=ProductResponse.model_validate(product),
        stock=stock_item,
    )
