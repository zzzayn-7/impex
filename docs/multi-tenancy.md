# Multi-tenancy: how Impex keeps organizations apart

Every organization (tenant) must be completely invisible to every other organization. This document is the
contract for **every service that stores organization-owned data** (Inventory, Sales, Finance, ...). The
Organization Service and the Inventory Service follow it; their code is the reference implementation:

| File | What it shows |
| :--- | :--- |
| `services/organization-service/app/auth.py` | `authenticated_user`, `require_tenant_admin`, `TenantContext` |
| `services/organization-service/app/tenancy.py` | `TenantOwnedMixin` and the query helpers every service should copy |
| `services/organization-service/tests/test_tenant_isolation.py` | two organizations, two administrators, every manipulation attempt |
| `services/organization-service/tests/test_tenancy_pattern.py` | the helpers proven on a throwaway table (copy this test shape) |
| `services/inventory-service/app/auth.py`, `app/tenancy.py` | the pattern copied into a data-owning service, including the active-organization check |
| `services/inventory-service/tests/test_tenant_isolation.py` | two organizations' product catalogs, with the manipulation attempts |

Microservices do not share code at runtime, so a new service **copies** `require_tenant_admin` (and the
`authenticated_user` it builds on) and `tenancy.py`, then keeps them in sync deliberately.

## The five rules

1. **The tenant comes only from the authenticated user.** `require_tenant_admin` validates the Bearer token with
   the Auth Service (`GET /api/v1/auth/me`) and returns a `TenantContext` whose `organization_id` is the Auth
   Service's record of that user. **Never** read an organization id from the URL, query string, headers, cookies
   or request body, even "for convenience" or "only for Super Admins".
2. **Every tenant-owned table has `organization_id UUID NOT NULL` (indexed).** Use `TenantOwnedMixin`. Uniqueness
   is per tenant: `UniqueConstraint("organization_id", "sku")`, never a global unique on a business key.
3. **Every query goes through the scoping helpers** (`scoped_select`, `get_scoped`, `update_scoped`,
   `delete_scoped`). A query that touches tenant data without an `organization_id = :tenant` filter is a bug.
4. **Another tenant's row looks exactly like a missing row.** Return `404` (or `None`), never `403`, and use the
   same message, so ids cannot be probed for existence.
5. **New rows get their `organization_id` from the context** (`create_for_tenant`). Request schemas must not
   contain `organization_id`, and a row's `organization_id` can never be updated (`update_scoped` refuses).

## Error semantics (identical across services)

| Situation | Status |
| :--- | :--- |
| Missing, invalid or expired token | `401` |
| Valid token, but not an active `organization-admin` with an organization (including **every** Super Admin) | `403` |
| The organization is missing or inactive | `403` (same message for both) |
| Auth Service cannot answer | `503` (never `401`: it is not the caller's fault) |
| Object id that is not in the caller's tenant | `404` |

## Template for a new endpoint

```python
from fastapi import Depends
from sqlalchemy.orm import Session

from app.auth import TenantContext, require_tenant_admin      # copied from the Organization Service
from app.database import get_db
from app.tenancy import TenantOwnedMixin, create_for_tenant, get_scoped_or_404, scoped_select

class Product(TenantOwnedMixin, Base):                         # organization_id NOT NULL + index
    __tablename__ = "products"
    __table_args__ = (UniqueConstraint("organization_id", "sku", name="uq_products_org_sku"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    sku: Mapped[str] = mapped_column(String(64), nullable=False)

class ProductCreate(BaseModel):                                # NOTE: no organization_id field
    sku: str
    name: str

@app.get("/api/v1/inventory/products")
def list_products(tenant: TenantContext = Depends(require_tenant_admin), db: Session = Depends(get_db)):
    return db.scalars(scoped_select(Product, tenant)).all()

@app.get("/api/v1/inventory/products/{product_id}")
def get_product(product_id: uuid.UUID, tenant: TenantContext = Depends(require_tenant_admin), db: Session = Depends(get_db)):
    return get_scoped_or_404(db, Product, tenant, product_id, "Product")      # another tenant's id -> 404

@app.post("/api/v1/inventory/products", status_code=201)
def create_product(payload: ProductCreate, tenant: TenantContext = Depends(require_tenant_admin), db: Session = Depends(get_db)):
    product = create_for_tenant(Product, tenant, **payload.model_dump())       # organization_id from the context
    db.add(product); db.commit()
    return product
```

## Where isolation is usually lost (check each one)

* **Joins and sub-queries**: filter *every* tenant table in the statement, not only the first.
* **Aggregates, reports, dashboards, exports**: `SUM`/`COUNT` need the filter too; a "total across all customers" leaks.
* **Lookups by a business key** (SKU, invoice number, slug): filter by `organization_id` as well, or two tenants collide.
* **Bulk updates/deletes**: `update_scoped`/`delete_scoped` include the tenant in the `WHERE`; raw SQL must too.
* **Background jobs, scripts and message consumers**: they have no request, so pass the `organization_id`
  explicitly from the trusted source of the job, and still use the helpers.
* **Caches and file storage**: include the organization id in every cache key and storage path.
* **Logs and error messages**: never echo another tenant's data; keep "not found" messages generic.
* **Cross-service references**: other services' ids are plain UUIDs (no foreign key across databases). Never accept
  one from the client and trust it; resolve it through a tenant-scoped query.

## Super Admin access

Super Admins manage the platform, not tenant data. If a Super Admin ever needs to read a tenant's data, add a
**separate** route under an admin prefix protected by `require_super_admin` that takes the organization id as an
explicit, validated parameter. Never loosen a tenant endpoint to accept "a Super Admin or the tenant". The tenant
dependency rejects Super Admins on purpose and the tests assert it.

## Inactive organizations

The Organization Service refuses a tenant whose organization is missing or inactive
(`require_tenant_organization`). **Every other service must do the same before it serves tenant data.** The
Inventory Service shows how (`require_active_tenant` in `services/inventory-service/app/auth.py`): it calls the
Organization Service's `GET /api/v1/tenant/organization` with the caller's *own* Bearer token. That endpoint
already answers `403` for a missing or inactive organization, so no extra secret or endpoint is needed, and the
answer is also compared with the organization the Auth Service returned. Every product endpoint depends on it.
It costs one extra service call per request; a short cache is a possible later optimization, but an inactive
organization must still be cut off within seconds.

## Defense in depth (recommended once data exists)

Application filters are the primary control. PostgreSQL Row-Level Security makes a forgotten filter fail closed:

```sql
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON products
  USING (organization_id = current_setting('app.organization_id')::uuid);
-- per request:  SET LOCAL app.organization_id = '<tenant uuid>';
```
This needs the application to connect as a non-owner database role. Add it when a service holds real tenant data.

## Stock tables: the database enforces it too (Step 14)

`warehouses`, `stock_balances`, `stock_movements` and `stock_operations` all carry `organization_id NOT NULL`. In
addition, `products` and `warehouses` have a unique `(organization_id, id)`, and every row that points at them uses a
**composite** foreign key `(organization_id, product_id)` / `(organization_id, warehouse_id)`. So even code that forgot
a filter cannot store Alpha's product in Beta's warehouse or write a movement that mixes the two: PostgreSQL refuses it.
The tests insert such rows directly to prove it. Warehouse codes are unique per organization too.

Idempotency keys are per organization (`UNIQUE (organization_id, idempotency_key)`), so one tenant can never replay
another's result, and the same key in two organizations is two independent operations.

## Scannable codes (Step 15)

`product_identifiers` is tenant-owned like everything else: `organization_id NOT NULL`, a composite foreign key `(organization_id, product_id)` to `products`, and `UNIQUE (organization_id, value)` so one code means at most one product *inside* an organization while two organizations may reuse the same text. A scan lookup runs only through the scoped helpers; a code or SKU of another organization is a plain 404, byte-for-byte the answer for a code that does not exist, so a scan cannot be used to discover that another tenant has a product. Codes are retired, never deleted or re-pointed (trigger).

## Sales: clients, delivery lists and the Inventory Service (Step 15.2)

`clients`, `delivery_lists`, `delivery_list_items` and `delivery_list_counters` all carry `organization_id NOT NULL`; `delivery_lists` points at `clients` and `delivery_list_items` at `delivery_lists` through **composite** foreign keys `(organization_id, id)`, so a list cannot reference another organization's client, nor an item another organization's list, even by a bug. Client names and list numbers are unique **per organization**.

The Sales Service never keeps product data. When it needs to know about a product it asks the Inventory Service with the **caller's own bearer token** (never a service secret), so the Inventory Service derives the organization itself. A product id of another organization is therefore absent from the answer and is reported as `404 Product not found.`, byte for byte the answer for an id that does not exist. Product facts the browser sends are refused, not trusted.

## Purchasing: suppliers, purchase orders and the Inventory Service (Step 16A)

`suppliers`, `purchase_orders`, `purchase_order_lines`, `purchase_order_counters` and `purchase_order_requests` all carry `organization_id NOT NULL`; `purchase_orders` points at `suppliers` and `purchase_order_lines` at `purchase_orders` through **composite** foreign keys `(organization_id, id)`, so an order cannot reference another organization's supplier, nor a line another organization's order, even by a bug. Supplier names, supplier codes and order numbers are unique **per organization**; idempotency keys too, so one tenant can never replay another's request.

Like Sales, the Purchasing Service keeps no product data: it asks the Inventory Service with the **caller's own bearer token**, so a product id of another organization is absent from the answer and reported as `404 Product not found.`, identical to an id that does not exist.

## Testing checklist for every new tenant endpoint

Create two organizations with an administrator each, then prove, for **both** directions (A to B and B to A):

- [ ] each administrator sees only their own rows (lists, counts, totals);
- [ ] fetching, updating or deleting the other tenant's object id returns `404` and changes nothing;
- [ ] a query string / header / cookie / JSON body that names the other organization changes nothing;
- [ ] the endpoint's OpenAPI entry declares no organization input;
- [ ] a Super Admin token gets `403`; a missing or invalid token gets `401`; an Auth Service outage gets `503`;
- [ ] an inactive organization is refused without affecting the other tenant;
- [ ] **mutation check**: temporarily make the code trust a header, and confirm the tests fail.

## The browser

The portals call tenant APIs from **server-side** code only, using the HttpOnly session cookie as the Bearer token.
The browser never sends an organization id, and the dashboard page takes no parameters, so there is nothing to tamper with.
