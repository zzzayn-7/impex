# First-time organization onboarding

A newly invited organization administrator signs in with the existing login, and is then taken to a setup wizard instead of the
dashboard. The wizard sets the **company logo**, the **company name** and the **administrator's full name**, and sends them to the
dashboard when everything is saved. It is database-backed, not a front-end walkthrough.

## Who owns what

| Record | Owner | Where |
| :--- | :--- | :--- |
| Company setup state, company name, logo | **Organization Service** | `organizations.setup_status` (`pending` / `in_progress` / `completed`), `setup_completed_at`, `setup_completed_by`, `logo_storage_key`, `logo_content_type`, `logo_updated_at` |
| The administrator's own profile confirmation and full name | **Auth Service** | `users.profile_setup_completed_at`, `users.full_name` |
| The decision "does this person still need setup?" | the portal, on every request, from those two records | `frontend/dashboard/src/lib/onboarding.ts` (`setupNeed`) |

No cookie, `localStorage` or `sessionStorage` value is ever the record of completion. Nothing was duplicated: no new organization record,
no second identity, no new service, no second login.

## The flow

1. Sign in (unchanged). The dashboard and **every** portal page (checked in their layouts, before anything is streamed) look at both
   records. Company not completed → `/setup` (full wizard). Company completed but this administrator not confirmed → `/setup` (short
   "confirm your name" screen: **a new administrator of a configured company never repeats the company setup**). Both done → the page.
2. **Step 1 - Company**: logo (drag and drop or browse; PNG, JPEG or WebP) and company name (prefilled). The logo is uploaded and stored
   immediately; the name is saved on *Continue*. **Step 2 - You**: full name (prefilled), saved on *Continue*. **Step 3 - Review**: summary,
   a preview of the dashboard branding, *Complete Setup & Enter Dashboard*.
3. *Complete* is a small, repeatable saga (`POST /api/setup/complete`): (1) the Organization Service completes the company (it needs a
   stored, readable logo and a valid name, and records when and by whom) unless it is already completed; (2) the Auth Service confirms the
   administrator's name and marks their profile done, in one transaction. If step 2 fails after step 1 succeeded, the company stays
   completed and the administrator lands on the short profile screen (or retries); nothing is lost or applied twice. The browser goes to
   `/` only on success, and `/` re-checks both records.
4. A refresh, a new session or another device resumes where they stopped: the progress is in the databases.

Concurrency: company changes lock the organization row; two administrators finishing at the same moment produce **one** completion (the
first wins, the other sees it completed and only confirms their own profile). Once completed, the wizard cannot change the company any
more (`409 setup_completed`): later changes belong to a future Organization Settings screen.

**Who may set up the company:** any *active* administrator of that organization (the role and organization come from the verified token).
A primary-administrator-only rule would lock an organization out if that person never signs in, so it was not used.

## Existing data is never locked out

Migration `0004` (Organization Service) adds the columns with default `completed`, which backfills every existing organization, then switches
the default to `pending` for new ones. Migration `0003` (Auth Service) marks every existing account as confirmed. Both are additive and
reversible; nothing is deleted or reset. Organizations that existed before have no logo and show a monogram until a logo is added.

## Setup is enforced on the server, not only on the screens

Hiding pages is not enough: typing an API address, or calling it from a script with a valid session, must not bypass first-time setup. The
Organization Portal's `middleware.ts` therefore checks the setup state (Auth Service `/auth/me` + Organization Service `/tenant/organization`,
through the same `setupNeed` rule the pages use) before every business route (`/api/products`, `/api/warehouses`, `/api/stock`, `/api/scan`,
`/api/sales`, `/api/purchasing`):

* setup not finished → `403` with `code: "setup_required"`;
* the setup state cannot be read (a service is down) → `503` (fail closed: never "assume complete");
* no session → the route answers `401` itself; an inactive organization or user is refused by the services as before.

**Always reachable during setup:** sign-in/out, the setup wizard and its routes, the logo, **Help & Support** (`/support`, `/api/support/*`) and the
health endpoints. Help & Support is available *without* finishing setup on purpose, because setup is where people most often need help; it
does not complete or skip anything. The services behind the portal keep enforcing authentication, roles and tenant isolation on their own.
Cost: two small service calls per business API request. The live scripts keep working because they mark their throwaway organizations as set up.

## After setup: Settings

Once setup is complete, the company's name, logo, details and preferences are maintained from **Settings** (`/settings`; see [`settings.md`](settings.md)). Settings never restart or change the setup state, and the wizard's own endpoints keep refusing a completed organization. The services behind the portal (Inventory, Purchasing, Sales) now also refuse business calls until setup is complete, so the wizard cannot be bypassed by calling them directly.

## Logo storage and safety

* **Where**: the Organization Service's `LogoStorage` interface (`app/storage.py`) with a directory implementation. `LOGO_STORAGE_DIR`
  (default `/data/logos`) is a Docker **named volume** (`org-logos`, shown by `docker volume ls` as `impex_org-logos`): it survives container
  restarts, recreation and redeployment; only `docker compose down -v` would remove it, exactly as for the databases. To use object storage
  later, implement `LogoStorage` and return it from `get_logo_storage`.
* **Keys** are random (`ab/<43 random characters>.png`), made by the server, re-validated on every use (no path can escape the directory),
  never derived from the file name, and never sent to a browser. Writes are atomic; the old file is deleted only after the new logo is committed.
* **Validation** (`app/images.py`): the declared type must be PNG, JPEG or WebP; the bytes are **decoded** with Pillow and must really be one of
  those; size ≤ `LOGO_MAX_BYTES` (2 MiB), 64 ≤ shortest side, longest side ≤ 4096 (the header is checked before any pixel is decoded, so a
  decompression bomb is refused unexpanded). SVG, GIF, BMP, PDF, ICO and everything else are refused. The stored file is a **new PNG re-encoded from
  the pixels** (shrunk to fit 1024 px): EXIF/GPS, text chunks, appended data and polyglot payloads do not survive.
* **Serving**: `GET /api/organization/logo` in the portal → `GET /api/v1/tenant/organization/logo`. Authenticated, tenant-bound (no id anywhere:
  the organization comes from the token), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, `Cache-Control: private`,
  `ETag`. Another company's logo cannot be requested.

## Configuration

| Variable | Service | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `LOGO_STORAGE_DIR` | organization-service | `/data/logos` | where logos are written (mounted from the `org-logos` volume) |
| `LOGO_MAX_BYTES` | organization-service | `2097152` | upload size limit (also an optional `.env` value in docker-compose) |
| `LOGO_MIN_PIXELS`, `LOGO_MAX_PIXELS`, `LOGO_STORE_PIXELS` | organization-service | `64`, `4096`, `1024` | dimension limits and stored size |

## APIs

Organization Service (tenant administrator token; the organization comes from the token): `GET /api/v1/tenant/onboarding`,
`PUT /api/v1/tenant/onboarding/company`, `PUT|DELETE /api/v1/tenant/onboarding/logo`, `POST /api/v1/tenant/onboarding/complete`,
`GET /api/v1/tenant/organization/logo`; `GET /api/v1/tenant/organization` also reports `setup_status`, `has_logo`, `logo_version`.
Auth Service: `GET /api/v1/auth/me` reports `profile_setup_completed_at`; `PATCH /api/v1/auth/me/profile` (only `full_name`; every other
field is refused with 422) and `POST /api/v1/auth/me/profile/complete`. Portal routes: `/api/setup/{logo,company,profile,complete}`, `/api/organization/logo`.

## Safe rebuild and migration

```powershell
# 1. back up (read-only)
docker exec impex-postgres sh -c 'pg_dump -U $POSTGRES_USER -d impex_auth' > backup_impex_auth.sql
docker exec impex-postgres sh -c 'pg_dump -U $POSTGRES_USER -d impex_organizations' > backup_impex_organizations.sql
# 2. rebuild the three images (Pillow and python-multipart are new in the organization service)
docker compose build auth-service organization-service dashboard
# 3. additive migrations: auth 0002 -> 0003, organizations 0003 -> 0004
docker compose run --rm --no-deps auth-service alembic upgrade head
docker compose run --rm --no-deps organization-service alembic upgrade head
docker compose run --rm --no-deps auth-service alembic check
docker compose run --rm --no-deps organization-service alembic check
# 4. start (this also creates the org-logos volume) and refresh the proxies
docker compose up -d auth-service organization-service dashboard
docker compose restart gateway https-proxy
```

## Verification checklist (manual, in a browser)

1. As Super Admin create an organization and invite its administrator (or create a throwaway one); activate and **sign in to the Organization Portal**.
2. You land on **/setup**, not the dashboard. Type `/products`, `/invoices`, ... in the address bar: each goes back to /setup.
3. Try an SVG, a GIF and a >2 MB picture: each is refused with a message. Upload a PNG: the preview appears. Refresh the page: you resume at the next step.
4. Continue through the steps (company name, your name), review the summary and the branding preview, then **Complete Setup & Enter Dashboard**: you arrive at the dashboard automatically, with the logo, company name and your name in the header.
5. Sign out and in: straight to the dashboard. Run `docker compose restart organization-service` (and `up -d --force-recreate organization-service`): the logo is still there.
6. Add a second administrator to the same company: after signing in they see only **Welcome, let's confirm your name** (no logo or company fields), then the dashboard with the same branding.
7. Stop the Organization Service while on a page: you see a recoverable "We couldn't load your workspace" message with Sign out, never the page as if setup were done. Start it again and refresh.

Automated: `python scripts/verify_onboarding.py --with-outage` runs all of this against the live stack (132 checks) and cleans up by exact id and exact file.
The other live scripts mark their own throwaway organizations as already set up (`scripts/_onboarding.py`) because they test other features.

## What was deliberately left alone

Super Admin registration, invitation and activation, email/password login, session tokens, roles, DEMO_MODE, products, warehouses, scanning,
suppliers, purchasing, goods receiving, clients, delivery lists, dispatches, invoices and payments, and every existing API. The dark portal theme is unchanged
(only the setup screens use the ivory/sage palette). The services behind the pages (inventory, sales, purchasing) are unchanged: tenant isolation and
authorization work as before. The portal's business routes are refused on the server until setup is finished (see "Setup is enforced on the server").
