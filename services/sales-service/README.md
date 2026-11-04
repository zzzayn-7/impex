# Sales Service

FastAPI + PostgreSQL (`impex_sales`), port **8003**. Today it owns two things:

* the **Client Directory**: the companies an organization delivers to;
* **Delivery Lists**: products (with explicit quantities) promised to a client and waiting for delivery.

Orders, quotations, price lists, invoicing, payments and the **dispatch** workflow are intentionally not built yet.

Every endpoint is **tenant-scoped** (see [`docs/multi-tenancy.md`](../../docs/multi-tenancy.md)): only an active
`organization-admin` whose organization is active may use it, and every record belongs to the organization of the
authenticated administrator (never taken from the request).

## The one rule that matters: a delivery list never touches inventory

Adding a product to a list, editing or removing a line, saving a draft, marking a list **Ready**, **Cancelling** it or
reopening it never deducts, reserves or moves stock. There is no code path in this service that could:

* it has no stock tables (its database holds `clients`, `delivery_lists`, `delivery_list_items` and a numbering counter);
* its only client of the Inventory Service issues `GET` requests (a test asserts every request it makes is a `GET`);
* stock is shown for information ("available now") and a line asking for more than is available is only **flagged**;
  the portal states everywhere that *stock is not reserved and may change before dispatch*.

Dispatch, a later step, will re-check inventory and apply audited, idempotent stock-out operations through the Inventory Service.

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
| `POST /delivery-lists/{id}/ready` / `cancel` / `reopen` | Draft to Ready, Draft or Ready to Cancelled, Ready back to Draft. Cancelled is final |
| `POST /delivery-lists/{id}/items` | add a product: only `product_id`, `quantity` and an optional `planned_warehouse_id` |
| `PATCH /delivery-lists/{id}/items/{item_id}` | set the quantity (and/or planned warehouse) |
| `POST /delivery-lists/{id}/items/{item_id}/increase` | add an explicit amount to an existing line |
| `DELETE /delivery-lists/{id}/items/{item_id}` | remove a line |

Lists and clients are never deleted. Items can be changed only while the list is a **draft**.

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
```

The tests run the Auth, Organization and Inventory services as in-process fakes that scope data by the caller's token exactly like the
real ones, and the fake Inventory Service records every request it receives.
