# Sales Service

FastAPI + PostgreSQL (`impex_sales`), port **8003**. It owns three things:

* the **Client Directory**: the companies an organization delivers to;
* **Delivery Lists**: products (with explicit quantities) promised to a client and waiting for delivery;
* **Dispatches** (Step 17A): goods that actually leave for a client against a delivery list, in full or in parts, and the hand-over of
  the dispatched quantities to the Inventory Service, which deducts them.

* **Sales Invoices and client payments** (Step 17B): bill the goods that were dispatched, and record the payments received for them.

Orders, quotations, price lists, returns, refunds, a general ledger, bank or card integrations, exchange-rate accounting and statutory tax filing are intentionally not built.

Every endpoint is **tenant-scoped** (see [`docs/multi-tenancy.md`](../../docs/multi-tenancy.md)): only an active
`organization-admin` whose organization is active may use it, and every record belongs to the organization of the
authenticated administrator (never taken from the request).

## The one rule that matters: only a CONFIRMED dispatch touches inventory

Adding a product to a list, editing or removing a line, saving a draft, marking a list **Ready**, **Cancelling** it or reopening it
never deducts, reserves or moves stock. Neither does preparing, saving, reviewing, scanning or locating a dispatch. Stock is
deducted in exactly one situation: a dispatch is **confirmed**, and then only the quantities on its lines are deducted, through the
Inventory Service's own audited, idempotent operation:

* the service has no stock tables (its database holds clients, delivery lists and items, dispatches and their lines, numbering counters and idempotency records);
* its only write to the Inventory Service is `POST /api/v1/inventory/dispatches`, made when a dispatch is confirmed (tests assert that nothing else ever writes);
* the posting carries no price, so a catalog price can never be touched;
* stock is shown for information ("available now") and a line asking for more than is available is only **flagged** on a draft;
  the portal states everywhere that *stock is not reserved by a list and may change before dispatch*.

## API (all under `/api/v1/sales`, Bearer token required)

| Method & path | Purpose |
| :--- | :--- |
| `POST /clients` | register a client (name unique per organization, ignoring case and spacing) |
| `GET /clients?q=&status=active\|inactive\|all` | list / search (name, contact, e-mail, phone) |
| `GET /clients/{id}` / `PATCH /clients/{id}` | view / edit |
| `POST /clients/{id}/deactivate` / `activate` | deactivate (never deleted) / reactivate |
| `POST /delivery-lists` | start a **draft** list for a client (`client_id`, optional `external_reference`, `notes`); the number `DL-000001`, ... is assigned here |
| `GET /delivery-lists?client_id=&status=&q=` | list / filter / search (number, reference, client name) |
| `GET /delivery-lists/{id}` | the list, its items and the **live** stock of each product |
| `PATCH /delivery-lists/{id}` | edit reference / notes (draft only) |
| `POST /delivery-lists/{id}/ready` / `cancel` / `reopen` | Draft to Ready, Draft or Ready to Cancelled, Ready back to Draft. Cancelled is final. Once goods are dispatched (or being dispatched) a list can be neither reopened nor cancelled |
| `POST /delivery-lists/{id}/items` | add a product: only `product_id`, `quantity` and an optional `planned_warehouse_id` |
| `PATCH /delivery-lists/{id}/items/{item_id}` | set the quantity (and/or planned warehouse) |
| `POST /delivery-lists/{id}/items/{item_id}/increase` | add an explicit amount to an existing line |
| `DELETE /delivery-lists/{id}/items/{item_id}` | remove a line |

Lists and clients are never deleted. Items can be changed only while the list is a **draft** (the database enforces it, and an item can never be moved to another list).

## Dispatches (Step 17A)

| Method & path | Purpose |
| :--- | :--- |
| `POST /dispatches` | start a **draft** dispatch against a Ready / Partially Dispatched list, optionally with its lines. **Requires an `Idempotency-Key`.** `201`, or `200` for a retry |
| `GET /dispatches?delivery_list_id=&client_id=&status=&warehouse_id=&product_id=&q=&date_from=&date_to=` | list / filter / search |
| `GET /dispatches/{id}` | the dispatch, its lines (requested / dispatched elsewhere / dispatchable, and the LIVE stock of each warehouse while it is a draft) and posting bookkeeping |
| `PATCH /dispatches/{id}` | edit the date, delivery address, transport details, tracking reference or notes (draft only) |
| `PUT /dispatches/{id}/lines` | replace the draft's lines: per line a delivery-list item, a **warehouse** and a **quantity**; one item may leave from several warehouses |
| `POST /dispatches/{id}/confirm` | deduct the quantities from stock. `200` confirmed (also if it already was); `202` the posting could not be verified yet - call it again; `409` (`insufficient_stock` / `inventory_rejected` / `over_dispatch`) nothing was deducted and the draft is intact |
| `POST /dispatches/{id}/cancel` | discard a draft (kept for history) |

A delivery list is now **Draft, Ready, Partially Dispatched, Dispatched** or **Cancelled**. The last two states of a dispatching list are
reached only by confirming dispatches: *Partially Dispatched* when some goods have left, *Dispatched* when every item is fully covered by
confirmed dispatches (the database checks that claim). A dispatch is **Draft, Posting, Confirmed** or **Cancelled**.

**Quantities per item:** *requested*, *dispatched* (confirmed dispatches only), *pending* (dispatches being posted, which are reserved) and
*remaining* = requested - dispatched - pending. More than the remaining quantity cannot be dispatched, even by two administrators at the same
moment: the check runs under a lock on the delivery list, and a database trigger repeats it when a dispatch starts posting. A draft reserves nothing.

### How confirming survives crashes, timeouts and outages

1. **The intent is saved first** (short transaction): `draft -> posting`, with an attempt counter. From that moment the dispatch is frozen and its quantities are reserved.
2. **No database transaction is open while the Inventory Service is called.** The call carries the **stable `Idempotency-Key` `dispatch-<dispatch id>`** (a check constraint ties the key to the id),
   the caller's own token and all lines at once. The Inventory Service deducts them in one transaction, once per key, never below zero, and also refuses a dispatch line it has already posted under any other key.
3. **Only a verified answer confirms.** The answer must name this dispatch, one movement per line, each for the right product, warehouse and quantity. Then, in one short transaction, the movement ids are stored on the lines, the dispatch becomes
   `confirmed` and the list `Partially Dispatched` / `Dispatched`. The database refuses to confirm a dispatch whose lines lack their movement.
4. **When the outcome is unknown** (timeout, connection lost, 5xx, an answer that does not match) the dispatch stays `posting` and `confirm` answers `202`. Before giving up, the service asks the Inventory Service whether the posting happened
   (`GET /dispatches/by-key/{key}`) and finishes the job if it did. Calling `confirm` again - from any process, after any restart - repeats the posting with the same key; the Inventory Service replays the first result.
5. **A definitive refusal** (not enough stock, an archived product or warehouse, a changed unit...) is confirmed with the same status lookup, then the dispatch returns to `draft` with the reason, and nothing was deducted.
   Stock is also checked against the live warehouse quantities *before* anything is reserved, so an obvious shortage is explained at once.

There is no background worker: recovery is the retry of `confirm`, which needs an administrator's token. A dispatch left in `posting` is listed with a *Retry posting* button.

### Products come from the Inventory Service, never from the browser

* A request carries only the product's **id** and the wanted **quantity**. Name, SKU, unit, active status and stock are
  read from the Inventory Service (`GET /api/v1/inventory/stock/summary`) every time they matter: adding or changing a
  line, showing the list, marking it Ready. Extra fields (`product_name`, `unit`, `available_quantity`, `organization_id`, ...) are refused with 422.
* The Inventory Service is called with the **caller's own bearer token**, so it applies its own tenant isolation. A product
  that does not exist and a product of another organization both come back as plain `404 Product not found.`
* Name, SKU and unit are saved on the line as **snapshots** (for display and later history). The live stock is never stored.
* Archived products cannot be added or have their quantity raised; Ready is refused while a line's product is archived or missing.
* Quantities are exact decimals (`NUMERIC(18,4)`, strings in JSON). Whole numbers only for units that are not measurable
  (pieces, boxes, ...), as decided by the Inventory Service (`unit_allows_fractions`).
* If the Inventory Service is down: adding or readying answers `503` with a clear message; **viewing** a list still works
  (our own data) with `stock_status: "unavailable"`.

### Duplicates are never merged silently

A product appears at most once per list (database `UNIQUE (organization_id, delivery_list_id, product_id)`). Adding it again
answers `409` with `code: "duplicate_item"` and the existing line (`{id, quantity, unit}`); nothing changes. The caller then
chooses explicitly: *set* the quantity (`PATCH`), *increase* it (`POST .../increase`), or leave it. Scanning the same label ten
times adds nothing.

### Other rules

* **Clients:** a list needs an **active** client of the same organization (database composite foreign key
  `(organization_id, client_id)`). An inactive client keeps its lists (viewable, cancellable, items removable) but gets no new
  lists, no new products and cannot have a list marked Ready.
* **Numbers:** per organization, from an atomically incremented counter, plus `UNIQUE (organization_id, number)`.
* **Ready** needs at least one line, an active client and available products. A shortage is only a warning.

## Invoices and payments (Step 17B)

Invoicing **never touches inventory**. The invoicing code does not import the Inventory client, makes no request to the Inventory Service
(the tests prove it: with the Inventory Service down invoices are still created, issued and paid, and the fake records no request) and
writes no stock movement. It bills goods that were **already dispatched**: every invoice line points at a line of a **confirmed** dispatch.

| Method & path | Purpose |
| :--- | :--- |
| `GET /billable-lines?client_id=&delivery_list_id=` | the confirmed dispatch lines of one client with *dispatched*, *invoiced* (issued invoices), *in drafts* (information only) and *remaining* |
| `POST /invoices` | start a **draft** for a client and a currency, optionally with its lines. **Requires an `Idempotency-Key`.** `201`, or `200` for a retry |
| `GET /invoices?client_id=&status=&payment_status=unpaid\|partial\|paid\|overdue&q=&date_from=&date_to=` | list / filter / search (number, client, notes) |
| `GET /invoices/{id}` | the invoice, its lines (with the dispatches they bill), its payments and what may be done to it |
| `GET /invoices/{id}/pdf` | the invoice as a PDF (built from the saved invoice) |
| `PATCH /invoices/{id}` / `PUT /invoices/{id}/lines` | edit the dates and note / replace the lines (**drafts only**) |
| `POST /invoices/{id}/issue` | give the draft its number and freeze it (repeating it changes nothing) |
| `POST /invoices/{id}/void` | `{reason}`: discard a draft, or void an issued invoice that has **no** payment on record |
| `POST /invoices/{id}/payments` | record a payment received (**`Idempotency-Key` required**) |
| `POST /invoices/{id}/payments/{payment_id}/reverse` | correct a payment by recording its **reversal** with a reason (**`Idempotency-Key` required**) |
| `GET /clients/{id}/account` | a client's invoices, recent payments and the outstanding balance **per currency** |

### Lifecycle

`Draft -> Issued -> Partially Paid -> Paid`, and `Void`. Only the documented moves exist, enforced twice: by the API and by a database trigger
that works even for a hand-written `UPDATE`.

* **Draft:** editable, has **no number**, reserves nothing (two drafts may bill the same goods; whichever is issued first wins, the other is
  refused at issue time with `409 over_invoiced`). A draft can be discarded by voiding it.
* **Issued:** gets the next number (`INV-000001`, ... per organization) **at that moment**, inside the issuing transaction, so numbers of issued
  invoices have no gaps and a refused issue consumes none. Its commercial details (client, dates, currency, notes, every line, every total, the
  seller / bill-to snapshots) are **frozen**: the database refuses to change them. An invoice is never deleted.
* **Payment status** is derived, not typed: the database keeps `paid_total` and the status equal to the sum of the payment records
  (*Issued* when nothing is paid, *Partially Paid*, *Paid* when the payments reach the total). Nobody can set them by hand.
* **Void:** an invoice stays on record, marked void, with who / when / why; its number is never reused and the quantity it billed can be billed again.

### The adjustment policy: voiding vs correcting an invoice that has payments

* **Voiding an unpaid invoice** is allowed (an issued one needs a reason).
* **An invoice with payments on record can never be voided** (`409 has_payments`): that would destroy the payment history. To cancel it,
  *reverse* its payments first - each reversal is its own permanent record - and then void it and issue a corrected invoice.
* **Payments are append-only.** A payment is never edited or deleted (the database refuses both). A mistake is corrected by a **reversal**: a new
  record of the same amount with a mandatory reason, linked to the payment it undoes. A payment is reversed once; a reversal cannot be reversed.
  Both rows stay on the invoice, the original is flagged *reversed*, and the balance goes back up.

### Not billed twice

An `invoice_allocation` links an invoice line to the confirmed dispatch line it bills. Issuing an invoice locks the dispatch lines (in a fixed
order) and checks that the quantity covered by **issued** invoices never exceeds what was dispatched - in the application *and* again in a database
trigger, so two administrators issuing at the same moment cannot both win. Partial invoicing (6 of 10, then the other 4), one invoice over several
dispatches of a list, and several invoices per client all work. A dispatch of another client, of another organization, or one that is not
confirmed cannot be billed (the database checks that too).

### Money is exact

`NUMERIC(18,4)` everywhere, strings in JSON, never floats. Per line: `subtotal = round(quantity x price)`, `net = subtotal - discount`,
`tax = round(net x rate / 100)`, `total = net + tax`; halves round **up**. The same formulas are written as `CHECK` constraints, so even a
hand-written row cannot hold wrong arithmetic, and the browser previews them with exact integer arithmetic (`BigInt`).
The invoice total is the sum of its lines; the **backend always calculates it**.

* The **selling price is typed by the administrator** for each line. The catalog price is neither read nor changed.
* **One currency per invoice**, a real ISO 4217 code (`USD`, `EUR`, `PKR`, ...). Nothing is converted. A payment is in the invoice's currency, and a client's balance is reported **per currency**.
* **Discounts** are an amount per line (never more than the line). **Taxes** are an explicit percentage and a name the administrator enters per line.
  No country's tax rules are built in and the invoice does not claim to satisfy any: the invoice and the PDF carry a notice saying so.

### Payments

Recorded by hand (cash, bank transfer, cheque, card, mobile wallet, other); no bank, gateway or card network is contacted. A payment needs an
`Idempotency-Key` (a double click or a retry answers `200` with the same invoice and records nothing twice; the same key with a different body is `409`).
It can never exceed the **outstanding amount** (`409 overpayment`): no credit balance is held, because no credit policy exists. Payments are refused for
drafts and void invoices. A payment for an **inactive client's** issued invoice is still recorded (money that arrived is money that arrived); a new invoice for
an inactive client is not created or issued. Payments of the same invoice are serialized by a row lock, and the database repeats the limit check.

### Tenancy

Every invoice, line, allocation and payment carries the `organization_id` of the authenticated administrator (never taken from the request), with composite
foreign keys `(organization_id, id)`; another organization's invoice, payment, client or dispatch line is an indistinguishable `404`.

## Database setup (never resets existing data)

```powershell
# 1. create the database ONCE on an existing Postgres volume (safe to repeat; fresh installs get it automatically)
Get-Content database/add-sales-database.sql | docker exec -i impex-postgres sh -c 'psql -U $POSTGRES_USER -d postgres'
# 2. create the tables
docker compose run --rm --no-deps sales-service alembic upgrade head
# 3. start the service
docker compose up -d sales-service
```

## Tests

```powershell
docker compose run --rm --no-deps sales-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -v"
python scripts/verify_delivery_lists.py                 # live end-to-end check through the Organization Portal
python scripts/verify_delivery_lists.py --with-outage   # also stops the Inventory and Sales services briefly
python scripts/verify_dispatch.py                       # live check of dispatching: partial dispatches, stock accuracy, idempotency, isolation
python scripts/verify_dispatch.py --with-outage         # also interrupts confirmation between the two services
python scripts/verify_invoicing.py                      # live check of invoicing and payments: exact money, partial invoicing, payments, reversals, isolation, stock untouched
python scripts/verify_invoicing.py --with-outage        # also proves invoicing keeps working while the Inventory Service is down
```

Migration `0003` (additive: six `invoice_*` tables, their triggers and one unique constraint on `dispatch_lines`) creates the invoicing tables:
`docker compose run --rm --no-deps sales-service alembic upgrade head`. The service now depends on `reportlab` (PDF), so rebuild the image
(`docker compose build sales-service`) first.

The Inventory Service needs its own additive migration (`0006`: a `dispatch` operation kind and a `client_dispatch` movement source) before goods can be dispatched:
`docker compose run --rm --no-deps inventory-service alembic upgrade head`, then `docker compose run --rm --no-deps sales-service alembic upgrade head` (additive migration `0002`).

The tests run the Auth, Organization and Inventory services as in-process fakes that scope data by the caller's token exactly like the
real ones. The fake Inventory Service records every request, deducts goods atomically and idempotently like the real one (never below zero), and can be told to fail
in specific ways (lose the answer after committing, time out before receiving, answer 500, refuse, answer wrongly) so every interruption between the two services is tested.
