"""Stock changes, balances and the movement ledger.

Guarantees (each is also backed by a database constraint, so a bug here cannot silently break them):

  * A balance never goes negative.      CHECK (quantity >= 0), plus the row is locked while it is read and changed.
  * Every change is in the ledger.      One movement row per change, written in the SAME transaction as the balance.
  * The ledger is append-only.          A trigger rejects UPDATE/DELETE; there is no API for either.
  * A transfer is atomic.               Both balances and both movements commit together or not at all.
  * Retries are safe.                   Each request carries an Idempotency-Key; a repeat replays the first result.
  * Tenants never mix.                  Every query is tenant-scoped, and composite foreign keys tie a stock row,
                                        its product and its warehouse to the same organization in the database.
  * Quantities are exact decimals, whole numbers for indivisible units (pieces, boxes, ...).
"""
import hashlib
import json
import uuid
from decimal import Decimal
from typing import Dict, List, Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.auth import TenantContext
from app.models import Product, StockBalance, StockMovement, StockOperation, Warehouse
from app.schemas import (
    MovementList,
    MovementResponse,
    StockChange,
    StockLine,
    StockOperationResult,
    StockOverview,
    StockProduct,
    StockTransfer,
)
from app.search import like_pattern
from app.tenancy import create_for_tenant, get_scoped_or_404, scoped_count, scoped_select
from app.units import allows_fractions

QUANT = Decimal("0.0001")
ZERO = Decimal("0")
DEFAULT_REASONS = {"opening": "Opening balance", "in": "Stock in", "out": "Stock out", "transfer": "Stock transfer"}


# --- small helpers -----------------------------------------------------------------------------------
def _user_id(tenant: TenantContext) -> uuid.UUID:
    try:
        return uuid.UUID(tenant.user_id)
    except ValueError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Organization administrator permission required")


def canonical(value: Decimal) -> str:
    return format(value.quantize(QUANT), "f")


def human(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def fingerprint(kind: str, **fields) -> str:
    """A stable hash of what the request asked for, so a reused key with a DIFFERENT request is detected."""
    body = json.dumps({"kind": kind, **{k: str(v) for k, v in fields.items()}}, sort_keys=True)
    return hashlib.sha256(body.encode()).hexdigest()


def _load_product_locked(db: Session, tenant: TenantContext, product_id: uuid.UUID) -> Product:
    """The tenant's product, with a shared row lock held until the transaction ends.

    The lock makes "change the unit" and "record stock" mutually exclusive: an UPDATE of the product waits for us,
    and (because the row is re-read after the lock is taken) we always see the unit that is really in force.
    """
    product = db.scalar(
        scoped_select(Product, tenant).where(Product.id == product_id).with_for_update(read=True).execution_options(populate_existing=True)
    )
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found.")
    return product


def _require_active(product: Product, *warehouses: Warehouse) -> None:
    if not product.is_active:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{product.name} is archived. Restore it before changing its stock.")
    for warehouse in warehouses:
        if not warehouse.is_active:
            raise HTTPException(status.HTTP_409_CONFLICT, f"Warehouse {warehouse.code} is archived. Restore it before changing its stock.")


def _check_quantity_for_unit(product: Product, quantity: Decimal) -> None:
    if not allows_fractions(product.unit) and quantity != quantity.to_integral_value():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Quantity must be a whole number: {product.name} is counted in '{product.unit}'.",
        )


def _insufficient(product: Product, warehouse: Warehouse, available: Decimal, requested: Decimal) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        f"Insufficient stock: {human(available)} {product.unit} of {product.name} available in {warehouse.code}, "
        f"{human(requested)} requested.",
    )


# --- movements as the API shows them -------------------------------------------------------------------
def _movement_query(tenant: TenantContext):
    return (
        scoped_select(StockMovement, tenant)
        .add_columns(Product, Warehouse)
        .join(Product, and_(Product.id == StockMovement.product_id, Product.organization_id == StockMovement.organization_id))
        .join(Warehouse, and_(Warehouse.id == StockMovement.warehouse_id, Warehouse.organization_id == StockMovement.organization_id))
    )


def _to_response(movement: StockMovement, product: Product, warehouse: Warehouse) -> MovementResponse:
    return MovementResponse(
        id=movement.id,
        operation_id=movement.operation_id,
        product_id=product.id,
        product_sku=product.sku,
        product_name=product.name,
        product_unit=product.unit,
        unit_allows_fractions=allows_fractions(product.unit),
        warehouse_id=warehouse.id,
        warehouse_code=warehouse.code,
        warehouse_name=warehouse.name,
        movement_type=movement.movement_type,
        quantity=movement.quantity,
        balance_after=movement.balance_after,
        reason=movement.reason,
        transfer_id=movement.transfer_id,
        created_by_email=movement.created_by_email,
        created_at=movement.created_at,
    )


def _result(db: Session, tenant: TenantContext, operation: uuid.UUID, kind: str, replayed: bool) -> StockOperationResult:
    rows = db.execute(
        _movement_query(tenant).where(StockMovement.operation_id == operation).order_by(StockMovement.movement_type.desc(), StockMovement.id)
    ).all()
    return StockOperationResult(operation_id=operation, kind=kind, replayed=replayed, movements=[_to_response(*row) for row in rows])


# --- idempotency -------------------------------------------------------------------------------------
def _start_operation(db: Session, tenant: TenantContext, kind: str, key: str, request_hash: str) -> Optional[uuid.UUID]:
    """Claim the Idempotency-Key. None means the key was already used (the caller replays instead of acting).

    The unique (organization_id, idempotency_key) index makes a concurrent duplicate WAIT for this transaction:
    if it commits the duplicate sees the conflict and replays; if it rolls back the duplicate proceeds on its own.
    """
    statement = (
        pg_insert(StockOperation)
        .values(organization_id=tenant.organization_id, kind=kind, idempotency_key=key, request_hash=request_hash, created_by=_user_id(tenant))
        .on_conflict_do_nothing(index_elements=["organization_id", "idempotency_key"])
        .returning(StockOperation.id)
    )
    row = db.execute(statement).first()
    return row[0] if row else None


def _replay(db: Session, tenant: TenantContext, key: str, kind: str, request_hash: str) -> StockOperationResult:
    operation = db.scalar(scoped_select(StockOperation, tenant).where(StockOperation.idempotency_key == key))
    if operation is None:  # the first attempt rolled back at just the wrong moment: ask the client to retry
        raise HTTPException(status.HTTP_409_CONFLICT, "The request was being processed. Please retry.")
    if operation.request_hash != request_hash or operation.kind != kind:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This Idempotency-Key was already used for a different request. Use a new key for a new request.",
        )
    return _result(db, tenant, operation.id, operation.kind, replayed=True)


# --- balances and the ledger -----------------------------------------------------------------------------
def _lock_balances(db: Session, tenant: TenantContext, product_id: uuid.UUID, warehouse_ids: Sequence[uuid.UUID]) -> Dict[uuid.UUID, StockBalance]:
    """Make sure a balance row exists for each warehouse, then lock them (in a fixed order, so two transfers
    in opposite directions can never deadlock). Nobody else can change these balances until we commit."""
    for warehouse_id in warehouse_ids:
        db.execute(
            pg_insert(StockBalance)
            .values(organization_id=tenant.organization_id, product_id=product_id, warehouse_id=warehouse_id, quantity=0)
            .on_conflict_do_nothing(index_elements=["organization_id", "product_id", "warehouse_id"])
        )
    rows = db.scalars(
        scoped_select(StockBalance, tenant)
        .where(StockBalance.product_id == product_id, StockBalance.warehouse_id.in_(list(warehouse_ids)))
        .order_by(StockBalance.warehouse_id)
        .with_for_update()
    ).all()
    return {row.warehouse_id: row for row in rows}


def _add_movement(
    db: Session,
    tenant: TenantContext,
    operation: uuid.UUID,
    product: Product,
    warehouse: Warehouse,
    movement_type: str,
    quantity: Decimal,
    balance_after: Decimal,
    reason: str,
    transfer_id: Optional[uuid.UUID] = None,
) -> StockMovement:
    movement = create_for_tenant(
        StockMovement,
        tenant,
        operation_id=operation,
        product_id=product.id,
        warehouse_id=warehouse.id,
        movement_type=movement_type,
        quantity=quantity,
        balance_after=balance_after,
        reason=reason,
        transfer_id=transfer_id,
        created_by=_user_id(tenant),
        created_by_email=tenant.email,
    )
    db.add(movement)
    db.flush()
    return movement


# --- opening balance, stock in, stock out ----------------------------------------------------------------
def execute_change(db: Session, tenant: TenantContext, kind: str, payload: StockChange, key: str) -> StockOperationResult:
    reason = payload.reason or DEFAULT_REASONS[kind]
    request_hash = fingerprint(kind, product=payload.product_id, warehouse=payload.warehouse_id, quantity=canonical(payload.quantity), reason=reason)
    try:
        operation = _start_operation(db, tenant, kind, key, request_hash)
        if operation is None:
            db.rollback()
            return _replay(db, tenant, key, kind, request_hash)

        product = _load_product_locked(db, tenant, payload.product_id)
        warehouse = get_scoped_or_404(db, Warehouse, tenant, payload.warehouse_id, "Warehouse")
        _require_active(product, warehouse)
        _check_quantity_for_unit(product, payload.quantity)

        balance = _lock_balances(db, tenant, product.id, [warehouse.id])[warehouse.id]
        if kind == "opening":
            history = scoped_count(StockMovement, tenant, StockMovement.product_id == product.id, StockMovement.warehouse_id == warehouse.id)
            if db.scalar(history) > 0:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"{product.name} already has stock history in {warehouse.code}. An opening balance can only be recorded "
                    "before any other movement; use Add stock or Remove stock instead.",
                )
        new_balance = balance.quantity + payload.quantity if kind in ("opening", "in") else balance.quantity - payload.quantity
        if new_balance < ZERO:
            raise _insufficient(product, warehouse, balance.quantity, payload.quantity)

        balance.quantity = new_balance
        _add_movement(db, tenant, operation, product, warehouse, kind, payload.quantity, new_balance, reason)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return _result(db, tenant, operation, kind, replayed=False)


# --- transfer between warehouses ---------------------------------------------------------------------------
def execute_transfer(db: Session, tenant: TenantContext, payload: StockTransfer, key: str) -> StockOperationResult:
    if payload.from_warehouse_id == payload.to_warehouse_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Choose two different warehouses.")
    reason = payload.reason or DEFAULT_REASONS["transfer"]
    request_hash = fingerprint(
        "transfer", product=payload.product_id, source=payload.from_warehouse_id, destination=payload.to_warehouse_id,
        quantity=canonical(payload.quantity), reason=reason,
    )
    try:
        operation = _start_operation(db, tenant, "transfer", key, request_hash)
        if operation is None:
            db.rollback()
            return _replay(db, tenant, key, "transfer", request_hash)

        product = _load_product_locked(db, tenant, payload.product_id)
        source = get_scoped_or_404(db, Warehouse, tenant, payload.from_warehouse_id, "Warehouse")
        destination = get_scoped_or_404(db, Warehouse, tenant, payload.to_warehouse_id, "Warehouse")
        _require_active(product, source, destination)
        _check_quantity_for_unit(product, payload.quantity)

        balances = _lock_balances(db, tenant, product.id, [source.id, destination.id])
        source_balance, destination_balance = balances[source.id], balances[destination.id]
        if source_balance.quantity < payload.quantity:
            raise _insufficient(product, source, source_balance.quantity, payload.quantity)

        source_balance.quantity = source_balance.quantity - payload.quantity
        destination_balance.quantity = destination_balance.quantity + payload.quantity
        transfer_id = uuid.uuid4()
        _add_movement(db, tenant, operation, product, source, "transfer_out", payload.quantity, source_balance.quantity, reason, transfer_id)
        _add_movement(db, tenant, operation, product, destination, "transfer_in", payload.quantity, destination_balance.quantity, reason, transfer_id)
        db.commit()  # both balances and both movements, or nothing
    except Exception:
        db.rollback()
        raise
    return _result(db, tenant, operation, "transfer", replayed=False)


# --- reading --------------------------------------------------------------------------------------------------
def list_movements(
    db: Session,
    tenant: TenantContext,
    *,
    product_id: Optional[uuid.UUID],
    warehouse_id: Optional[uuid.UUID],
    movement_type: Optional[str],
    limit: int,
    offset: int,
) -> MovementList:
    filters = []
    if product_id:
        filters.append(StockMovement.product_id == product_id)
    if warehouse_id:
        filters.append(StockMovement.warehouse_id == warehouse_id)
    if movement_type:
        filters.append(StockMovement.movement_type == movement_type)
    total = db.scalar(scoped_count(StockMovement, tenant, *filters))
    rows = db.execute(
        _movement_query(tenant).where(*filters).order_by(StockMovement.created_at.desc(), StockMovement.movement_type.desc(), StockMovement.id).limit(limit).offset(offset)
    ).all()
    return MovementList(items=[_to_response(*row) for row in rows], total=total, limit=limit, offset=offset)


def stock_items(db: Session, tenant: TenantContext, products: Sequence[Product], warehouse_id: Optional[uuid.UUID] = None) -> List[StockProduct]:
    """Quantities per warehouse and totals for the given products (all of them the tenant's), tenant-scoped."""
    lines: Dict[uuid.UUID, List[StockLine]] = {p.id: [] for p in products}
    if products:
        line_query = (
            scoped_select(StockBalance, tenant)
            .add_columns(Warehouse)
            .join(Warehouse, and_(Warehouse.id == StockBalance.warehouse_id, Warehouse.organization_id == StockBalance.organization_id))
            .where(StockBalance.product_id.in_(list(lines)), StockBalance.quantity > 0)
            .order_by(Warehouse.code)
        )
        if warehouse_id:
            line_query = line_query.where(StockBalance.warehouse_id == warehouse_id)
        for balance, warehouse in db.execute(line_query).all():
            lines[balance.product_id].append(
                StockLine(
                    warehouse_id=warehouse.id, warehouse_code=warehouse.code, warehouse_name=warehouse.name,
                    warehouse_active=warehouse.is_active, quantity=balance.quantity,
                )
            )

    return [
        StockProduct(
            product_id=p.id, sku=p.sku, name=p.name, category=p.category, unit=p.unit,
            unit_allows_fractions=allows_fractions(p.unit), is_active=p.is_active,
            total_quantity=sum((line.quantity for line in lines[p.id]), ZERO),
            available_quantity=sum((line.quantity for line in lines[p.id] if line.warehouse_active), ZERO),
            lines=lines[p.id],
        )
        for p in products
    ]


def stock_overview(
    db: Session,
    tenant: TenantContext,
    *,
    q: Optional[str],
    category: Optional[str],
    warehouse_id: Optional[uuid.UUID],
    product_status: str,
    in_stock_only: bool,
    limit: int,
    offset: int,
) -> StockOverview:
    filters = []
    if q and q.strip():
        pattern = like_pattern(q.strip())
        filters.append(or_(Product.sku.ilike(pattern, escape="\\"), Product.name.ilike(pattern, escape="\\"), Product.category.ilike(pattern, escape="\\")))
    if category and category.strip():
        filters.append(func.lower(Product.category) == category.strip().lower())
    if product_status == "active":
        filters.append(Product.is_active.is_(True))
    elif product_status == "archived":
        filters.append(Product.is_active.is_(False))

    # "has stock" (optionally: in this warehouse), always inside the tenant
    held = and_(StockBalance.organization_id == tenant.organization_id, StockBalance.product_id == Product.id, StockBalance.quantity > 0)
    if warehouse_id:
        held = and_(held, StockBalance.warehouse_id == warehouse_id)
    if warehouse_id or in_stock_only:
        filters.append(exists().where(held))

    total = db.scalar(scoped_count(Product, tenant, *filters))
    products = db.scalars(
        scoped_select(Product, tenant).where(*filters).order_by(Product.name, Product.sku, Product.id).limit(limit).offset(offset)
    ).all()

    items = stock_items(db, tenant, products, warehouse_id)
    return StockOverview(items=items, total=total, limit=limit, offset=offset)


def products_in_stock_by_warehouse(db: Session, tenant: TenantContext, warehouse_ids: Sequence[uuid.UUID]) -> Dict[uuid.UUID, int]:
    """For each warehouse: how many products currently have stock there (tenant-scoped)."""
    if not warehouse_ids:
        return {}
    rows = db.execute(
        select(StockBalance.warehouse_id, func.count())
        .where(
            StockBalance.organization_id == tenant.organization_id,
            StockBalance.warehouse_id.in_(list(warehouse_ids)),
            StockBalance.quantity > 0,
        )
        .group_by(StockBalance.warehouse_id)
    ).all()
    return {warehouse_id: count for warehouse_id, count in rows}
