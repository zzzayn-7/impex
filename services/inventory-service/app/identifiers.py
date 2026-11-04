"""Scannable product identifiers: normalizing, generating, rendering (QR / Code 128) and resolving a scanned code.

Rules (each is also backed by a database constraint or trigger):
  * A code is tenant-scoped. The same text may identify different products in different organizations, never two
    products in one (UNIQUE (organization_id, value)).
  * The Impex-generated code is random. It does not contain or derive from the SKU, so renaming a SKU, or giving the
    old SKU to another product, can never move a printed label to another product.
  * A code is retired, never deleted or re-pointed. A retired code stays reserved for its product.
  * Looking a code up changes nothing, and a QR payload is only ever text: nothing here (or in the portal) follows it.
"""
import re
import secrets
import uuid
from typing import List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import TenantContext
from app.models import Product, ProductIdentifier, StockMovement
from app.tenancy import create_for_tenant, scoped_count, scoped_select

GENERATED_PREFIX = "IMX-"
# No 0/O/1/I: a label that has to be typed by hand is easier to read out and key in.
_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
_VALUE_RE = re.compile(r"^[A-Z0-9][A-Z0-9._:/+-]{0,63}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
MAX_CODE_LENGTH = 64


# --- normalizing ------------------------------------------------------------------------------------------
def normalize_code(raw: str) -> str:
    """The canonical form of a code typed, pasted or scanned: trimmed and upper-case. Raises 422 if it cannot be a code."""
    if not isinstance(raw, str) or _CONTROL_RE.search(raw.strip("\r\n\t ")):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That is not a valid product code.")
    value = raw.strip().upper()
    if not value:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Enter or scan a product code.")
    if "://" in value or value.startswith(("HTTP:", "HTTPS:", "JAVASCRIPT:", "DATA:")):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "That looks like a web link, not a product code. Links in codes are never opened.",
        )
    if len(value) > MAX_CODE_LENGTH or not _VALUE_RE.match(value):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"A product code is up to {MAX_CODE_LENGTH} letters, digits and . _ : / + - (no spaces).",
        )
    return value


def new_generated_value() -> str:
    return GENERATED_PREFIX + "".join(secrets.choice(_ALPHABET) for _ in range(12))


# --- rendering --------------------------------------------------------------------------------------------
def render_qr_svg(value: str) -> str:
    """A QR code (error correction M) containing exactly `value` as plain text, as an SVG document."""
    import qrcode
    import qrcode.image.svg

    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=2)
    qr.add_data(value)
    qr.make(fit=True)
    return qr.make_image(image_factory=qrcode.image.svg.SvgPathImage).to_string().decode("utf-8")


def render_code128_svg(value: str) -> str:
    """A Code 128 barcode of `value` (bars only; the portal prints the text itself), as an SVG document."""
    from barcode import Code128
    from barcode.writer import SVGWriter

    options = {"write_text": False, "module_width": 0.4, "module_height": 14.0, "quiet_zone": 4.0}
    return Code128(value, writer=SVGWriter()).render(options).decode("utf-8")


# --- storing ----------------------------------------------------------------------------------------------
def list_identifiers(db: Session, tenant: TenantContext, product_id: uuid.UUID) -> List[ProductIdentifier]:
    return list(
        db.scalars(
            scoped_select(ProductIdentifier, tenant)
            .where(ProductIdentifier.product_id == product_id)
            .order_by(ProductIdentifier.kind != "generated", ProductIdentifier.created_at, ProductIdentifier.id)
        )
    )


def get_generated(db: Session, tenant: TenantContext, product_id: uuid.UUID) -> Optional[ProductIdentifier]:
    return db.scalar(scoped_select(ProductIdentifier, tenant).where(ProductIdentifier.product_id == product_id, ProductIdentifier.kind == "generated"))


def ensure_generated(db: Session, tenant: TenantContext, product: Product) -> Tuple[ProductIdentifier, bool]:
    """The product's Impex code, created on first use. Calling it again returns the same code. (identifier, created)."""
    existing = get_generated(db, tenant, product.id)
    if existing:
        return existing, False
    if not product.is_active:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{product.name} is archived. Restore it before generating codes.")
    for _ in range(5):
        identifier = create_for_tenant(
            ProductIdentifier, tenant, product_id=product.id, kind="generated", value=new_generated_value(), created_by_email=tenant.email
        )
        db.add(identifier)
        try:
            db.commit()
            db.refresh(identifier)
            return identifier, True
        except IntegrityError:
            db.rollback()
            existing = get_generated(db, tenant, product.id)  # a parallel request created it first
            if existing:
                return existing, False
    raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Could not generate a code. Please try again.")


def register_external(db: Session, tenant: TenantContext, product: Product, kind: str, raw_value: str, label: Optional[str]) -> ProductIdentifier:
    """Attach a manufacturer / supplier barcode to the product. Ambiguity is refused, never resolved by guessing."""
    value = normalize_code(raw_value)
    if value.startswith(GENERATED_PREFIX):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Codes starting with {GENERATED_PREFIX} are reserved for Impex labels.")
    if not product.is_active:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{product.name} is archived. Restore it before adding barcodes.")

    existing = db.scalar(scoped_select(ProductIdentifier, tenant).where(ProductIdentifier.value == value))
    if existing is not None:
        if existing.product_id != product.id:
            other = db.scalar(scoped_select(Product, tenant).where(Product.id == existing.product_id))
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"{value} is already assigned to {other.name} ({other.sku}) in your catalog. A code can identify only one product.",
            )
        if existing.is_active:
            raise HTTPException(status.HTTP_409_CONFLICT, f"{value} is already registered on this product.")
        if existing.kind != kind:
            raise HTTPException(status.HTTP_409_CONFLICT, f"{value} was registered earlier as a {existing.kind} barcode and then retired. Register it again as {existing.kind}.")
        existing.is_active, existing.retired_at, existing.label = True, None, label  # the same code coming back to the same product
        db.commit()
        db.refresh(existing)
        return existing

    clash = db.scalar(scoped_select(Product, tenant).where(Product.sku == value, Product.id != product.id))
    if clash is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{value} is the SKU of {clash.name} in your catalog, so it cannot also be a barcode of a different product.",
        )
    identifier = create_for_tenant(ProductIdentifier, tenant, product_id=product.id, kind=kind, value=value, label=label, created_by_email=tenant.email)
    db.add(identifier)
    try:
        db.commit()
    except IntegrityError:  # a parallel request registered the same code
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, f"{value} is already assigned in your catalog. A code can identify only one product.")
    db.refresh(identifier)
    return identifier


def barcode_owner_of(db: Session, tenant: TenantContext, sku: str, exclude_product_id: Optional[uuid.UUID] = None) -> Optional[Product]:
    """The OTHER product (if any) that already has `sku` as a registered barcode, active or retired.

    A scan resolves a registered barcode first and then a SKU, so a SKU equal to another product's barcode would make that
    code ambiguous. (Retired barcodes stay reserved for their product, so they count too.)
    """
    query = (
        scoped_select(Product, tenant)
        .join(ProductIdentifier, (ProductIdentifier.product_id == Product.id) & (ProductIdentifier.organization_id == Product.organization_id))
        .where(ProductIdentifier.value == sku)
    )
    if exclude_product_id is not None:
        query = query.where(Product.id != exclude_product_id)
    return db.scalars(query).first()


def retire(db: Session, tenant: TenantContext, identifier: ProductIdentifier) -> ProductIdentifier:
    from sqlalchemy import func

    if identifier.kind == "generated":
        raise HTTPException(status.HTTP_409_CONFLICT, "The Impex label code of a product cannot be retired: printed labels depend on it.")
    if identifier.is_active:
        identifier.is_active = False
        identifier.retired_at = func.now()
        db.commit()
        db.refresh(identifier)
    return identifier


# --- resolving a scanned code -----------------------------------------------------------------------------
class Resolution:
    def __init__(self, product: Product, matched_by: str, identifier: Optional[ProductIdentifier]):
        self.product, self.matched_by, self.identifier = product, matched_by, identifier


def resolve_code(db: Session, tenant: TenantContext, raw: str) -> Resolution:
    """Which product (of this organization) does the code mean?

    Looked up in this order of meaning: a registered code (the Impex label or a manufacturer/supplier barcode), then a
    SKU. If the two readings name DIFFERENT products the code is ambiguous and nothing is returned.
    Unknown -> 404. Retired code -> 410. Ambiguous -> 409. Archived products are returned (flagged inactive).
    """
    code = normalize_code(raw)
    identifier = db.scalar(scoped_select(ProductIdentifier, tenant).where(ProductIdentifier.value == code))
    sku_product = db.scalar(scoped_select(Product, tenant).where(Product.sku == code))

    by_identifier: Optional[Product] = None
    if identifier is not None and identifier.is_active:
        by_identifier = db.scalar(scoped_select(Product, tenant).where(Product.id == identifier.product_id))

    if by_identifier is not None and sku_product is not None and by_identifier.id != sku_product.id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This code matches more than one product (a barcode of one product is the SKU of another). "
            "Fix it in the catalog, or look the product up another way.",
        )
    if by_identifier is not None:
        return Resolution(by_identifier, "identifier", identifier)
    if sku_product is not None:
        return Resolution(sku_product, "sku", None)
    if identifier is not None:  # known but retired, and no SKU claims it
        raise HTTPException(status.HTTP_410_GONE, "This barcode was retired and no longer identifies a product.")
    raise HTTPException(status.HTTP_404_NOT_FOUND, "No product in your catalog matches this code.")


# --- the unit-of-measurement lock -------------------------------------------------------------------------
def products_with_history(db: Session, tenant: TenantContext, product_ids: List[uuid.UUID]) -> set:
    """Of these products (all the tenant's), which already have stock movements."""
    if not product_ids:
        return set()
    rows = db.scalars(
        select(StockMovement.product_id)
        .where(StockMovement.organization_id == tenant.organization_id, StockMovement.product_id.in_(product_ids))
        .distinct()
    )
    return set(rows)


def annotate_unit_lock(db: Session, tenant: TenantContext, products: List[Product]) -> None:
    """Set `unit_locked` on each product so the API can tell the portal not to offer a unit change."""
    locked = products_with_history(db, tenant, [p.id for p in products])
    for product in products:
        product.unit_locked = product.id in locked  # type: ignore[attr-defined]


def has_stock_history(db: Session, tenant: TenantContext, product_id: uuid.UUID) -> bool:
    return db.scalar(scoped_count(StockMovement, tenant, StockMovement.product_id == product_id)) > 0
