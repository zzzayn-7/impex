"""What the Sales module has in progress for one organization. Asked only by the Organization Service, before the Super Admin switches
the module off (see the Organization Service's app/module_usage.py).

  * `blocking` : operations that are half way through and would be stranded: dispatches in `posting` (stock is being deducted).
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
from app.models import DeliveryList, Dispatch, Invoice

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
        "module": "sales",
        "blocking": [
            {"code": "dispatches_posting", "label": "Dispatches being posted to stock", "count": _count(db, Dispatch, organization_id, "posting")},
        ],
        "warnings": [
            {"code": "delivery_lists_open", "label": "Delivery lists not yet fully dispatched", "count": _count(db, DeliveryList, organization_id, "draft", "ready", "partially_dispatched")},
            {"code": "dispatches_draft", "label": "Draft dispatches", "count": _count(db, Dispatch, organization_id, "draft")},
            {"code": "invoices_draft", "label": "Draft invoices", "count": _count(db, Invoice, organization_id, "draft")},
            {"code": "invoices_unpaid", "label": "Invoices not fully paid (payments cannot be recorded while Sales is off)", "count": _count(db, Invoice, organization_id, "issued", "partially_paid")},
        ],
    }
