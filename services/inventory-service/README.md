# Inventory Service

FastAPI + PostgreSQL (`impex_inventory`), port **8002**. Today it provides the **Product Catalog**; stock levels,
warehouses, purchases and sales are intentionally not built yet.

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
| `GET /health` | public |

A product has: SKU (unique per organization, stored upper-case), name, description, category, unit of
measurement, optional HS code, cost price and selling price (both `NUMERIC(14,4)`, exchanged as decimal strings,
never floats), ISO currency code, active flag and created/updated timestamps.
Interactive docs: http://localhost:8002/docs

## Database setup (never resets existing data)

```powershell
# 1. create the database ONCE on an existing Postgres volume (safe to repeat; fresh installs get it automatically)
Get-Content database/add-inventory-database.sql | docker exec -i impex-postgres sh -c 'psql -U $POSTGRES_USER -d postgres'
# 2. create the tables
docker compose run --rm --no-deps inventory-service alembic upgrade head
# 3. start the service
docker compose up -d inventory-service
```

## Tests

```powershell
docker compose run --rm --no-deps inventory-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -v"
python scripts/verify_product_isolation.py        # live end-to-end check through the Organization Portal
```
