# Sales Service

FastAPI + PostgreSQL (`impex_sales`), port **8003**. It owns three things:

* the **Client Directory**: the companies an organization delivers to;
* **Delivery Lists**: products (with explicit quantities) promised to a client and waiting for delivery;
* **Dispatches** (Step 17A): goods that actually leave for a client against a delivery list, in full or in parts, and the hand-over of
  the dispatched quantities to the Inventory Service, which deducts them.

Orders, quotations, price lists, customer invoices, payments, returns and refunds are intentionally not built yet.

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
```

The Inventory Service needs its own additive migration (`0006`: a `dispatch` operation kind and a `client_dispatch` movement source) before goods can be dispatched:
`docker compose run --rm --no-deps inventory-service alembic upgrade head`, then `docker compose run --rm --no-deps sales-service alembic upgrade head` (additive migration `0002`).

The tests run the Auth, Organization and Inventory services as in-process fakes that scope data by the caller's token exactly like the
real ones. The fake Inventory Service records every request, deducts goods atomically and idempotently like the real one (never below zero), and can be told to fail
in specific ways (lose the answer after committing, time out before receiving, answer 500, refuse, answer wrongly) so every interruption between the two services is tested.
