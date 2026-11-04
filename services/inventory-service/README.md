# Inventory Service

FastAPI + PostgreSQL (`impex_inventory`), port **8002**. It provides the **Product Catalog**, **Warehouses**,
**Stock Management** (balances per product and warehouse, plus an append-only movement ledger) and **scannable
product codes** (QR / Code 128 labels, supplier barcodes, scan lookup; see [`docs/scanning.md`](../../docs/scanning.md)).
Purchasing, sales and invoicing are intentionally not built yet.

Every endpoint is **tenant-scoped**: only an active `organization-admin` whose organization is active may use it,
and every product belongs to the organization of the authenticated administrator (never taken from the request).
See [`docs/multi-tenancy.md`](../../docs/multi-tenancy.md).

## API (all under `/api/v1/inventory`, Bearer token required)

| Method & path | Purpose |
| :--- | :--- |
| `POST /products` | create a product |
| `GET /products?q=&category=&status=active\|archived\|all&limit=&offset=` | list / search / filter (paged) |
| `GET /products/{id}` | view one |
| `PATCH /products/{id}` | update (only the fields sent) |
| `POST /products/{id}/archive` / `restore` | archive (soft delete) / restore |
| `GET /categories` | the organization's own categories |
| `POST /warehouses` | create a warehouse (`code` unique per organization, upper-cased; optional `address`) |
| `GET /warehouses?q=&status=active\|archived\|all` | list / search (each shows `products_in_stock`) |
| `GET /warehouses/{id}` / `PATCH /warehouses/{id}` | view / edit code, name, address |
| `POST /warehouses/{id}/archive` / `restore` | archive / restore. **There is no delete**: a warehouse may hold stock and has history |
| `GET /stock?q=&category=&warehouse_id=&in_stock_only=&status=` | overview: per product the total and the quantity in each warehouse |
| `GET /stock/movements?product_id=&warehouse_id=&type=` | the ledger, newest first (read-only) |
| `POST /stock/opening` `/in` `/out` | opening balance / stock in / stock out of one product in one warehouse |
| `POST /stock/transfer` | move stock between two warehouses (one outgoing + one incoming movement, one transaction) |
| `POST /products/{id}/identifiers/generate` | give the product its Impex label code (QR + Code 128); repeating returns the same code |
| `GET /products/{id}/identifiers` | the product's codes (label code first) |
| `POST /products/{id}/identifiers` | register a manufacturer / supplier barcode (`kind`, `value`, optional `label`) |
| `POST /products/{id}/identifiers/{identifier_id}/retire` | retire a barcode (kept and reserved, never deleted) |
| `GET /products/{id}/label?identifier_id=` | name, SKU, code, QR SVG and Code 128 SVG for printing |
| `GET /scan/resolve?code=` | which product of **your** organization a scanned code means, with its stock. Read-only |
| `GET /health` | public |

Every `POST /stock/*` needs an **`Idempotency-Key`** header (8-100 characters of `A-Z a-z 0-9 . _ : -`). The first
request answers `201`; a retry with the same key and the same body answers `200` with `"replayed": true` and changes
nothing; the same key with a different body answers `409`. A request that fails (e.g. insufficient stock) does not use up its key.

A product has: SKU (unique per organization, stored upper-case), name, description, category, unit of
measurement, optional HS code, cost price and selling price (both `NUMERIC(14,4)`, exchanged as decimal strings,
never floats), ISO currency code, active flag and created/updated timestamps.
Interactive docs: http://localhost:8002/docs

### Scan lookup

`GET /scan/resolve?code=` finds a product by a registered code (Impex label or manufacturer/supplier barcode) and then by SKU, case-insensitively, inside the caller's organization only. Answers: `200` product + stock (archived products are returned with `is_active: false`), `404` unknown (identical for another organization's code), `410` retired barcode, `409` ambiguous (a barcode of one product is the SKU of another), `422` malformed or a web link (never fetched). It changes nothing.

### The unit of measurement is locked by stock history

`PATCH /products/{id}` refuses a different `unit` with `409` once the product has any stock movement, and a trigger on `products` refuses it even if the API is bypassed. While a stock change runs it holds a shared lock on the product, so a unit change cannot slip in between the unit check and the movement being written. Re-sending the current unit is fine. `ProductResponse.unit_locked` tells the portal.

### How stock stays correct

| Guarantee | Enforced by |
| :--- | :--- |
| a balance never goes negative | `CHECK (quantity >= 0)` **and** the balance row is locked (`SELECT ... FOR UPDATE`, in a fixed order, so opposite transfers cannot deadlock) while it is read and changed |
| every change is in the ledger | the movement row is written in the same transaction as the balance |
| the ledger is append-only | a PostgreSQL trigger rejects `UPDATE` and `DELETE` on `stock_movements`; the API has no such routes |
| a transfer is atomic | both balances and both movements commit together or not at all |
| a retry applies once | unique `(organization_id, idempotency_key)` on `stock_operations` + a fingerprint of the request |
| organizations never mix | every query is tenant-scoped, and composite foreign keys `(organization_id, id)` tie a balance/movement, its product and its warehouse to the **same** organization inside the database |
| exact quantities | `NUMERIC(18,4)`, JSON strings, never floats |
| pieces are whole | units that are not known measurable ones (`kg`, `g`, `l`, `ml`, `m`, `cm`, `tonne`, ...) accept whole numbers only; the service reports it as `unit_allows_fractions` |
| history is kept | a warehouse is archived, never deleted; archived warehouses and products refuse new stock changes but keep their stock and history |

Movement types: `opening`, `in`, `out`, `transfer_out`, `transfer_in`. Each records product, warehouse, quantity, the
balance afterwards, a reason, the authenticated user (id and email) and the time. An opening balance is only possible
before any other movement of that product in that warehouse; later corrections are ordinary stock in/out movements.

> Maintenance only: deleting ledger rows is possible solely inside a transaction that sets
> `app.allow_ledger_maintenance = 'on'` (the verification scripts use it to remove their own throwaway data by exact id).
> The application never sets it.

## Database setup (never resets existing data)

```powershell
# 1. create the database ONCE on an existing Postgres volume (safe to repeat; fresh installs get it automatically)
Get-Content database/add-inventory-database.sql | docker exec -i impex-postgres sh -c 'psql -U $POSTGRES_USER -d postgres'
# 2. create / upgrade the tables (additive; 0002 adds warehouses and stock, 0003 adds product codes and the unit lock;
#    existing products, warehouses, balances and movements are untouched)
docker compose run --rm --no-deps inventory-service alembic upgrade head
# 3. start the service
docker compose up -d inventory-service
```

## Tests

```powershell
docker compose run --rm --no-deps inventory-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -v"
python scripts/verify_product_isolation.py        # live end-to-end check of the catalog through the Organization Portal
python scripts/verify_stock_management.py         # live end-to-end check of warehouses, stock, movements and isolation
python scripts/verify_scanning.py                 # live end-to-end check of codes, labels, scan lookup and the unit lock
```

The tests include simultaneous removals against a stock that fits only three (never overdrawn), duplicate requests with
one key, opposite transfers at the same time (no deadlock, nothing lost), a transfer that fails half-way (nothing
remains), and two-organization isolation for warehouses, balances and movements, including the database-level refusals.
