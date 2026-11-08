# Module management

The Super Admin decides which business modules each organization can use. The Organization Service owns that decision; the Inventory,
Purchasing and Sales services each enforce it themselves, on every request. A menu that hides things is a convenience, never the protection.

## The modules

| Module | Contains | Needs |
| :--- | :--- | :--- |
| **Inventory** | Products, Stock, Scanning, Movements | nothing |
| **Purchasing** | Suppliers, Purchase Orders, Goods Receipts | Inventory |
| **Sales** | Clients, Delivery Lists, Dispatches, Invoices and Payments | Inventory |
| **Finance** | Financial Overview, Accounts, Expenses, Journal Entries (see [`finance.md`](finance.md)) | nothing (off by default; only the Super Admin enables it) |

**Always on, never a module:** Authentication, Organization Management, Onboarding and Help & Support. Nothing here can switch them off.

* An organization created **from now on** starts with Inventory enabled and everything optional disabled.
* Organizations that **existed** when this was introduced keep everything they could use: migration `0005` enabled Inventory, Purchasing and Sales
  for each of them (and recorded it in the history as "migrated"). The Super Admin can then switch off what an organization does not use.

## How it works

```
Super Admin Portal ──review / confirm──▶ Organization Service ── organization_modules (+ append-only history)
                                                │  GET /api/v1/tenant/organization  (the caller's own token)
                                                │  → { "is_active": true, "modules": ["inventory", "sales"], ... }
        Inventory / Purchasing / Sales services ┘  each checks: its module is listed AND the modules it requires are too
Organization Portal: reads the same list for the menu, the dashboard and the pages; its middleware refuses disabled API routes
```

* **One call.** The services already ask the Organization Service whether the caller's organization is active (with the caller's own token).
  The answer now also lists the modules the organization can use. A service allows a request only if its module (and the modules it needs) is in
  that list. Nothing from the request (headers, query, body, a browser-supplied organization id) is ever read for this.
* **Consistent refusal.** `403` with `{"detail": {"code": "module_disabled", "module": "sales", "message": "The Sales module is not enabled for your organization."}}`
  from every service; the portal's API routes answer `403 {"code": "module_disabled", "module": ...}`.
* **Outages never grant access.** If the Organization Service cannot answer, or its answer has no (or a malformed) module list, the services answer
  `503` and the portal shows its recoverable error. Nothing is allowed on a guess.
* **Immediate.** Nothing is cached: a change applies to the organization's next request.
* **Data is never touched.** Switching a module off deletes and changes no record. The module's pages and APIs are unreachable; enabling it again
  restores access to exactly the same records.

## Dependencies and safe deactivation

* Purchasing and Sales cannot be enabled without Inventory, and Inventory cannot be disabled while either is enabled (unless they are switched off in
  the same confirmed change).
* **Operations in progress are never stranded.** Before a module is switched off, the Organization Service asks the service that owns the records
  (`GET /internal/v1/organizations/{id}/module-usage`, shared secret `MODULE_INTERNAL_API_KEY`, not reachable from a browser):
  * a **dispatch** or **goods receipt** that is `posting` (stock is being moved) **blocks** the change (`409 pending_operations`, with counts). Switching Inventory off
    looks at Purchasing and Sales too, since they post through it.
  * if the service cannot be asked, the change is refused too (`usage_unavailable`): nothing is switched off on a guess.
  * records that are merely open (drafts, orders awaiting goods, unpaid invoices) never block. They are reported as **warnings** in the review, stay exactly as
    they are, and come back when the module is enabled again.
* **Recovery of already-started posting.** The race the check cannot close alone (the module is switched off at the very moment an operation is in flight) is
  handled in the services: with the module off, the `confirm` route of Sales (dispatches) and Purchasing (goods receipts) still lets a caller **finish a record that is
  already `posting`** (exactly once; stock is never moved twice), and refuses everything else, including reading it.

## Super Admin portal

*Organizations → Manage modules* (`/organizations/{id}/modules`): every module with its features, dependencies and state, the permanent capabilities, and the history.
Choose, then **Review changes** (nothing changes; it shows the result, what blocks it and warnings), then **Confirm**. A confirmation carries the revision that was reviewed:
if anything changed meanwhile (another Super Admin, a concurrent request) it is refused (`409 stale_revision`) and the review starts again. Changes to one organization are
serialized on its row, so concurrent confirmations cannot overwrite each other. Each change records who (name and e-mail), when, from what to what, and an optional reason.

## Organization Portal

The menu and the dashboard list only enabled modules (Dashboard and Help & Support are always there). A disabled module's page shows an **access-denied** state *instead of* the page
(the page is never rendered, so nothing of it is fetched or sent) with a link to ask the Impex team through Help & Support. The business API routes are refused by the
portal's middleware **and** by the services behind it.

## Help & Support

Help & Support is permanent and never gated. An organization can ask for a module in a ticket (the denied page opens a pre-filled Change Request with fixed wording), but **a ticket
never changes a module**: only a Super Admin action in the module management screen does, and the ticket's reference can be written in the change's reason.

## Data model (Organization Service, migration `0005`)

`organization_modules (organization_id, module_key, enabled, updated_by, updated_at)` and `organization_module_history (id, seq, organization_id, module_key, action, old_enabled,
new_enabled, changed_by, changed_by_name, changed_by_email, reason, batch_id, created_at)`. A trigger refuses `UPDATE` and `DELETE` on the history. (The live scripts' cleanup uses the same
out-of-band maintenance switch as the other guarded tables.) The migration is additive and reversible.

## Configuration

`MODULE_INTERNAL_API_KEY` (optional; defaults to `AUTH_INTERNAL_API_KEY`) is the shared secret between the Organization Service and the Purchasing and Sales services.

## Commands

```powershell
# back up, build, migrate (additive), start
docker compose build organization-service inventory-service purchasing-service sales-service dashboard super-admin
docker compose run --rm --no-deps organization-service alembic upgrade head      # 0004 -> 0005
docker compose run --rm --no-deps organization-service alembic check             # "No new upgrade operations detected."
docker compose up -d organization-service inventory-service purchasing-service sales-service dashboard super-admin
docker compose restart gateway https-proxy

# tests
docker compose run --rm --no-deps organization-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -q"   # also inventory-service, purchasing-service, sales-service
docker build --target test -t impex-dashboard-test ./frontend/dashboard;     docker run --rm impex-dashboard-test sh -c "npx tsc --noEmit && npx vitest run"
docker build --target test -t impex-super-admin-test ./frontend/super-admin;  docker run --rm impex-super-admin-test sh -c "npx tsc --noEmit && npx vitest run"

# the live end-to-end script (creates and removes its own throwaway organizations)
python scripts/verify_modules.py
```

The other live scripts keep working: `scripts/_onboarding.py` switches the three modules on for the throwaway organizations they create.
