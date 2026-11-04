import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, status
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import TenantContext, create_auth_client, create_org_client, require_active_tenant
from app.database import get_db
from app.models import Product
from app.schemas import ProductCreate, ProductList, ProductResponse, ProductUpdate
from app.tenancy import create_for_tenant, get_scoped_or_404, scoped_count, scoped_select


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.auth_client = create_auth_client()
    app.state.org_client = create_org_client()
    yield
    await app.state.auth_client.aclose()
    await app.state.org_client.aclose()


app = FastAPI(
    title="Impex Inventory Service",
    version="1.0.0",
    docs_url="/docs",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

# Every product endpoint depends on this: an ACTIVE organization administrator whose organization is active.
# The organization is taken only from the Auth Service's record of the caller; no endpoint accepts one as input.
Tenant = Depends(require_active_tenant)

PREFIX = "/api/v1/inventory"


@app.get("/health", tags=["Health"])
@app.get(f"{PREFIX}/health", tags=["Health"])
async def health_check():
    return {
        "status": "healthy",
        "service": "inventory-service",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def sku_taken(db: Session, tenant: TenantContext, sku: str, exclude: Optional[uuid.UUID] = None) -> bool:
    query = scoped_count(Product, tenant, Product.sku == sku)
    if exclude is not None:
        query = query.where(Product.id != exclude)
    return db.scalar(query) > 0


def sku_conflict(sku: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, f"A product with SKU '{sku}' already exists in your catalog.")


def like_pattern(term: str) -> str:
    """A contains-pattern for ILIKE where the user's % and _ are matched literally."""
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


@app.get(f"{PREFIX}/products", response_model=ProductList, tags=["Products"])
def list_products(
    q: Optional[str] = Query(default=None, max_length=100, description="Search SKU, name, description, category, HS code"),
    category: Optional[str] = Query(default=None, max_length=100),
    status_filter: Literal["active", "archived", "all"] = Query(default="active", alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
):
    filters = []
    if q and q.strip():
        pattern = like_pattern(q.strip())
        filters.append(
            or_(
                Product.sku.ilike(pattern, escape="\\"),
                Product.name.ilike(pattern, escape="\\"),
                Product.description.ilike(pattern, escape="\\"),
                Product.category.ilike(pattern, escape="\\"),
                Product.hs_code.ilike(pattern, escape="\\"),
            )
        )
    if category and category.strip():
        filters.append(func.lower(Product.category) == category.strip().lower())
    if status_filter == "active":
        filters.append(Product.is_active.is_(True))
    elif status_filter == "archived":
        filters.append(Product.is_active.is_(False))

    total = db.scalar(scoped_count(Product, tenant, *filters))
    items = db.scalars(
        scoped_select(Product, tenant)
        .where(*filters)
        .order_by(Product.name, Product.sku, Product.id)
        .limit(limit)
        .offset(offset)
    ).all()
    return ProductList(items=items, total=total, limit=limit, offset=offset)


@app.get(f"{PREFIX}/categories", response_model=List[str], tags=["Products"])
def list_categories(tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """The distinct categories used in the tenant's own catalog (for filter drop-downs)."""
    query = scoped_select(Product, tenant).with_only_columns(Product.category).distinct().order_by(Product.category)
    return list(db.scalars(query))


@app.post(f"{PREFIX}/products", response_model=ProductResponse, status_code=status.HTTP_201_CREATED, tags=["Products"])
def create_product(payload: ProductCreate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    if sku_taken(db, tenant, payload.sku):
        raise sku_conflict(payload.sku)
    product = create_for_tenant(Product, tenant, **payload.model_dump())  # organization_id from the context only
    db.add(product)
    try:
        db.commit()
    except IntegrityError:  # two requests with the same SKU raced past the check above
        db.rollback()
        raise sku_conflict(payload.sku)
    db.refresh(product)
    return product


@app.get(f"{PREFIX}/products/{{product_id}}", response_model=ProductResponse, tags=["Products"])
def get_product(product_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return get_scoped_or_404(db, Product, tenant, product_id, "Product")


@app.patch(f"{PREFIX}/products/{{product_id}}", response_model=ProductResponse, tags=["Products"])
def update_product(product_id: uuid.UUID, payload: ProductUpdate, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    product = get_scoped_or_404(db, Product, tenant, product_id, "Product")
    changes = payload.model_dump(exclude_unset=True)
    if "sku" in changes and changes["sku"] != product.sku and sku_taken(db, tenant, changes["sku"], exclude=product.id):
        raise sku_conflict(changes["sku"])
    for field, value in changes.items():
        setattr(product, field, value)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise sku_conflict(changes.get("sku", product.sku))
    db.refresh(product)
    return product


def _set_active(db: Session, tenant: TenantContext, product_id: uuid.UUID, active: bool) -> Product:
    product = get_scoped_or_404(db, Product, tenant, product_id, "Product")
    if product.is_active != active:
        product.is_active = active
        db.commit()
        db.refresh(product)
    return product


@app.post(f"{PREFIX}/products/{{product_id}}/archive", response_model=ProductResponse, tags=["Products"])
def archive_product(product_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    """Archive (soft-delete): the product disappears from the default list but nothing is erased."""
    return _set_active(db, tenant, product_id, False)


@app.post(f"{PREFIX}/products/{{product_id}}/restore", response_model=ProductResponse, tags=["Products"])
def restore_product(product_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)):
    return _set_active(db, tenant, product_id, True)
