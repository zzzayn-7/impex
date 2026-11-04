# Purchasing Service

FastAPI + PostgreSQL (`impex_purchasing`), port **8004**. It owns two things:

* the **Supplier Directory**: the companies an organization buys from;
* **Purchase Orders**: what has been ordered from a supplier, with product lines, quantities, purchase prices and exact totals.

**Goods receiving** (Step 16B), invoices, payments and accounting are intentionally not built yet.

Every endpoint is **tenant-scoped** (see [`docs/multi-tenancy.md`](../../docs/multi-tenancy.md)): only an active
`organization-admin` whose organization is active may use it, and every record belongs to the organization of the
authenticated administrator (never taken from the request).

## The one rule that matters: a purchase order never touches inventory

Creating, editing, placing (**Ordered**) or cancelling an order never adds stock, never writes a stock movement and never changes a
product's selling or cost price. An order for 50 units leaves the stock at what it was. There is no code path that could:

* the service has no stock tables (its database holds `suppliers`, `purchase_orders`, `purchase_order_lines`, a numbering counter and idempotency records);
* its only client of the Inventory Service issues `GET` requests (a test asserts that every request it makes is a `GET`);
* a purchase price lives only on the order line. It is not written to the product.

Stock is added only when goods are **received** (Step 16B), through the Inventory Service's own audited, idempotent stock-in.

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
| `POST /purchase-orders/{id}/cancel` | Draft or Ordered to **Cancelled** (kept for history) |
| `POST /purchase-orders/{id}/lines` | add an existing product: only `product_id`, `quantity`, `unit_price`, optional `planned_warehouse_id` and `notes` |
| `PATCH /purchase-orders/{id}/lines/{line_id}` | change quantity / price / planned warehouse / note (the total is recalculated here) |
| `DELETE /purchase-orders/{id}/lines/{line_id}` | remove a line from a draft |

### Life cycle

`Draft` to `Ordered` to (nothing); `Draft` or `Ordered` to `Cancelled`; `Cancelled` is final. A Draft can be edited freely.
When an order is **placed** its commercial details are frozen **by the database itself**, not just by the API: a trigger refuses any
later change to the supplier, order number, dates, currency, supplier reference, notes, and refuses to insert, change or delete a
line. Orders are never deleted. Placing an order needs at least one line, an **active** supplier, and every product still active; the
product names, SKUs and units on the lines are refreshed from the Inventory Service at that moment and frozen with the order.
Cancelling needs no product facts (it works even while the Inventory Service is down).

### Money is exact and calculated on the server

* Quantities and prices are `NUMERIC(18,4)` (at most 14 digits before and 4 after the point), sent as strings, never floats. A price of `0` is allowed.
* `line_total = round(quantity x unit_price, 4)`, rounded **half up**; the order total is the **sum of the line totals**. Both are calculated here
  (the portal's live preview is only a convenience, and the response is what is saved and shown). The database re-checks every line with
  `CHECK (line_total = round(quantity * unit_price, 4))`.
* A line total that would not fit the column is refused cleanly (`422`).
* The order currency is chosen when it is created and cannot change once it has lines.

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
# 2. create the tables
docker compose run --rm --no-deps purchasing-service alembic upgrade head
# 3. start the service
docker compose up -d purchasing-service
```

## Tests

```powershell
docker compose run --rm --no-deps purchasing-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -v"
python scripts/verify_purchasing.py                 # live end-to-end check through the Organization Portal
python scripts/verify_purchasing.py --with-outage   # also stops the Inventory and Purchasing services briefly
```

The tests run the Auth, Organization and Inventory services as in-process fakes that scope data by the caller's token exactly like the
real ones, and the fake Inventory Service records every request it receives.
