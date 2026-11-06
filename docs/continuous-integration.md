# Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull request.

| Job | What it does |
| :--- | :--- |
| `auth-service`, `organization-service`, `inventory-service`, `sales-service`, `purchasing-service`, `support-service` | installs the service's `requirements-dev.txt` and runs `python -m pytest -q` against a **throwaway PostgreSQL 16 container** that exists only for the job |
| `dashboard (Organization Portal)` | `npm install`, `npx tsc --noEmit`, `npx vitest run` (includes the Help & Support pages, routes and the setup gate), `npx next build` (which also type-checks the tests) |
| `super-admin (Super Admin Portal)` | `npm install`, `npx tsc --noEmit`, `npx vitest run` (includes the Support Inbox pages, routes and UI), `npx next build` |

## Safety

* The database is a service container with a made-up user and password (`ci_user` / `ci-only-throwaway-password`) that protect nothing. **No production credential, no repository secret and no persistent database or Docker volume is used or needed**; the workflow has `contents: read` permission only.
* Each service's test suite creates its own `impex_<service>_test` database, builds it from the Alembic migrations (so a missing migration fails the tests, and `alembic check` fails when a model and a migration disagree) and drops it afterwards.
* The live end-to-end scripts (`scripts/verify_*.py`) drive the running Docker stack with its real databases and are **not** run in CI. Run them locally after `docker compose up`.

## Run the same checks locally

```powershell
docker compose run --rm --no-deps sales-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -q"   # any service
docker build --target test -t impex-dashboard-test ./frontend/dashboard
docker run --rm impex-dashboard-test sh -c "npx tsc --noEmit && npx vitest run"
docker build --target test -t impex-super-admin-test ./frontend/super-admin
docker run --rm impex-super-admin-test sh -c "npx tsc --noEmit && npx vitest run"
```
