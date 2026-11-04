# Impex Organization Portal

Next.js application (port **3001**) where an organization administrator signs in after activating
their invitation. Separate from the Super Admin portal (port 3000).

- `/login` – sign in with the existing Auth Service (`/api/v1/auth/login`, verified with `/api/v1/auth/me`)
- `/` – placeholder dashboard (administrator name and organization id)
- `/products` – the product catalog (add, edit, search, archive, restore)
- `/warehouses` – add, edit, archive and restore warehouses (never deleted; archived ones keep their stock and history)
- `/stock` – products with the total and the quantity in each warehouse; **Add stock / Remove stock / Transfer /
  Opening balance** forms (the browser sends an `Idempotency-Key` per action, so a double click or a retry applies once)
- `/movements` – the stock history, filterable by product, warehouse and type (read-only: movements are permanent)
- Only an **active** `organization-admin` that belongs to an organization can sign in. Super Admins cannot.
- The session lives in an HttpOnly cookie named `impex_tenant_session` (never localStorage).

Tests: `docker build --target test -t impex-dashboard-test ./frontend/dashboard && docker run --rm impex-dashboard-test`

All inventory pages share one protected frame (`src/components/portal-frame.tsx`): the session is checked in the
layout, before the page streams, so a missing or invalid session is a real HTTP redirect to `/login`. Data is read
server-side with the HttpOnly cookie as the Bearer token; the browser never names an organization.

Planned: order placement and shipment tracking, invoicing and transaction history.
