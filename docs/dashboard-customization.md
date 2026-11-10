# Personalised home page (widgets, Add Widgets, Edit Layout)

Both portals' home page (`/`) can be arranged by each person: remove a card, add it back, and drag the cards into the order they like. Only the home page has this; no other page and no business module is affected, and nothing is ever deleted (a removed card is only hidden).

## What a person can do

| Action | How |
| --- | --- |
| Remove a card | The card's three-dot button (shown on hover and keyboard focus, always shown on touch screens) → **Remove from Home**. The card's own surface does nothing special: no click, right-click or long-press menu |
| Add it back | Header **Add Widgets** button (before Customize Theme) → **Your Widgets** → **Add Widget** (goes to the end), or **Restore All Widgets** |
| Arrange | Three-dot menu → **Edit Layout**, or **Edit Layout** in the Add Widgets panel. Drag a card by its handle, or focus the handle and use the arrow keys / Home / End. **Save Layout**, **Cancel**, **Reset Layout** (default order of the visible cards; hidden stay hidden). Escape asks before discarding unsaved changes |

Links, buttons, fields, tabs and chart points inside a card work exactly as before.

## Widget registries (stable ids)

* Organization Portal – `frontend/dashboard/src/lib/dashboard-widgets.ts`: `org.overview`, `org.kpi.active-products`, `org.kpi.open-purchase-orders`, `org.kpi.invoiced-this-month`, `org.kpi.outstanding-receivables`, `org.chart.sales-purchasing-trend`, `org.chart.collections`, `org.chart.inventory-activity`, `org.list.recent-invoices`, `org.list.open-purchase-orders`, `org.list.recent-stock-movements`, `org.finance.snapshot`, `org.panel.modules`, `org.panel.quick-actions`, `org.panel.organization`. A widget that needs a module is available only while the organization has that module enabled (decided on the server).
* Super Admin Portal – `frontend/super-admin/src/lib/dashboard-widgets.ts`: `admin.kpi.active-tenants`, `admin.kpi.system-uptime`, `admin.kpi.api-gateway-requests`, `admin.kpi.pending-approvals`, `admin.panel.microservice-registry`, `admin.panel.docker-compose`, `admin.panel.api-documentation`. The figures on this dashboard are still static demo values.

The registry order is the default order. A notice that explains why figures are missing (organization inactive / unavailable) is never a widget and cannot be removed.

## Storage

`users.dashboard_layout` (JSONB, nullable, Auth Service migration `0005`): `{ version, revision, order: [ids], hidden: [ids] }`. Only identifiers are stored, never HTML, CSS or components. `NULL` = never customised = every authorized widget in the default order. Saved per user through `PUT /api/v1/auth/me/dashboard-layout` (own record only; the Auth Service validates ids per role: `org.*` for organization administrators, `admin.*` for Super Admins; unknown, repeated, mistyped or cross-role ids are refused with 422). Each portal's `PUT /api/dashboard-layout` route validates again (the Organization Portal also against the organization's enabled modules) and carries along what the person chose for widgets they cannot use right now, so switching a module off and on loses nothing. `revision` is counted by the Auth Service; the browser uses it to ignore a stale cached page.

## Code map (identical copies in both portals)

* `src/lib/dashboard-layout.ts` – pure rules (resolve, hide, show, restore all, reset, submission validation).
* `src/components/dashboard-layout/` – `layout-provider.tsx` (state, optimistic save with rollback), `layout-storage.ts` (save + in-tab memory), `dashboard-widget.tsx` (card wrapper: three-dot button / drag handle), `widget-context-menu.tsx`, `add-widgets-panel.tsx` (header button + **Your Widgets**), `layout-editor.tsx` (grid, dnd-kit drag and drop, FLIP reflow, control bar), `widget-icons.tsx`, `dashboard-layout.css`.
* Each portal's shell mounts the provider only for its home page; each home page builds one node per widget id and hands them to `DashboardLayoutEditor`.

Drag and drop uses `@dnd-kit/core` + `@dnd-kit/sortable` (pointer, touch and pen through the handle; the keyboard uses the handle's arrow keys). `prefers-reduced-motion` turns off the jiggle and the animations; the dimming stays.

## Tests

`services/auth-service/tests/test_dashboard_layout.py`; in each portal `tests/dashboard-layout-lib.test.ts`, `dashboard-layout-api.test.ts`, `dashboard-widgets.test.tsx`; the Super Admin parity test (`theme-and-shell.test.tsx`) keeps the shared copies identical.
