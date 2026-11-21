"""The PNL calculator's store: what an organization spends on ONE sales order besides the selling price.

Finance > PNL Calculator lists the organization's orders (read from the Sales Service by the portal). Opening an order asks for its expenses: the cost of the goods, the delivery
charges and any other expenses, each with a name. They are saved here, one row per organization and order, and saved again (overwritten) whenever the person changes them.

This is a CALCULATOR, not the books: nothing is posted to the journal, and no capital, investment or profit & loss figure changes because of it. The selling price is not kept here
at all: it is the order's own total, so the portal reads it from the Sales Service each time and does the subtraction (profit = selling price - goods - delivery - other expenses).
Amounts are exact decimals in the order's one currency; nothing is converted.
"""
import uuid
from decimal import Decimal
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import Field, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api import Tenant
from app.auth import TenantContext
from app.database import get_db
from app.models import OrderExpense
from app.schemas import Money, Strict, _currency
from app.tenancy import scoped_select

router = APIRouter(prefix="/api/v1/finance")
MAX_OTHER = 20


class OtherExpense(Strict):
    label: str = Field(min_length=1, max_length=60)
    amount: Money

    @field_validator("label")
    @classmethod
    def _tidy(cls, value: str) -> str:
        return " ".join(value.split())


class OrderExpensePut(Strict):
    currency_code: str
    goods_cost: Money = Decimal("0")
    delivery_charges: Money = Decimal("0")
    other_expenses: List[OtherExpense] = Field(default_factory=list, max_length=MAX_OTHER)

    @field_validator("currency_code")
    @classmethod
    def _check_currency(cls, value):
        return _currency(value)

    @field_validator("other_expenses")
    @classmethod
    def _labels_present(cls, value):
        if any(not item.label for item in value):
            raise ValueError("Every expense needs a name.")
        return value


def _money(value: Decimal) -> str:
    return format(Decimal(value).quantize(Decimal("0.0001")), "f")


def out(row: OrderExpense) -> dict:
    return {
        "order_id": str(row.order_id), "currency_code": row.currency_code, "goods_cost": _money(row.goods_cost), "delivery_charges": _money(row.delivery_charges),
        "other_expenses": [{"label": e["label"], "amount": _money(Decimal(str(e["amount"])))} for e in (row.other_expenses or [])],
        "updated_by_email": row.updated_by_email, "updated_at": row.updated_at.isoformat(),
    }


def _user_id(tenant: TenantContext) -> uuid.UUID:
    try:
        return uuid.UUID(tenant.user_id)
    except ValueError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Organization administrator permission required")


@router.get("/order-expenses", tags=["PNL calculator"])
def list_order_expenses(
    order_ids: str = Query(default="", max_length=8000, description="Comma-separated order ids"),
    all: bool = Query(default=False, description="Every saved order, newest save first (at most 5000): the Profit & Loss page joins them with the delivered orders"),
    tenant: TenantContext = Tenant,
    db: Session = Depends(get_db),
) -> Dict[str, list]:
    """The saved expenses of these orders (at most 200), so the list of orders can show each one's result. Orders nothing was saved for are simply absent."""
    if all:
        return {"items": [out(r) for r in db.scalars(scoped_select(OrderExpense, tenant).order_by(OrderExpense.updated_at.desc()).limit(5000))]}
    ids = []
    for part in [p.strip() for p in order_ids.split(",") if p.strip()][:200]:
        try:
            ids.append(uuid.UUID(part))
        except ValueError:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Order ids must be UUIDs.")
    if not ids:
        return {"items": []}
    rows = db.scalars(scoped_select(OrderExpense, tenant).where(OrderExpense.order_id.in_(ids)))
    return {"items": [out(r) for r in rows]}


@router.get("/order-expenses/{order_id}", tags=["PNL calculator"])
def get_order_expenses(order_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)) -> dict:
    row = db.scalar(scoped_select(OrderExpense, tenant).where(OrderExpense.order_id == order_id))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No expenses saved for this order.")
    return out(row)


@router.delete("/order-expenses/{order_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["PNL calculator"])
def delete_order_expenses(order_id: uuid.UUID, tenant: TenantContext = Tenant, db: Session = Depends(get_db)) -> Response:
    """Remove what was saved for one order: it goes back to "not calculated". Only this calculator's notes are removed (never the order, and nothing in the books)."""
    row = db.scalar(scoped_select(OrderExpense, tenant).where(OrderExpense.order_id == order_id).with_for_update())
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No expenses saved for this order.")
    db.delete(row)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/order-expenses/{order_id}", tags=["PNL calculator"])
def save_order_expenses(order_id: uuid.UUID, payload: OrderExpensePut, tenant: TenantContext = Tenant, db: Session = Depends(get_db)) -> dict:
    """Save (or overwrite) the expenses of one order. Saving the same figures again changes nothing; it never posts anything to the books."""
    others = [{"label": e.label, "amount": _money(e.amount)} for e in payload.other_expenses]
    row: Optional[OrderExpense] = db.scalar(scoped_select(OrderExpense, tenant).where(OrderExpense.order_id == order_id).with_for_update())
    if row is None:
        row = OrderExpense(organization_id=tenant.organization_id, order_id=order_id, currency_code=payload.currency_code, goods_cost=payload.goods_cost,
                           delivery_charges=payload.delivery_charges, other_expenses=others, updated_by=_user_id(tenant), updated_by_email=tenant.email)
        db.add(row)
    else:
        row.currency_code, row.goods_cost, row.delivery_charges, row.other_expenses = payload.currency_code, payload.goods_cost, payload.delivery_charges, others
        row.updated_by, row.updated_by_email = _user_id(tenant), tenant.email
        row.updated_at = func.now()
    db.commit()
    db.refresh(row)
    return out(row)
