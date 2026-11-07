# Organization Settings

Once first-time setup is complete, an organization administrator manages their company from **Settings** (`/settings` in the Organization Portal).
No new service was added: the **Organization Service** owns the company's information and business preferences, the **Auth Service** owns each
administrator's own identity, and the Settings page only reads and writes through them with the administrator's own session.

## The five sections

| Section | What it does | Owner |
| :--- | :--- | :--- |
| Company profile | edit display name, contact e-mail, phone, address, website, description; see (read-only) the organization ID, slug, country, tax number, owner and status, each with **Request change** | Organization Service |
| Company branding | preview, upload, replace or remove the logo; see how the header will look | Organization Service (the same validation and storage as the first-time wizard) |
| Administrator profile | edit **your own** display name; see e-mail, role, organization and user ID read-only | Auth Service (`PATCH /api/v1/auth/me/profile`) |
| Business preferences | default currency (ISO 4217), time zone (IANA), date format, number format | Organization Service |
| Enabled modules | which modules are on, what depends on what, **Request access** for the others (read-only) | Organization Service (Module Management, Step 19) |

Below them, **Recent changes** lists the history (what, who, when). The Settings content has its own warm ivory theme; the portal header and every
other page keep the existing look.

## Rules

* **Identity only from the session.** No endpoint accepts an organization or user id. Every request model refuses fields it does not name (`422`), so the id,
  slug, country, tax number, status, ownership, setup state and modules cannot be sent through Settings, whatever a browser does.
* **Settings open once setup is complete.** Before that they answer `403 setup_required` and the page redirects to `/setup`. Saving settings never touches
  the setup state: it cannot restart the wizard. Organizations that existed before are already `completed` and can use Settings at once.
* **Concurrency.** Every change names the settings version it was made from (`expected_version`); the organization row is locked while it is checked and
  written. The later of two simultaneous saves gets `409 version_conflict` **with the current settings**, which the page shows instead of overwriting them.
  Every successful change adds one to the version.
* **History.** Every changed field is recorded (previous value, new value, acting administrator, time, source) in an append-only table (a trigger refuses
  `UPDATE`/`DELETE`). A logo change records only *added / replaced / removed*: never a storage key, token or password.
* **Preferences are defaults and presentation only.** The default currency starts *new* invoices and purchase orders; the time zone and the date/number
  formats decide how dates and amounts are *written on screen*. Nothing recorded is converted or rewritten: issued invoices, purchase orders, payments, stock quantities
  and units, and stored timestamps (always timezone-aware UTC) keep exactly what they were made with. An issued invoice keeps its own currency and its own seller-name
  snapshot, so renaming the company or changing the logo never alters a document already issued. The Organization Service holds no commercial record at all (tested).
* **Validation twice.** The forms and the portal's routes check every field (same rules, normalized: spaces collapsed, e-mail lower-cased, `https://` added to a website);
  the Organization Service repeats them and is the authority. Control characters and `<` `>` are refused in every text field.
* **Logo.** PNG, JPEG or WebP, the existing size and dimension limits, content decoded and re-encoded on the server, stored on the existing persistent logo
  volume under an unpredictable key. A new logo gets a new version, so the portal never shows a stale one. Nothing about the logo is reachable across organizations.
* **Requests, not edits.** *Request change* (registered facts) and *Request access* (modules) open Help & Support with a Change Request filled in from **fixed wording**
  (a link carries only a key, never text). A ticket never changes a company fact or a module.
* **Modules.** Settings stay open when every business module is disabled; an organization administrator cannot enable anything.

## Endpoints (Organization Service, Bearer token of an active organization administrator)

| Method & path | Purpose |
| :--- | :--- |
| `GET /api/v1/tenant/settings` | company, read-only facts, branding, preferences, version |
| `PATCH /api/v1/tenant/settings/company` | partial update of the editable company fields + `expected_version` |
| `PATCH /api/v1/tenant/settings/preferences` | partial update of the four preferences + `expected_version` |
| `PUT /api/v1/tenant/settings/logo` | multipart `file` + `expected_version` |
| `DELETE /api/v1/tenant/settings/logo?expected_version=` | remove the logo |
| `GET /api/v1/tenant/settings/history` | who changed what, and when |
| `GET /api/v1/tenant/organization` | (existing) now also carries the preferences and the usable modules |
| `GET /api/v1/tenant/organization/logo` | (existing) the logo, tenant-bound and versioned |
| `PATCH /api/v1/auth/me/profile` | (existing, Auth Service) the signed-in administrator's own name |

The portal exposes them as `/api/settings/{company,preferences,logo,profile,history}` (HttpOnly cookie in, nothing secret out).

## Database (migration `0006`, additive and reversible)

`organizations` gains `contact_phone`, `address_street`, `address_city`, `address_state`, `address_postal_code`, `website`, `description`, `default_currency`
(default `USD`), `timezone` (`UTC`), `date_format` (`YYYY-MM-DD`), `number_format` (`comma_dot`), `settings_version`, `settings_updated_at`, `settings_updated_by`,
with CHECK constraints; `organization_settings_history` is new. Existing organizations keep every value; their preferences start at what the portal already used, so nothing
changes on screen until someone chooses.

## First-time setup can no longer be bypassed through the services

Hiding screens and gating the portal's routes was not enough: an authenticated administrator could call the Inventory, Purchasing or Sales service directly before setup.
Each of them now refuses every business route with `403 {"code": "setup_required"}` until the organization's `setup_status` is `completed` (Organization Service) **and** the
administrator's own profile is confirmed (Auth Service); a missing field counts as *not done*. The check runs before the module check. Help & Support, authentication, the
setup itself and the health endpoints are unaffected (they are not business routes).

## Commands

```powershell
docker compose build organization-service inventory-service purchasing-service sales-service dashboard
docker compose run --rm --no-deps organization-service alembic upgrade head     # 0005 -> 0006
docker compose run --rm --no-deps organization-service alembic check
docker compose up -d organization-service inventory-service purchasing-service sales-service dashboard
docker compose restart gateway https-proxy

python scripts/verify_settings.py        # the live end-to-end script (creates and removes its own throwaway organizations)
```

Tests: each service's `python -m pytest -q` (the Organization Service covers Settings and the migration; Inventory, Purchasing and Sales cover the setup gate on every route),
and `npx tsc --noEmit && npx vitest run` in `frontend/dashboard`.

## Known limits

* The administrator's own name change is not in the settings history (the Auth Service owns it and keeps no history).
* Dates and numbers follow the preferences on Settings and the dashboard; the other list pages still write dates in ISO/UTC and will adopt the helpers (`lib/format.ts`) over time.
* Password and e-mail changes are deliberately not part of this step.
