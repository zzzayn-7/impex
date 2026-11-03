# Impex Organization Portal

Next.js application (port **3001**) where an organization administrator signs in after activating
their invitation. Separate from the Super Admin portal (port 3000).

- `/login` – sign in with the existing Auth Service (`/api/v1/auth/login`, verified with `/api/v1/auth/me`)
- `/` – placeholder dashboard (administrator name and organization id)
- Only an **active** `organization-admin` that belongs to an organization can sign in. Super Admins cannot.
- The session lives in an HttpOnly cookie named `impex_tenant_session` (never localStorage).

Tests: `docker build --target test -t impex-dashboard-test ./frontend/dashboard && docker run --rm impex-dashboard-test`

Planned: organization-specific operations, order placement and shipment tracking, inventory visibility,
invoicing and transaction history.
