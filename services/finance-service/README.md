# Finance Service

Chart of accounts, double-entry journal and expenses for each organization (tenant), with automatic, exactly-once postings from the invoices and
payments issued in Sales and the goods receipts confirmed in Purchasing. Own database (`impex_finance`) and Alembic migrations. Port 8006.

Full documentation — the accounting rules, the recognition policy, idempotency and recovery, currencies, configuration, install and tests — is in
[`docs/finance.md`](../../docs/finance.md).

```
app/
  main.py       FastAPI app + background synchronisation worker
  api.py        routes (/api/v1/finance/...): accounts, journal-entries, expenses, overview, sync
  auth.py       authenticated tenant, first-time-setup gate and module gate (Finance must be enabled by the Super Admin)
  chart.py      starter chart, system accounts, account management
  ledger.py     double-entry journal: drafts, posting, numbering, reversals
  expenses.py   expenses: draft, post, reverse
  sync.py       pull Sales/Purchasing feeds, store events once, post each in its own transaction, retry/back-off
  models.py     SQLAlchemy models   ·   alembic/versions/0001_finance_foundation.py (tables + the accounting triggers)
tests/          docker compose run --rm --no-deps finance-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -q"
```

Finance never writes to Sales, Purchasing or Inventory; it only reads their read-only feeds with the shared secret `MODULE_INTERNAL_API_KEY`.
