# Impex Organization Portal

Next.js application (port **3001**) where an organization administrator signs in after activating
their invitation. Separate from the Super Admin portal (port 3000).

- `/login` – sign in with the existing Auth Service (`/api/v1/auth/login`, verified with `/api/v1/auth/me`)
- `/` – placeholder dashboard (administrator name and organization id)
- `/products` – the product catalog (add, edit, search, archive, restore)
- `/stock` – products with the quantity in stock; **Add stock / Remove stock /
  Opening balance** forms (the browser sends an `Idempotency-Key` per action, so a double click or a retry applies once)
- `/scan` – **Scan Product**: scan a QR code / barcode with a USB or Bluetooth scanner (keyboard mode), the phone or desktop camera, or type a SKU. Shows the product, unit and stock on hand, and Stock In / Stock Out, each with a confirmation step. Scanning never changes stock. The camera needs HTTPS (see [`docs/scanning.md`](../../docs/scanning.md)).
- `/products/<id>/codes` – generate and print a product's QR code + Code 128 label, register manufacturer/supplier barcodes
- `/delivery-lists` – **Delivery Lists**: lists of products promised to a client (create, search/filter by client, reference or status). `/delivery-lists/<id>`: view products and quantities with live availability, add products by scanning (`/scan?list=<id>`) or by typing a SKU/barcode, edit quantities, remove lines, save the draft, mark it Ready or Cancelled. **A list never deducts or reserves stock.**
- `/suppliers` – the supplier directory (register, search, filter by status, details, edit, deactivate/reactivate)
- `/purchase-orders` – **Purchase Orders**: create a draft for a supplier, add existing products (typed or scanned SKU/barcode) with a quantity and a purchase price, see the line totals and the order total, edit the draft, **place** it (freezes it) or **cancel** it. `/purchase-orders/<id>` shows one order. **An order never adds stock.** An Ordered order offers **Receive goods**, and shows per product what is ordered, received, in progress and remaining.
- `/purchase-orders/<id>/receive` – **Receive Goods**: enter what arrived per product (accepted quantity and optional rejected quantity for each product), optionally locate a product by typing or scanning its SKU/barcode (a product that is not on the order is refused), **review** the receipt, then explicitly **confirm**. Saving and reviewing only keep a draft; stock is added only on *Confirm and add to stock*, and only for the accepted quantities. If the inventory service cannot confirm the posting right away, the receipt stays *Posting to stock* and **Retry posting** finishes it without ever adding the goods twice.
- `/goods-receipts` – **Goods Receipts**: every receipt, filterable by status, supplier and date, searchable by receipt, order or supplier reference. `/goods-receipts/<id>` shows one receipt with its lines and the stock movements it made.
- `/clients` – the client directory (register, search, edit, deactivate)
- `/movements` – the stock history, filterable by product and type (read-only: movements are permanent)
- Only an **active** `organization-admin` that belongs to an organization can sign in. Super Admins cannot.
- The session lives in an HttpOnly cookie named `impex_tenant_session` (never localStorage).

Tests: `docker build --target test -t impex-dashboard-test ./frontend/dashboard && docker run --rm impex-dashboard-test`

All inventory pages share one protected frame (`src/components/portal-frame.tsx`): the session is checked in the
layout, before the page streams, so a missing or invalid session is a real HTTP redirect to `/login`. Data is read
server-side with the HttpOnly cookie as the Bearer token; the browser never names an organization.

The browser talks only to this portal's own `/api/sales/*` routes (HttpOnly session cookie to Bearer token); it never names an
organization, never supplies product names, SKUs, units or stock, and sends quantities as exact strings.

- `/dispatches` – **Dispatches**: every dispatch, filterable by status, client and date, searchable by dispatch, list, tracking number or client; **New Dispatch** starts from a Ready delivery list. `/dispatches/<id>` shows one dispatch with its lines, the live stock of each product while it is a draft, and the stock movements it made.
- `/delivery-lists/<id>/dispatch` – **Prepare dispatch**: choose the products and quantities (typed by you; never filled in or incremented automatically), optionally locate a product of the list by typing, scanning or the phone camera (a product that is not on the list is refused), **review** the available stock, then explicitly **confirm**. Saving and reviewing only keep a draft; stock is deducted only on *Confirm and deduct from stock*. If the inventory service cannot confirm the posting right away, the dispatch stays *Posting to stock* and **Retry posting** finishes it without ever deducting the goods twice.
- `/delivery-lists/<id>` shows, once goods are dispatched, quantity progress per product (dispatched / in progress / remaining) and the dispatch history; the list can then be neither reopened nor cancelled.
- `/scan` has a fourth action, **Prepare Dispatch**: pick a Ready list, and the scanned product is put on that list's draft dispatch with a typed quantity (showing requested, already dispatched, remaining and the stock on hand). Scanning the same code again never raises the quantity.
- `/purchase-orders/<id>/receive` has **Use camera** beside manual entry, like the Scan page.

- `/invoices` – **Invoices**: every invoice, filterable by client, status, payment status (unpaid / partially paid / paid / overdue) and date, searchable by invoice number or client. **New Invoice** starts by choosing a client, then shows that client's **confirmed dispatch** lines with *dispatched / invoiced / in drafts / left to bill*. You type every quantity, **selling price** (independent of the catalog price, which is never read or changed), discount amount and tax rate; the line and invoice totals are previewed with exact integer arithmetic and calculated again by the server. Saving only keeps a **draft** (no number yet, nothing reserved).
- `/invoices/<id>` – one invoice: parties, dates, lines (with the dispatches they bill), exact totals (subtotal, discount, tax, total, paid, outstanding), the payment history, **Print** and **Download PDF**. A draft offers *Edit draft*, *Issue invoice* (asks first; gives the invoice its number and freezes it) and *Discard draft*. An issued invoice offers *Record a payment received* (full or partial, method, date, reference; never more than is due) and, while it has no payment on record, *Void invoice* (a reason is required). A payment is never edited or deleted: *Reverse* adds a reversal with a reason and both stay on record. An invoice with payments cannot be voided: reverse them first.
- `/clients/<id>` – a client's account: the outstanding balance **per currency** (nothing is converted or added across currencies), their invoices and recent payments. Reached from *Invoices* in the client list.
- A confirmed dispatch (`/dispatches/<id>`) offers **Create invoice** for its client. **Invoicing and payments never change stock.**
- The browser sends an `Idempotency-Key` with every invoice creation, payment and reversal (one per form, renewed after a refused request and kept after a lost connection), so a double click or a retry records it once.

Planned: returns and refunds, and a full transaction history.
