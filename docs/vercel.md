> **Historical.** `vercel.json` and `scripts/check_vercel_config.py` were removed: Impex is deployed on AWS with Terraform and SSM (see [`aws-deployment.md`](aws-deployment.md)). This page describes the abandoned Vercel layout and is kept only for reference.

# Deploying Impex on Vercel (one project, several services)

`vercel.json` at the repository root declares **nine services** in one Vercel project. Docker Compose stays the way to run Impex locally; nothing in it changed.

| Service | Root | Public? |
| :--- | :--- | :--- |
| `dashboard` (Organization Portal) | `frontend/dashboard` | **yes**, the main domain (the catch-all) |
| `super-admin` (Super Admin Portal) | `frontend/super-admin` | **yes**, the `admin.` subdomain |
| `auth-service`, `organization-service`, `inventory-service`, `sales-service`, `purchasing-service`, `support-service`, `finance-service` | `services/<name>` | **no** (internal only) |

The browser only ever talks to the two portals; the portals' server code calls the backend services. No backend needs a public address (the old nginx gateway that published `/api/v1/auth` and `/api/v1/organizations` is a local-development convenience).

## Routing

```
admin.<your-domain>/*   ->  super-admin
everything else         ->  dashboard
```

Vercel does not strip path prefixes, and both portals have their own `/login`, `/api/auth/...` and `/api/theme` routes, so they cannot share one hostname without a `basePath`. Routing by hostname needs no code change. The two portals keep their separate session cookies and, being on different hosts, never see each other's.

## Service bindings

A binding injects the target's internal URL into the caller. Each `env` name is the variable the code **already** reads (and Docker Compose already sets), so no call site changed:

| Caller | Bindings (env variable -> service) |
| :--- | :--- |
| dashboard | `AUTH_SERVICE_URL` auth, `ORG_SERVICE_URL` organization, `INVENTORY_SERVICE_URL` inventory, `SALES_SERVICE_URL` sales, `PURCHASING_SERVICE_URL` purchasing, `SUPPORT_SERVICE_URL` support, `FINANCE_SERVICE_URL` finance |
| super-admin | `AUTH_SERVICE_URL`, `ORG_SERVICE_URL`, `SUPPORT_SERVICE_URL` |
| organization-service | `AUTH_SERVICE_URL`, `PURCHASING_SERVICE_URL`, `SALES_SERVICE_URL` |
| inventory-service | `AUTH_SERVICE_URL`, `ORG_SERVICE_URL` |
| sales-service | `AUTH_SERVICE_URL`, `ORG_SERVICE_URL`, `INVENTORY_SERVICE_URL` |
| purchasing-service | `AUTH_SERVICE_URL`, `ORG_SERVICE_URL`, `INVENTORY_SERVICE_URL` |
| support-service | `AUTH_SERVICE_URL`, `ORG_SERVICE_URL` |
| finance-service | `AUTH_SERVICE_URL`, `ORG_SERVICE_URL`, `SALES_SERVICE_URL`, `PURCHASING_SERVICE_URL` |
| auth-service | none (it calls no other service) |

`python scripts/check_vercel_config.py` reads the source and fails if a service uses a `*_SERVICE_URL` that has no binding, or has a binding the code never uses. Run it whenever a service starts calling another.

A binding grants network access only; it does not authenticate. Every call still carries the caller's own token (or the shared internal keys) exactly as before.

### Middleware cannot use bindings

Bindings resolve only inside functions. The Organization Portal's middleware used to call the Auth and Organization services to enforce "finish first-time setup" and "this module is enabled" on the business API routes. On Vercel the middleware instead sends the session cookie and the path to `POST /api/gate` (a route handler on the same deployment) and relays its answer; locally and in Docker it runs the same rules itself. The rules live once, in `frontend/dashboard/src/lib/api-gate.ts`; the Vercel path **fails closed** (any error means 503, never "allowed"). `IMPEX_GATE_VIA_ROUTE=1` selects the route-based path outside Vercel, for testing.

## Environment variables

Vercel environment variables are **project-wide** (there is no per-service scope), so the names the code reads must not collide. They do not: the one name that differs per service in Compose, `DB_NAME`, has a correct per-service default in code (`impex_auth`, `impex_inventory`, ...), so **do not set `DB_NAME`** in Vercel. Compose renames a few variables on the way in; on Vercel use the names the code reads:

| Variable | Read by | Note |
| :--- | :--- | :--- |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | all seven backends | one Postgres server with the seven databases below |
| `PGSSLMODE=require` | all seven backends | libpq reads it, so no code change is needed for a hosted database |
| `SECRET_KEY` | auth | (Compose: `AUTH_SECRET_KEY`) |
| `INTERNAL_API_KEY` | auth | (Compose: `AUTH_INTERNAL_API_KEY`) |
| `AUTH_INTERNAL_API_KEY` | organization | the same value as `INTERNAL_API_KEY` |
| `ACTIVATION_API_KEY` | organization | the same value as `ORG_ACTIVATION_API_KEY` |
| `ORG_ACTIVATION_API_KEY` | super-admin | |
| `MODULE_INTERNAL_API_KEY` | organization, sales, purchasing, finance, **support**, **dashboard** | the shared internal secret; support and the dashboard use it for the scheduled jobs below |
| `CRON_SECRET` | dashboard | a random string of at least 16 characters; Vercel sends it as `Authorization: Bearer ...` with every scheduled request |
| `LOGO_STORAGE` | organization | `blob` (the default on Vercel) or `local` |
| `LOGO_BLOB_ACCESS` | organization | `private` (default) or `public`; must match the Blob store's access mode, which cannot be changed after creation |
| `BLOB_READ_WRITE_TOKEN` (or the OIDC variables Vercel adds when you connect a store: `BLOB_STORE_ID`, `VERCEL_OIDC_TOKEN`) | organization | the credential for the Blob store; create a **private** store and connect it to the project |
| `RESERVATION_API_KEY` | inventory, sales | |
| `TENANT_PORTAL_URL` | organization, super-admin, support | public address of the Organization Portal, e.g. `https://app.example.com` |
| `SUPER_ADMIN_PORTAL_URL` | support | public address of the Super Admin Portal, e.g. `https://admin.example.com` |
| `APP_BASE_URL` | organization | public base address used in e-mails |
| `SMTP_*`, `SMTP_FROM_*`, `SUPPORT_NOTIFICATION_EMAIL` | organization, support | real SMTP server |
| `DEMO_MODE` (+ `DEMO_ADMIN_PASSWORD`) | auth, organization, super-admin | leave unset/false in production |

Never set the `*_SERVICE_URL` variables yourself: Vercel injects them (a value set by hand would be overridden or, worse, point at a stale address).

## Node and npm for the two portals

Vercel gives each Node major a fixed npm (Node 22 -> npm 10, Node 24 and 26 -> npm 11) and offers no setting to choose npm itself, so the two Next.js services pin both:

* `engines.node` is `24.x` in both `package.json` files (Vercel's default moves on to newer majors; `@zxing/library` in the dashboard already requires Node 24).
* each service in `vercel.json` has `installCommand` / `buildCommand` that run **npm 12.2.2** through `npx` (`npx --yes npm@12.2.2 ci`, `... run build`). `npx` needs no global-install permissions. Change the number to upgrade npm.
* `package-lock.json` is committed for both portals (generated with Node 24 and npm 12.2.2, every package from the public registry) and installed with `npm ci`, so a deployment gets exactly the versions that were tested (Next.js 14.2.35, React 18.3.1, ...) and the build fails loudly if `package.json` and the lock ever disagree. After changing a dependency run `npx --yes npm@12.2.2 install` in that folder and commit the new lock. The Docker images read the same lock (their `npm install` honours it).
* `package.json` has `"allowScripts": { "esbuild@0.21.5": true }`: npm 12 blocks dependency install scripts unless approved, and this approves esbuild's postinstall (older npm versions ignore the field).

Verified in containers for both portals on Node 24 (and the dashboard on Node 22): `npm ci`, `next build`, the full test suites and starting the production server pass with npm 12.2.2. Not verified: that Vercel's build image lets `npx` fetch npm 12 (it should, the install itself downloads from the same registry). If a build ever fails at that step, delete the two `installCommand`/`buildCommand` lines to fall back to the bundled npm 11.

Warnings that remain and are not caused by this repo's settings: `Unknown env config "cache-dir"` (an environment variable Vercel sets for the build; npm 12 still only warns) and `deprecated whatwg-encoding` (a dependency of jsdom, used only by the tests; fixed by upgrading jsdom, a separate change). The Docker images still use Node 20 / npm 10.8 and are unchanged.

## Databases and migrations

* Seven databases on one hosted Postgres: `impex_auth`, `impex_organizations`, `impex_inventory`, `impex_sales`, `impex_purchasing`, `impex_support`, `impex_finance` (the code's defaults). The scripts in `database/init` show how they are created.
* Alembic is **not** run by a Vercel deploy (Docker Compose does it with one-shot `<name>-migrate` containers: see [`database-migrations.md`](database-migrations.md)): run `python -m app.db_migrations` (or `alembic upgrade head`) for each service against the hosted databases (from CI or a workstation, with that service's `DB_*` variables). Do it before the first deploy and before any deploy that adds a migration. A service whose database is not at its migration head refuses to start, so forgetting this shows up as a failed start-up check with a clear message, not as errors on the first request. Bindings do not resolve during builds, so migrations cannot be a build step that needs another service.
* Serverless functions open many short-lived connections: use the provider's pooled connection endpoint for `DB_HOST`/`DB_PORT`.

## Python version

Vercel runs Python 3.12 / 3.13 / 3.14. Each service has a `.python-version` of `3.12`; every service's test suite was run on Python 3.12. The Docker images and CI still use 3.11 (unchanged).

## Scheduled work (the two background workers)

`finance-service` normally runs a synchronisation thread and `support-service` an e-mail outbox task. A serverless function cannot keep those running, so on Vercel (when the `VERCEL` variable is present) neither starts, and a schedule does the work instead:

```
Vercel schedule --POST + CRON_SECRET--> dashboard /api/cron/finance-sync   --binding + X-Internal-Key--> finance-service /internal/v1/finance/sync-cycle
Vercel schedule --POST + CRON_SECRET--> dashboard /api/cron/support-outbox --binding + X-Internal-Key--> support-service /internal/v1/support/outbox-run
```

* Each internal endpoint does exactly what one turn of the loop does, is protected by `MODULE_INTERNAL_API_KEY`, is not in the OpenAPI document, and is safe to call repeatedly (posting and sending are idempotent).
* The `/api/cron/*` routes are public addresses; they refuse anything without the right `CRON_SECRET` and refuse everything when it is unset or shorter than 16 characters.
* **Frequency:** `vercel.json` uses every 15 minutes, which Vercel allows on every plan. On a plan that allows it you can tighten `schedule` (the finance loop ran every 15 seconds and the outbox every 5 seconds locally). Until then finance postings and notification e-mails can lag by up to 15 minutes.
* `docker compose` is unchanged for everyday use: there the in-process loops still run.

## Company logos

`organization-service` stores logos through a `LogoStorage` protocol. On Vercel it uses `BlobLogoStorage` (Vercel Blob SDK `vercel-blob`), in a **private** store: a logo has no public address and is only served through the service's own authenticated route. Create the store, connect it to the project, and set `LOGO_BLOB_ACCESS` to the store's mode. Locally nothing changes (`LOGO_STORAGE=local`, the named volume). Logos are limited to 2 MB, within Vercel's 4.5 MB request-body limit.

## Still to confirm on a real deployment

* **Services is a Beta feature** of Vercel. The docs show hostname routing only with generic services, so the first preview deployment should confirm it works with two Next.js services.
* **`schedules` next to `services`:** the docs do not say explicitly that the top-level `schedules` key is valid in a services project, nor that a path schedule goes through the top-level rewrites to the dashboard. If either is not so, the two schedules are the only part to adjust.
* **Database and migrations:** you still need a hosted Postgres with the seven databases and `alembic upgrade head` run for each service (see above).

## Local development

`docker compose up` is unchanged. `vercel dev` runs all services together and injects the binding variables (note that schedules targeting a service function are not supported by `vercel dev`).
