# Finance (Step 21A: the foundation)

The Finance module gives an organization a **chart of accounts**, a **double-entry journal** and **expenses**, and posts entries **automatically**
from the invoices and payments issued in Sales and the goods receipts confirmed in Purchasing. It is a separate service
(`services/finance-service`, port 8006) with its own database (`impex_finance`) and Alembic migrations.

What is *not* here yet (Step 21B): financial statements, reports and analytics. The Financial Overview is a first look at real records, not a
report suite. Finance has **no bank integration**, **no payment processing**, **no tax engine** and **no exchange rates**.

## Switching it on

Finance is **off for every organization** until the **Super Admin** enables it (Super Admin portal → Organizations → Modules → Finance). It needs no
other module (its automatic postings come from Sales and Purchasing when those are enabled too). An organization administrator cannot enable it:
"Request access" in Settings only opens a Help & Support ticket.

The Finance Service enforces this itself on every route, exactly like the other services: the caller's organization record (read with their own
token) must be active, have finished **first-time setup** (organization and the administrator's own profile) and list `finance` among its usable
modules. A missing or malformed answer is a `503`, never "yes". Switching it off keeps every record; switching it on again restores access to
exactly the same books.

## The accounting rules

* **Chart of accounts.** Five types: Assets, Liabilities, Equity, Revenue, Expenses. Each account has a code (unique per organization), a name, an
  optional description and an active/inactive flag. A starter chart is created the first time Finance is used (or when the worker first sees the
  organization): the system accounts below plus a few expense categories.
  * **System accounts** (`1050 Payments Received`, `1100 Accounts Receivable`, `1200 Inventory`, `2100 Sales Tax Payable`,
    `2200 Goods Received Not Invoiced`, `2300 Accrued Expenses Payable`, `3000 Opening Balance Equity`, `4000 Sales Revenue`) are the ones Finance posts
    to. They are found by a stable key, never by code or name. They can be renamed, but **never deleted, deactivated, re-coded or re-typed**.
  * An account **with postings** keeps its code and type; it can be deactivated (history stays) but not deleted. An unused account can be deleted.
  * An inactive account cannot be posted to.
* **Journal entries.** Each entry is in **one currency** with two or more lines; each line is exactly one debit *or* one credit; debits equal credits to
  the last 0.0001. An entry is created as a **draft** (editable, discardable, may be unbalanced) and **posted** in one transaction: it is locked,
  numbered (`JE-000001`, no gaps), totalled and marked posted. **A posted entry is immutable forever.**
* **Corrections are reversals.** A mistake is corrected by a **reversal**: a new posted entry that is the exact mirror image (debits and credits
  swapped), linked to the original, with a reason and an audit line. The original is untouched. An entry can be reversed once; a reversal cannot be
  reversed (post a new entry instead).
* **Exact money.** Amounts are `NUMERIC(18,4)` in the database and exact decimal strings in the API and the browser; sums in the portal use integers.
  Nothing is a float.
* **Idempotency.** Creating an entry or an expense requires an `Idempotency-Key`; the same key with the same request returns the first result
  (`200`) and creates nothing; the same key with a different request is a `409`. Concurrent duplicates create exactly one.
* **Concurrency.** Posting locks the entry, then the numbering counter (one order everywhere): two people posting the same draft → one succeeds, the
  other gets `409`; posting many drafts at once gives unique, gapless numbers; two simultaneous reversals → one wins.
* **Audit.** Every change writes an append-only audit line (who — a person or the synchronisation — what, when, a short description) in the same
  transaction as the change. Posted entries show who created and posted them and, for automatic ones, the source event.

### Enforced by the database too

The rules above are triggers and constraints in migration `0001`, so a bug or a direct SQL session cannot break them: a posted entry (and its lines)
cannot be updated or deleted; only a balanced entry with at least two lines, a matching total and active accounts can be posted; a line is exactly one
non-negative side; a line can only use an account of its own organization (composite foreign key); a reversal must be the exact mirror image of a
posted, non-reversal entry of the same currency and amount, once; a system account cannot be deleted, deactivated or re-typed; an account with
postings keeps its code and type; a posted expense is immutable; received sync events cannot be rewritten; the audit trail is append-only. The only
way to remove ledger rows is the out-of-band maintenance switch (`SET LOCAL app.allow_ledger_maintenance = 'on'`) that the application never sets and
the live verification scripts use to clean up their own throwaway organizations.

## Expenses

Record a cost with a date, description, category (an active **expense** account), amount, currency (default: the organization's), optional vendor and
reference. **Draft** (editable, deletable, not in the books) → **Posted** (one journal entry: debit the expense account, credit *Accrued Expenses
Payable*; the expense is now immutable) → **Reversed** (a mirror entry; both stay). **Recording an expense does not move money and implies no bank**:
the credit is a liability, not a bank balance.

## Currencies

* New entries and expenses default to the organization's **default currency** (Settings), read from the Organization Service. A later change of the
  default affects only *new* entries; recorded ones keep their own currency.
* Every entry has exactly one currency. **Amounts of different currencies are never added, netted or converted.** There are no exchange rates in
  Finance and none are invented: the Financial Overview shows one row per currency.
* An unknown currency code is refused, never defaulted.

## Automatic postings from Sales and Purchasing

A durable, **pull-based** synchronisation. Sales and Purchasing expose a read-only feed (`/internal/v1/organizations/{id}/finance-feed`, shared
secret `MODULE_INTERNAL_API_KEY`, hidden from the public API documentation); the Finance worker reads it. Neither service has an outbox or a callback,
and **Finance never writes to Sales, Purchasing or Inventory**.

| Event (key) | Entry |
| :--- | :--- |
| invoice issued (`invoice-issued:<id>`) | Dr Accounts Receivable *total* · Cr Sales Revenue *subtotal − discount* · Cr Sales Tax Payable *tax* |
| invoice voided (`invoice-voided:<id>`) | the exact reversal of the invoice's entry (only if Finance posted it) |
| payment recorded (`payment-recorded:<id>`) | Dr Payments Received · Cr Accounts Receivable (a payment *recorded* in Sales: no bank is implied) |
| payment reversed (`payment-reversed:<id>`) | Dr Accounts Receivable · Cr Payments Received |
| goods receipt confirmed (`receipt-confirmed:<id>`) | Dr Inventory · Cr Goods Received Not Invoiced, valued at accepted quantity × purchase order unit price, rounded once on the whole receipt |

**Recognition policy.** Purchasing has no supplier invoice, so Finance recognises an obligation **only when a goods receipt is confirmed** (the goods
were accepted into stock) and records it as *goods received not invoiced*, never as a payable to a bill that does not exist. **A purchase order alone
creates nothing**, and neither does a draft receipt, a draft invoice or a voided draft.

How exactly-once works: the worker re-reads a 10-minute overlap before its last position (a row commits slightly after its own timestamp); every
event is stored under its **unique key per organization** (`INSERT … ON CONFLICT DO NOTHING`); each event is posted in **its own transaction** under a
row lock (`FOR UPDATE SKIP LOCKED`) together with its status change, as one entry whose `source_key` is the event key (a second unique guard). Reading
the same fact twice — a retry, the overlap, a restart, two replicas — cannot create a second entry.

**Failures.** If a source is down, the source is marked `error` (visible in the overview, with the reason and the number of attempts — never a
secret) and the next cycle retries from the same position: nothing is lost or duplicated. A failing event is retried with exponential back-off
(`FINANCE_SYNC_RETRY_BASE_SECONDS`, doubling, capped at 1 hour) and held as **failed** after `FINANCE_SYNC_MAX_ATTEMPTS` (8) for a person to look at
(it can be retried from the overview). Data that cannot be trusted — an invoice whose total is not subtotal − discount + tax, an unknown currency,
more than 4 decimals — is held as failed **exactly as received**; nothing is corrected or guessed. A void that arrives before its invoice waits and
is retried. A void of an invoice issued before Finance was switched on is skipped (there is nothing to reverse).

**Cut-over.** Only events dated **after** the moment the Super Admin switched Finance on are posted. Earlier history is **not back-filled**: bring
opening balances in with a journal entry against *Opening Balance Equity*. If Finance is switched off and on again, what happened meanwhile is caught up
(once).

**Who is synchronised.** Each cycle the worker asks the Organization Service which organizations can use Finance right now (active, set up, Finance
enabled): a disabled organization is simply not synchronised. `POST /api/v1/finance/sync/run` ("Sync now") does the same for the caller's own
organization.

## The portal (Organization Portal → Finance)

* **Finance** (`/finance`): the ONE sidebar entry since Step 24 - see "Capital, Investment and Profit & Loss" below.
* **Accounting overview** (`/finance/accounting`, the former Financial Overview, no longer in the sidebar): counts, the position per currency (assets, liabilities, equity, revenue, expenses — each currency on its own),
  the latest entries, the health of the synchronisation with "Sync now", and failed events with Retry.
* **Accounts** (`/finance/accounts`): the chart grouped by type; add, rename, deactivate/reactivate, delete (when unused); system accounts marked.
* **Expenses** (`/finance/expenses`, `/new`, `/<id>`, `/<id>/edit`): list with filters, record, post, reverse, delete drafts.
* **Journal Entries** (`/finance/journal`, `/new`, `/<id>`, `/<id>/edit`): list with filters (status, source, account, currency, dates), a form with
  exact running totals and a "Balanced" indicator, detail with lines, provenance and history, reversal with a reason.

All pages show real records from the Finance Service, are inside the existing protected frame (session, first-time setup and module gate), and the
portal's `/api/finance/*` routes read only the fields they list (never an organization id, status, number or total) and send the browser's session
token — the organization always comes from the authenticated context.

## Configuration

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `FINANCE_DB_NAME` | `impex_finance` | the Finance database |
| `MODULE_INTERNAL_API_KEY` | `AUTH_INTERNAL_API_KEY` | shared secret for the feeds and the Organization Service's entitlement list; synchronisation is **off** (never open) if it is empty |
| `FINANCE_SYNC_ENABLED` | `true` | `false` disables the background worker (the tests drive it themselves) |
| `FINANCE_SYNC_INTERVAL_SECONDS` | `15` | how often the worker looks for work |
| `FINANCE_SYNC_RETRY_BASE_SECONDS` / `FINANCE_SYNC_MAX_ATTEMPTS` | `30` / `8` | first retry delay (doubles) and attempts before an event is held as failed |
| `FINANCE_SERVICE_URL` (dashboard) | `http://finance-service:8006` | where the portal reaches the service |

## Install on an existing stack (additive only)

```powershell
Get-Content database/add-finance-database.sql | docker exec -i impex-postgres sh -c 'psql -U $POSTGRES_USER -d postgres'   # creates impex_finance only if missing
docker compose build finance-service organization-service sales-service purchasing-service dashboard super-admin
docker compose run --rm --no-deps finance-service alembic upgrade head
docker compose run --rm --no-deps finance-service alembic check
docker compose up -d organization-service sales-service purchasing-service finance-service dashboard super-admin
docker compose restart gateway https-proxy
```

Nothing existing is reset or deleted: only the new `impex_finance` database is created, and the Organization, Sales and Purchasing services gain
read-only internal routes (no migration). Fresh installs get the database from `database/init/01-create-databases.sql`.

## Tests

```powershell
docker compose run --rm --no-deps finance-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -q"
python scripts/verify_finance.py            # live, end to end (throwaway organizations, cleaned up by exact id); --skip-outage skips stopping services
```

The Finance suite covers balanced/unbalanced entries, exact decimals, multi-currency separation, idempotency, concurrent posting and reversal,
reversal rules, expenses, duplicate-event prevention, outages/retries/back-off, atomic failure, the cut-over and skip rules, cross-tenant access, the
disabled module, the setup gate, every database rule by direct SQL, and migration consistency (`alembic check`, downgrade/upgrade). Sales and
Purchasing test their feeds (read-only, shared-secret, organization-scoped, exact). The portal tests cover the pages, the API routes, the forms and
the module gate.

## Known limits (deliberate)

* No bank accounts, bank feeds or reconciliation; a recorded payment debits *Payments Received*, not a bank.
* No exchange rates, revaluation or cross-currency totals.
* No tax rules: the tax on an invoice is exactly what Sales recorded.
* No financial statements (trial balance, income statement, balance sheet, ageing) — Step 21B.
* No supplier invoices or payables from purchase orders (no recognition policy exists for them); receipts are recorded as *goods received not invoiced*.
* No back-fill of history from before Finance was switched on; use an opening-balance entry.
* Posting dates are the event's date in UTC; there are no accounting periods or period locks yet.


# Capital, Investment and Profit & Loss (Step 24)

The Finance sidebar now has **one** entry, **Finance** (`/finance`, "Finance Overview"): three cards - **Capital**, **Investment**, **Profit & Loss** - one capital trend line and a
filterable transaction history, for a rolling period chosen top-right: **1 Week | 1 Month | 1 Year** (measured in the organization's time zone). The accounting pages (accounting
overview, Accounts, Expenses, Journal Entries) are **not deleted**: all their records, routes and APIs are unchanged and linked from the bottom of the Finance page. Expense entry
stays available as "Add Expense" on the page (and at `/finance/expenses`). Nothing in the ledger, the accounts, the audit trail or the synchronisation inbox was changed or removed.

## The rules (one place)

| | |
|---|---|
| **Investment** (total) | opening-position equity + owner contributions - owner withdrawals, as of a moment. |
| **Capital** | Investment + the net profit accumulated since the opening position (or since the beginning when there is none). **Contribute 5,000,000, buy 50 laptops at 100,000 with it: capital stays 5,000,000** (a purchase changes the *form* of the money). A delivery at a profit raises it by exactly that profit; customer payments never do. It is not the bank balance. |
| **Inventory purchase** | an investment *activity*: confirmed goods-receipt quantity x the purchase order's actual unit price, linked to the receipt, purchase order and supplier. Never an owner contribution, never counted as new capital. Recognised once per receipt however often the receipt is read again. The supplier-credit liability is the existing "Goods Received Not Invoiced" posting. |
| **Profit & Loss** | gross trading profit of **deliveries** + invoice adjustments - expenses, during the period. Recognised **once, when a dispatch is confirmed** (goods left) - not when an order is saved, reserved or prepared, not when an invoice is issued, not when it is paid. |
| **Revenue** | delivered quantity x the unit price agreed on the sales order line. Partial deliveries recognise only the quantity delivered. |
| **Cost of goods sold** | the **actual weighted-average cost** of the delivered quantity from the goods receipts (and from stock cost recorded by hand), taken from a running quantity/value per product and currency. **Never** the product's editable cost-price field. |
| **Gross vs net** | net = gross + adjustments - expenses. Posted expenses (and their reversals) count; drafts do not. |
| **Adjustments** | an issued invoice that bills more or less than delivery recognised (e.g. a discount) records the difference per delivered line as an auditable, signed, append-only adjustment; voiding the invoice adds the opposite row. An invoice never recognises revenue a second time. |
| **Change** | `((closing - opening) / abs(opening)) x 100`, shown with an arrow, a colour and the absolute change. A zero baseline shows **New** (plus the absolute change); both zero is 0.0%; never infinity. Capital and Investment compare the balance at the end of the period with the balance at its start. |
| **Currencies** | everything is computed per currency; currencies are never added or converted (no rates exist). With several currencies each is shown on its own and a combined figure is declared unavailable. |

## Nothing is guessed

* **Capital needs a basis.** It is shown only when an opening position or an owner contribution exists in that currency; otherwise the card says **Setup required** (no starting balance is
  invented). *Opening position*: what the business owned and owed on a date, per currency (equity = assets - liabilities); one active per currency; corrected by reversing (kept, with who and why).
  Profit dated before the opening date is part of the opening equity and is not added again.
* **A delivery with no recorded price** (an order made before prices were recorded) is `needs_price`; **with no reliable cost** (stock bought before Finance began, a cost in another currency) is
  `needs_cost`. Neither counts in any profit figure, a cost is never assumed to be zero, and they are listed ("Needs reconciliation") until settled: by recording the cost of the stock you hold
  ("Stock cost" - settles every waiting delivery of that product), by a later goods receipt, or by hand with a reason (final and audited).
* Stock cost entered by hand (opening stock, stock given in kind) is a cost basis only: it changes no capital figure (its value is already in the opening position or the in-kind contribution).

## How it works

* **Sales feed** (`GET /internal/v1/organizations/{id}/finance-feed?include_deliveries=true`) adds `delivery.confirmed` (one per confirmed dispatch: lines with quantity and the agreed unit price, order currency,
  null when none was recorded) and `allocations` on `invoice.issued`. **Purchasing feed**: receipt lines now carry product id, SKU and name. Older consumers see exactly what they saw before.
* The existing exactly-once synchronisation feeds the new model **in the same transaction** as the journal entry: receipt -> stock cost; delivery -> recognition (no journal entry); invoice -> adjustments only.
* **Tables** (migration `0002`, additive): `inventory_costs`, `cost_entries`, `trade_deliveries`, `trade_adjustments`, `capital_records`, `opening_positions`. Every fact has a unique key, so a retry,
  an overlapping read or a restart can never record it twice. The database refuses UPDATE/DELETE of recorded facts (a delivery's price/cost can be settled once, then is final).
* **API** (`/api/v1/finance`): `GET /summary?period=1w|1m|1y`, `GET /history?period&category&currency&limit&offset`, `GET /reconciliation`, `GET /deliveries/{id}`, `POST /deliveries/{id}/reconcile`,
  `POST /investments` (+ `/{id}/reverse`), `GET|POST /opening-positions` (+ `/{id}/reverse`), `GET|POST /inventory-costs`. Creates take an `Idempotency-Key`; only organization administrators of an organization with
  Finance enabled can use them, and the tenant comes only from the session.

## Existing organizations and history (reconciliation)

* The migration only adds tables. Existing accounts, journal entries, expenses and events are untouched. It resets the Sales *reading position* once so confirmed dispatches since Finance was switched on are read
  (each stored under its unique key; everything already received is ignored). Such deliveries have no recorded cost, so they appear as **needs cost reconciliation**.
* Goods receipts recorded before this release carry no product in the stored event, so their cost cannot be attributed: record the cost of that stock ("Stock cost") or set an opening position.
* Events before Finance was switched on are still not back-filled; bring that history in with the opening position and stock cost.

## Known limits

Costing is weighted-average in the order facts are recognised (a late-arriving receipt re-costs only deliveries made after it). One active opening position per currency. A manual reconciliation is final. Returns,
supplier invoices and bank balances are out of scope. The Super Admin's module description still uses the older wording.
