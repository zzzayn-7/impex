# Impex Organization Portal

Next.js application (port **3001**) where an organization administrator signs in after activating
their invitation. Separate from the Super Admin portal (port 3000).

- `/login` – sign in with the existing Auth Service (`/api/v1/auth/login`, verified with `/api/v1/auth/me`)
- `/` – placeholder dashboard (administrator name and organization id)
- `/products` – the product catalog (add, edit, search, archive, restore)
- `/warehouses` – add, edit, archive and restore warehouses (never deleted; archived ones keep their stock and history)
- `/stock` – products with the total and the quantity in each warehouse; **Add stock / Remove stock / Transfer /
  Opening balance** forms (the browser sends an `Idempotency-Key` per action, so a double click or a retry applies once)
- `/scan` – **Scan Product**: scan a QR code / barcode with a USB or Bluetooth scanner (keyboard mode), the phone or desktop camera, or type a SKU. Shows the product, unit, stock per warehouse, total and available stock, and Stock In / Stock Out / Transfer, each with a confirmation step. Scanning never changes stock. The camera needs HTTPS (see [`docs/scanning.md`](../../docs/scanning.md)).
- `/products/<id>/codes` – generate and print a product's QR code + Code 128 label, register manufacturer/supplier barcodes
- `/delivery-lists` – **Delivery Lists**: lists of products promised to a client (create, search/filter by client, reference or status). `/delivery-lists/<id>`: view products and quantities with live availability, add products by scanning (`/scan?list=<id>`) or by typing a SKU/barcode, edit quantities, remove lines, save the draft, mark it Ready or Cancelled. **A list never deducts or reserves stock.**
- `/clients` – the client directory (register, search, edit, deactivate)
- `/movements` – the stock history, filterable by product, warehouse and type (read-only: movements are permanent)
- Only an **active** `organization-admin` that belongs to an organization can sign in. Super Admins cannot.
- The session lives in an HttpOnly cookie named `impex_tenant_session` (never localStorage).

Tests: `docker build --target test -t impex-dashboard-test ./frontend/dashboard && docker run --rm impex-dashboard-test`

All inventory pages share one protected frame (`src/components/portal-frame.tsx`): the session is checked in the
layout, before the page streams, so a missing or invalid session is a real HTTP redirect to `/login`. Data is read
server-side with the HttpOnly cookie as the Bearer token; the browser never names an organization.

The browser talks only to this portal's own `/api/sales/*` routes (HttpOnly session cookie to Bearer token); it never names an
organization, never supplies product names, SKUs, units or stock, and sends quantities as exact strings.

Planned: dispatch of delivery lists, invoicing and transaction history.
