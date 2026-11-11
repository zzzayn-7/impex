# Locking and deleting an organization

Two decisions only the **Super Admin** can take, from **Organizations** in the Super Admin portal (every organization row has *Lock* / *Unlock* and *Delete* buttons).

| | Lock | Delete |
| :--- | :--- | :--- |
| Use it when | the organization's monthly payment is late | the organization is no longer part of the CRM |
| Reversible | yes (*Unlock*) | **no** |
| What the organization's administrators can do | sign in, use **Settings** and **Help & Support** | nothing: their accounts are deleted |
| What happens to its data | nothing: it is all kept | **everything is deleted** in every service |

## Lock

* The administrators can still **sign in**, but **every module is switched off for them**: the Dashboard, Inventory, Purchasing, Sales, Invoices and Finance all show an
  "access locked" screen, and the sidebar lists only **Help & Support** and **Settings**. A banner above those two pages says why. They can write to the Impex team in
  Help & Support (for example to say the payment was made).
* It is enforced by the services, not by the menu. The Organization Service reports **no usable module** for a locked organization (`GET /api/v1/tenant/organization` returns
  `is_locked: true` and `modules: []`), and every service already refuses a module it is not told is enabled (`403 module_disabled`). So a lock cuts Inventory, Purchasing, Sales and
  Finance at once, including requests made without the portal. The Finance synchronisation also stops listing a locked organization, and resumes on unlock.
* **Nothing is deleted and the stored module settings are not touched.** Unlocking gives back exactly the modules the organization had before. A module change made by the Super Admin
  while the organization is locked is kept and takes effect at unlock.
* Your **note** (optional, up to 500 characters, e.g. "October invoice unpaid") is shown only to you in the Organizations table; it is never sent to the organization.
* Locking twice, or unlocking an unlocked organization, is harmless. Every lock and unlock is recorded (who, when).
* An organization administrator can never lock, unlock or delete anything (403), not even their own organization.

## Delete

Deletes the organization **for good**. The dialog lists everything that goes and asks you to **type the organization's exact name**; the button stays off until it matches (and the
Organization Service checks it again).

What is deleted, in this order, each service in **its own all-or-nothing transaction**:

1. **Finance**: accounts, journal entries and lines, expenses, reports, synchronisation state
2. **Sales**: clients, delivery lists, dispatches, sales orders, invoices, payments
3. **Purchasing**: suppliers, purchase orders, goods receipts
4. **Inventory**: products, stock, every stock movement, reservations
5. **Help & Support**: its tickets, messages, events and queued emails
6. **Auth**: the organization's administrators' accounts (their sessions die with them; Super Admins can never match)
7. the **logo file**, the organization's **settings and module history**, and the organization itself

* The organization is **locked first**, so nobody can use it while it is being removed.
* The append-only guards on the ledgers (stock movements, journal, issued invoices ...) are lifted for the purge's one transaction with the out-of-band maintenance switch
  (`app.allow_ledger_maintenance`) that no request handler sets; nothing else can delete a ledger row.
* **If a service cannot be reached the deletion stops there.** The organization stays **locked and marked "Being deleted"** (the button becomes *Finish deleting*), nothing already
  removed is undone, and running the deletion again continues: every purge is idempotent. The organization cannot be unlocked while a deletion is pending.
* The purge is decided by the schema, not by a list: every table with an `organization_id` column is emptied of that organization's rows (children before parents), plus the
  few tables that belong to it through a parent row (Support's messages, events, outbox, requests). A table that is in neither group makes the purge refuse to run, and each
  service has a test that fails until a new table is covered.
* The only thing kept is a short **append-only record** in the Organization Service that the deletion happened: organization id, name and slug, who, when, and how many rows each
  service removed. It holds no business data and cannot be edited or removed by the application. (`organization_lifecycle_events`, also holding the lock/unlock record.)

## How it is wired

* **Organization Service** owns the decision: migration `0007` adds `organizations.is_locked / locked_at / locked_by / lock_reason / deletion_requested_at` and the lifecycle record.
  API (Super Admin only): `POST /api/v1/organizations/{id}/lock` (`{reason?}`), `.../unlock`, `.../delete` (`{confirm_name}`), `GET .../lifecycle` (the record).
  `GET /api/v1/organizations` also returns `is_locked`, `locked_at`, `lock_reason`, `deletion_pending`.
* Each business service has a hidden internal route `POST /internal/v1/organizations/{id}/purge` (the Auth Service: `POST /internal/organizations/{id}/purge`). It is not in the API
  documents and not reachable from a browser. Only the Organization Service calls it, with a shared secret.
* **Secrets** (docker-compose, no `.env` change needed): `PURGE_API_KEY` (defaults to `MODULE_INTERNAL_API_KEY`, then `AUTH_INTERNAL_API_KEY`) is held by the five business services and
  the Organization Service; the Auth Service's purge uses its existing `INTERNAL_API_KEY`. Set `PURGE_API_KEY` to a value of its own in production so that
  *only* the Organization Service can delete organization data. The Organization Service also needs `INVENTORY_SERVICE_URL`, `SUPPORT_SERVICE_URL` and `FINANCE_SERVICE_URL`
  (set in docker-compose).
* **Timeouts.** The Super Admin portal waits up to 280 s for a deletion (`maxDuration` 300 s on the route); a very large organization on a platform with a shorter function limit can
  hit it, in which case the deletion simply shows as not finished and is finished by running it again.
* **Migrations.** The new Organization Service migration is applied automatically before the service starts (see [`database-migrations.md`](database-migrations.md)).
  Back up before deleting an organization you might still need: there is no undo.

## Checking it

* Automated: the Organization Service's `tests/test_lifecycle.py` (lock, unlock, deletion order, failure and retry, permissions, the record), each business service's
  `tests/test_organization_purge.py` (real data including the append-only ledgers, exactly that organization's rows, another organization untouched, idempotent, every table covered),
  the Auth Service's `tests/test_organization_purge.py`, the portal tests for the locked screens, the Super Admin buttons and routes.
* Live: `python scripts/verify_org_lifecycle.py` creates two throwaway organizations with real records in every service, locks and unlocks one, proves every module is refused
  while Settings and Help & Support work, deletes it (including a deletion that fails because the Sales service is stopped and is then finished), and shows that no row of it is left
  in any database while the other organization is exactly as it was. It cleans up after itself.
