# Purchasing Service

FastAPI + PostgreSQL (`impex_purchasing`), port **8004**. It owns three things:

* the **Supplier Directory**: the companies an organization buys from;
* **Purchase Orders**: what has been ordered from a supplier, with product lines, quantities, purchase prices and exact totals;
* **Goods Receipts** (Step 16B): what actually arrived against an order, in full or in parts, and the hand-over of the accepted goods to the Inventory Service.

Supplier payments, invoices, customer dispatch and accounting are intentionally not built yet.

Every endpoint is **tenant-scoped** (see [`docs/multi-tenancy.md`](../../docs/multi-tenancy.md)): only an active
`organization-admin` whose organization is active may use it, and every record belongs to the organization of the
authenticated administrator (never taken from the request).

## The one rule that matters: only a CONFIRMED goods receipt touches inventory

Creating, editing, placing (**Ordered**) or cancelling a purchase order never adds stock, never writes a stock movement and never changes
a product's selling or cost price. An order for 50 units leaves the stock at what it was. Neither does preparing, scanning, reviewing or saving
a goods receipt. Stock is added in exactly one situation: a goods receipt is **confirmed**, and then only the **accepted** quantities are added,
through the Inventory Service's own audited, idempotent operation:

* the service has no stock tables (its database holds suppliers, purchase orders and lines, goods receipts and lines, numbering counters and idempotency records);
* its only write to the Inventory Service is `POST /api/v1/inventory/goods-receipts`, made when a receipt is confirmed (tests assert that nothing else ever writes);
* a purchase price lives only on the order line; the posting carries no price at all, so a catalog price can never be overwritten;
* a rejected quantity is recorded on the receipt and is never sent to stock.

## API (all under `/api/v1/purchasing`, Bearer token required)

| Method & path | Purpose |
| :--- | :--- |
| `POST /suppliers` | register a supplier (name unique per organization ignoring case/spacing; optional code unique per organization; country as ISO 2-letter code; optional tax id) |
| `GET /suppliers?q=&status=active\|inactive\|all` | list / search (name, code, contact, e-mail, phone, tax id) |
| `GET /suppliers/{id}` / `PATCH /suppliers/{id}` | view / edit |
| `POST /suppliers/{id}/deactivate` / `activate` | deactivate (never deleted) / reactivate |
| `POST /purchase-orders` | start a **draft** order. **Requires an `Idempotency-Key` header.** `201` the first time, `200` with the same order on a retry |
| `GET /purchase-orders?supplier_id=&status=&q=&date_from=&date_to=` | list / filter / search (number, supplier reference, supplier name) |
| `GET /purchase-orders/{id}` | the order, its lines and the **calculated** total |
| `PATCH /purchase-orders/{id}` | edit the header (draft only) |
| `POST /purchase-orders/{id}/order` | place the order: Draft to **Ordered** (freezes it) |
| `POST /purchase-orders/{id}/cancel` | Draft or Ordered (with nothing received) to **Cancelled** (kept for history; its draft receipts are cancelled with it) |
| `POST /purchase-orders/{id}/lines` | add an existing product: only `product_id`, `quantity`, `unit_price`, optional `planned_warehouse_id` and `notes` |
| `PATCH /purchase-orders/{id}/lines/{line_id}` | change quantity / price / planned warehouse / note (the total is recalculated here) |
| `DELETE /purchase-orders/{id}/lines/{line_id}` | remove a line from a draft |

### Life cycle

`Draft` to `Ordered` to `Partially Received` to `Received`; `Draft` or `Ordered` to `Cancelled`; `Received` and `Cancelled` are final. A Draft can be edited freely.
**Partially Received** and **Received** are reached only by confirming goods receipts: an order is Received when every line is fully received, Partially Received when some goods have arrived. The
database checks that claim against the confirmed receipts. An order that has goods received (or being received) can **never be cancelled**: the cancellation would hide that the goods arrived.
When an order is **placed** its commercial details are frozen **by the database itself**, not just by the API: a trigger refuses any
later change to the supplier, order number, dates, currency, supplier reference, notes, and refuses to insert, change or delete a
line. Orders are never deleted. Placing an order needs at least one line, an **active** supplier, and every product still active; the
product names, SKUs and units on the lines are refreshed from the Inventory Service at that moment and frozen with the order.
Cancelling needs no product facts (it works even while the Inventory Service is down). A line belongs to one order of one organization for its whole life: a database trigger refuses any
change of a line's `id`, `organization_id` or `purchase_order_id`, so a line of a placed order cannot be re-pointed at a draft (or the reverse) to slip past the freeze.

### Money is exact and calculated on the server

* Quantities and prices are `NUMERIC(18,4)` (at most 14 digits before and 4 after the point), sent as strings, never floats. A price of `0` is allowed.
* `line_total = round(quantity x unit_price, 4)`, rounded **half up**; the order total is the **sum of the line totals**. Both are calculated here
  (the portal's live preview is only a convenience, and the response is what is saved and shown). The database re-checks every line with
  `CHECK (line_total = round(quantity * unit_price, 4))`.
* A line total that would not fit the column is refused cleanly (`422`).
* The order currency is chosen when it is created and cannot change once it has lines.

## Goods receiving

| Method & path | Purpose |
| :--- | :--- |
| `POST /goods-receipts` | start a **draft** receipt against an Ordered / Partially Received order, optionally with its lines. **Requires an `Idempotency-Key`.** `201`, or `200` for a retry |
| `GET /goods-receipts?purchase_order_id=&supplier_id=&status=&warehouse_id=&product_id=&q=&date_from=&date_to=` | list / filter / search |
| `GET /goods-receipts/{id}` | the receipt, its lines (ordered / received elsewhere / receivable), posting bookkeeping and stock movements |
| `PATCH /goods-receipts/{id}` | edit the date, the supplier's reference or the notes (draft only) |
| `PUT /goods-receipts/{id}/lines` | replace the draft's lines: per order line the **accepted** quantity, an optional **rejected** quantity, the **warehouse**, a note |
| `POST /goods-receipts/{id}/confirm` | add the accepted quantities to stock. `200` confirmed (also if it already was); `202` the posting could not be verified yet - call it again |
| `POST /goods-receipts/{id}/cancel` | discard a draft (kept for history) |

**Quantities per order line:** *ordered*, *received* (confirmed receipts only), *pending* (receipts being posted, which are reserved) and *remaining* = ordered - received - pending. More than the remaining quantity
cannot be received, even by two people at the same moment: the check runs under a lock on the order, and a database trigger repeats it when a receipt starts posting. A draft reserves nothing.

**Status of a receipt:** `draft` (editable, changes no stock) - `posting` (the intent is saved, the quantities are reserved, the receipt is frozen) - `confirmed` (the Inventory Service's answer was verified; immutable and never deleted),
or `cancelled`. A `posting` receipt returns to `draft` only after the Inventory Service definitively refused it (nothing was added).

### How confirming survives crashes, timeouts and outages

1. **The intent is saved first** (short transaction): `draft -> posting`, with an attempt counter. From that moment the receipt is frozen and its quantities are reserved.
2. **No database transaction is open while the Inventory Service is called.** The call carries the **stable `Idempotency-Key` `goods-receipt-<receipt id>`** (a check constraint ties the key to the id), the caller's own token and all accepted lines at once.
   The Inventory Service posts them in one transaction, once per key, and also refuses a receipt line it has already posted under any other key.
3. **Only a verified answer confirms.** The answer must name this receipt, one movement per accepted line, each for the right product, warehouse and quantity. Then, in one short transaction, the movement ids are stored on the lines,
   the receipt becomes `confirmed` and the order `Partially Received` / `Received`. The database refuses to confirm a receipt whose accepted lines lack their movement.
4. **When the outcome is unknown** (timeout, connection lost, 5xx, an answer that does not match) the receipt stays `posting` and `confirm` answers `202`. Before giving up, the service asks the Inventory Service whether the posting happened
   (`GET /goods-receipts/by-key/{key}`) and finishes the job if it did. Calling `confirm` again - from any process, after any restart - repeats the posting with the same key; the Inventory Service replays the first result, so the goods are never added twice.
5. **A definitive refusal** (archived product, a unit that changed, an unknown warehouse...) is confirmed with the same status lookup, then the receipt returns to `draft` with the reason, and nothing was added.

There is no background worker: recovery is the retry of `confirm`, which needs an administrator's token (the Inventory Service is always asked as the person who uses the portal). A receipt left in `posting` is listed with a *Retry posting* button.

Also enforced here: the unit of a receipt line is the order line's unit and is never converted (the Inventory Service refuses a product whose unit changed since the order was placed); whole units take whole numbers; archived products and warehouses are refused
(when saving, and again by the Inventory Service); goods are received only against Ordered / Partially Received orders. A rejected quantity is informational.

### Products come from the Inventory Service, never from the browser

* A request carries only the product's **id**. Name, SKU, unit and active status are read from the Inventory Service
  (`GET /api/v1/inventory/stock/summary`) with the **caller's own bearer token**, so the Inventory Service applies its own tenant isolation. A
  product of another organization is `404 Product not found.`, byte for byte the answer for an id that does not exist. Extra fields
  (`product_name`, `unit`, `line_total`, `selling_price`, `organization_id`, ...) are refused with 422.
* No product records are created or copied: a line points at the existing product (and keeps display snapshots).
* Whole numbers only for units that are not measurable (pieces, boxes, ...), as decided by the Inventory Service.
* One line per product per order (database `UNIQUE`); adding it again answers `409 duplicate_line` with the existing line.
* A planned warehouse is optional and validated against the Inventory Service (must be the caller's and active).

### Reliability

* **Duplicate submissions:** the create endpoint claims its `Idempotency-Key` (`UNIQUE (organization_id, idempotency_key)`) inside the same
  transaction that creates the order. A double click or retry returns the first order; the same key with a different body is `409`; a request that fails does
  not use up its key. Six simultaneous submissions of one form create one order.
* **Numbers:** `PO-000001`, `PO-000002`, ... per organization from an atomically incremented counter in the creating transaction, plus `UNIQUE (organization_id, number)`:
  no duplicates under concurrency and no gaps from failed creations.
* **Concurrency:** every change to an order or its lines first takes a row lock on the order, so placing it and editing a line at the same moment cannot interleave.
* **Outages:** adding a line or placing an order answers `503` with a clear message if the Inventory Service is down; viewing an order never needs it (the order keeps its own snapshots).

## Database setup (never resets existing data)

```powershell
# 1. create the database ONCE on an existing Postgres volume (safe to repeat; fresh installs get it automatically)
Get-Content database/add-purchasing-database.sql | docker exec -i impex-postgres sh -c 'psql -U $POSTGRES_USER -d postgres'
# 2. create / upgrade the tables (additive: migration 0002 adds goods receipts and keeps every existing order exactly as it is)
docker compose run --rm --no-deps purchasing-service alembic upgrade head
# 3. start the service
docker compose up -d purchasing-service
```

The Inventory Service needs its own additive migration (`0005`: a `receipt` operation kind and a source reference on stock movements) - `docker compose run --rm --no-deps inventory-service alembic upgrade head` - before goods can be confirmed.

## Tests

```powershell
docker compose run --rm --no-deps purchasing-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -v"
python scripts/verify_purchasing.py                 # live end-to-end check through the Organization Portal
python scripts/verify_purchasing.py --with-outage   # also stops the Inventory and Purchasing services briefly
python scripts/verify_goods_receiving.py            # live check of receiving: partial receipts, stock accuracy, idempotency, isolation
python scripts/verify_goods_receiving.py --with-outage   # also interrupts confirmation between the two services
```

The tests run the Auth, Organization and Inventory services as in-process fakes that scope data by the caller's token exactly like the
real ones. The fake Inventory Service records every request, posts goods atomically and idempotently like the real one, and can be told to fail in specific ways
(lose the answer after committing, time out before receiving, answer 500, refuse, answer wrongly) so every interruption between the two services is tested.
