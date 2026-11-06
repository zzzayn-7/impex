"""What the Purchasing module has in progress for one organization. Asked only by the Organization Service, before the Super Admin switches
the module off (see the Organization Service's app/module_usage.py).

  * `blocking` : operations that are half way through and would be stranded: goods receipts in `posting` (stock is being added).
  * `warnings` : records that merely stay as they are while the module is off (nothing is deleted or changed; they are all there again
                 when it is switched back on).

The caller proves itself with the shared secret MODULE_INTERNAL_API_KEY, not with a user's token; the route is not part of the public
documentation and is not reachable from a browser. The organization is named in the path because the Organization Service, not a
user, is asking.
"""
import hmac
import os
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import GoodsReceipt, PurchaseOrder

router = APIRouter(include_in_schema=False)


def require_module_internal_key(x_internal_key: Optional[str] = Header(default=None)) -> None:
    expected = os.getenv("MODULE_INTERNAL_API_KEY", "")
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Service authentication is not configured")
    if not x_internal_key or not hmac.compare_digest(x_internal_key.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid service credentials")


def _count(db: Session, model, organization_id: uuid.UUID, *statuses: str) -> int:
    return db.scalar(select(func.count()).select_from(model).where(model.organization_id == organization_id, model.status.in_(statuses))) or 0


@router.get("/internal/v1/organizations/{organization_id}/module-usage", dependencies=[Depends(require_module_internal_key)])
def module_usage(organization_id: uuid.UUID, db: Session = Depends(get_db)):
    return {
        "module": "purchasing",
        "blocking": [
            {"code": "receipts_posting", "label": "Goods receipts being posted to stock", "count": _count(db, GoodsReceipt, organization_id, "posting")},
        ],
        "warnings": [
            {"code": "orders_awaiting_goods", "label": "Purchase orders still waiting for goods (goods cannot be received while Purchasing is off)", "count": _count(db, PurchaseOrder, organization_id, "ordered", "partially_received")},
            {"code": "orders_draft", "label": "Draft purchase orders", "count": _count(db, PurchaseOrder, organization_id, "draft")},
            {"code": "receipts_draft", "label": "Draft goods receipts", "count": _count(db, GoodsReceipt, organization_id, "draft")},
        ],
    }
