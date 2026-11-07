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

* **Financial Overview** (`/finance`): counts, the position per currency (assets, liabilities, equity, revenue, expenses — each currency on its own),
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
