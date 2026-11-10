"""A person's own arrangement of the widgets on their portal's home page.

What is stored is a small document of widget IDENTIFIERS: the visible widgets in order, the hidden ones, a schema version and a revision counter. Never
HTML, CSS, a component name or any free text. The portals own what each widget looks like and which modules it needs (their widget registries); this module
owns WHICH identifiers are valid for WHICH role, so a browser can never make the service store anything else. The user is always the one the token belongs
to: there is no way to name another user. Organization administrators and Super Admins have separate identifier namespaces ("org." and "admin."), so
neither can ever hold the other's widgets.

Module permissions are NOT decided here (this service does not know an organization's modules): the Organization Portal checks that before it forwards a
save, and a widget whose module is switched off simply stops being listed and is kept in the saved document for when the module comes back.

KEEP IN SYNC with frontend/dashboard/src/lib/dashboard-widgets.ts (ORG_WIDGETS) and frontend/super-admin/src/lib/dashboard-widgets.ts (ADMIN_WIDGETS);
the portals' tests compare the lists.
"""
from typing import Any, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models import User

LAYOUT_VERSION = 1
MAX_WIDGETS = 64

ORGANIZATION_ADMIN_ROLE = "organization-admin"
SUPER_ADMIN_ROLE = "super-admin"

ORG_WIDGET_IDS: Tuple[str, ...] = (
    "org.overview",
    "org.kpi.active-products",
    "org.kpi.open-purchase-orders",
    "org.kpi.invoiced-this-month",
    "org.kpi.outstanding-receivables",
    "org.chart.sales-purchasing-trend",
    "org.chart.collections",
    "org.chart.inventory-activity",
    "org.list.recent-invoices",
    "org.list.open-purchase-orders",
    "org.list.recent-stock-movements",
    "org.finance.snapshot",
    "org.panel.modules",
    "org.panel.quick-actions",
    "org.panel.organization",
)

ADMIN_WIDGET_IDS: Tuple[str, ...] = (
    "admin.kpi.active-tenants",
    "admin.kpi.system-uptime",
    "admin.kpi.api-gateway-requests",
    "admin.kpi.pending-approvals",
    "admin.panel.microservice-registry",
    "admin.panel.docker-compose",
    "admin.panel.api-documentation",
)

_BY_ROLE = {ORGANIZATION_ADMIN_ROLE: ORG_WIDGET_IDS, SUPER_ADMIN_ROLE: ADMIN_WIDGET_IDS}


def known_ids(role: str) -> Tuple[str, ...]:
    """The identifiers this role may ever hold; empty for any other role."""
    return _BY_ROLE.get(role, ())


def _refuse(message: str, code: str = "invalid_dashboard_layout", http: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(http, detail={"code": code, "message": message})


def _id_list(value: object, name: str, allowed: Tuple[str, ...]) -> List[str]:
    if not isinstance(value, list) or len(value) > MAX_WIDGETS:
        raise _refuse(f"{name} must be a list of widget identifiers.")
    seen: set = set()
    for item in value:
        if not isinstance(item, str) or item not in allowed:
            raise _refuse("Unknown widget.")
        if item in seen:
            raise _refuse("A widget can appear only once.")
        seen.add(item)
    return list(value)


def clean_layout(role: str, order: object, hidden: object) -> Tuple[List[str], List[str]]:
    """Both lists must hold only identifiers of this role's widgets, each at most once, and no widget may be both shown and hidden."""
    allowed = known_ids(role)
    if not allowed:
        raise _refuse("This account has no dashboard widgets.", "no_dashboard", status.HTTP_403_FORBIDDEN)
    shown = _id_list(order, "order", allowed)
    away = _id_list(hidden, "hidden", allowed)
    if set(shown) & set(away):
        raise _refuse("A widget cannot be both on the dashboard and hidden.")
    return shown, away


def set_layout(db: Session, user: User, order: object, hidden: object) -> User:
    shown, away = clean_layout(user.role, order, hidden)
    stored = user.dashboard_layout if isinstance(user.dashboard_layout, dict) else {}
    revision = stored.get("revision") if isinstance(stored.get("revision"), int) else 0
    # A new dict (not an in-place change) so SQLAlchemy sees the JSON column as modified.
    user.dashboard_layout = {"version": LAYOUT_VERSION, "revision": revision + 1, "order": shown, "hidden": away}
    db.commit()
    db.refresh(user)
    return user


def layout_of(user: User) -> Optional[dict[str, Any]]:
    """What is saved, read defensively: identifiers that are not (or no longer) approved for the role are dropped and repeats are ignored, so a widget that
    was retired never breaks the page. None when the person never customised anything."""
    stored = user.dashboard_layout
    if not isinstance(stored, dict):
        return None
    allowed = known_ids(user.role)
    seen: set = set()

    def keep(value: object) -> List[str]:
        out: List[str] = []
        for item in value if isinstance(value, list) else []:
            if isinstance(item, str) and item in allowed and item not in seen:
                seen.add(item)
                out.append(item)
        return out

    hidden = keep(stored.get("hidden"))  # hidden wins if a document ever lists a widget twice
    seen_hidden = set(hidden)
    seen = set(seen_hidden)
    order = keep(stored.get("order"))
    revision = stored.get("revision") if isinstance(stored.get("revision"), int) and stored.get("revision") >= 0 else 0
    return {"version": LAYOUT_VERSION, "revision": revision, "order": order, "hidden": hidden}
