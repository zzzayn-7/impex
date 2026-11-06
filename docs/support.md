# Help & Support

Organization administrators can write to the Impex team from inside their portal; the Super Admin answers from a **Support Inbox** in the
Super Admin portal. Email is only a *notification*: the conversation itself lives in the database (`impex_support`) and is never lost
because a mail server is down.

```
Organization Portal (:3001)                     Support Service (:8005)                     Super Admin Portal (:3000)
 Help & Support  ── /api/support/* ──────────▶  tickets · messages · events ◀──────────── Support Inbox ── /api/support/*
 (HttpOnly tenant cookie)                       outbox (same transaction)                  (HttpOnly Super Admin cookie)
                                                    │
                                                    ▼  background worker (retries)
                                              SMTP (Mailpit locally) ──▶ support address  /  the requester
```

## What people see

**Organization administrator** — *Help & Support* in the navigation (and *Need help? Contact support* on the first-time setup screens):
a list of the organization's requests (search, status/category filters, "New reply" markers, pagination), **New request** (subject,
category, priority, message), and a conversation page with the status, every message and a reply box. A closed request takes no more
replies; they send a new one.

**Super Admin** — *Support Inbox* in the navigation (with a count of unread tickets). A table of every organization's tickets: ticket number,
organization, requester, subject, category, priority, status, submitted date, latest activity and an unread dot; search (ticket number,
subject, organization, requester name or e-mail), filters (status, category, priority, unread) and pagination. A ticket page shows the
organization's identity and contact details, the whole conversation, a reply box with an optional "after sending" status, **Mark In Progress /
Waiting for Customer / Mark Resolved / Close ticket / Reopen**, a priority control, the email notification records (with *Try again* for a
failed one) and the audit trail.

Categories: Technical Issue, Change Request, Account & Organization, Billing & Subscription, General Inquiry.
**A Change Request is only a request**: nothing in Impex changes by itself; the Super Admin reviews it and makes any change deliberately.

Statuses and the moves allowed (enforced by the service **and** by a database trigger):

| From | To |
| :--- | :--- |
| Open | In Progress, Waiting for Customer, Resolved, Closed |
| In Progress | Open, Waiting for Customer, Resolved, Closed |
| Waiting for Customer | Open, In Progress, Resolved, Closed |
| Resolved | Open, In Progress, Closed |
| Closed | Open |

A Super Admin reply moves an active ticket to *Waiting for Customer* unless they choose another status. A customer follow-up on a
*Waiting for Customer* or *Resolved* ticket moves it back to *Open*. Every status or priority change is recorded (who, when, from, to).
Tickets and messages are **never deleted** (database triggers refuse it, and refuse rewriting a message, moving a ticket to another
organization, or changing its number).

## Email

| Event | Email goes to | Contains |
| :--- | :--- | :--- |
| New ticket | `SUPPORT_NOTIFICATION_EMAIL` | ticket number, organization, category, subject, link to the Super Admin portal |
| Customer follow-up | `SUPPORT_NOTIFICATION_EMAIL` | the same, marked as a follow-up |
| Super Admin reply | the **requester's e-mail** (the verified address recorded when they opened the ticket) | the reply text and a link to the ticket in the Organization Portal |

* The sender is always `SMTP_FROM_ADDRESS` / `SMTP_FROM_NAME`. The browser can never choose a sender or a recipient: the portal forwards only
  the subject, category, priority and message; the recipient is decided on the server.
* No password, token or key is ever in an email, and the new-ticket email does not contain the message itself. Subjects and names are
  reduced to one line (no header injection); the HTML part escapes everything.
* No inbound email is read. Replying to a notification does nothing; people answer in the portal.

### The outbox (why an SMTP outage loses nothing)

When a ticket or message is saved, a `support_email_outbox` row is written **in the same transaction**. A background worker in the Support
Service claims due rows (`FOR UPDATE SKIP LOCKED`, with a lease so a crashed worker's row is picked up again), sends them with **no database
transaction open**, and records the result: `sent`, or back to `pending` with exponential back-off (`SUPPORT_OUTBOX_RETRY_BASE_SECONDS`,
default 30 s, doubling, capped at 1 h) until `SUPPORT_OUTBOX_MAX_ATTEMPTS` (default 8), then `failed`. A failed row keeps a short,
credential-free reason, is visible on the ticket page and in `GET /api/v1/support/admin/notifications`, and can be retried by the Super
Admin (*Try again*). If `SUPPORT_NOTIFICATION_EMAIL` is empty, tickets are still saved and shown in the inbox; the notifications keep being retried
and are sent once the address is set (if they ran out of attempts first, use *Try again*).
Delivery is **at least once**, not exactly once: if the service dies after the mail server accepted a message but before `sent` was
recorded, that email is sent again. A notification may repeat; a request is never lost.

## Configuration (`.env`)

| Variable | Meaning |
| :--- | :--- |
| `SUPPORT_NOTIFICATION_EMAIL` | where new-ticket and follow-up notifications go (the Impex support mailbox). **Set this for production.** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_STARTTLS`, `SMTP_SSL`, `SMTP_FROM_ADDRESS`, `SMTP_FROM_NAME` | the same SMTP settings the Organization Service uses. Production: your provider. Local: Mailpit (`SMTP_HOST=mailpit`, `SMTP_PORT=1025`, `SMTP_STARTTLS=false`) |
| `SUPER_ADMIN_PORTAL_URL`, `TENANT_PORTAL_URL` | where the links in the emails point |
| `SUPPORT_OUTBOX_INTERVAL_SECONDS` (5), `SUPPORT_OUTBOX_RETRY_BASE_SECONDS` (30), `SUPPORT_OUTBOX_MAX_ATTEMPTS` (8) | worker tuning |
| `SUPPORT_TICKETS_PER_HOUR` (10), `SUPPORT_MESSAGES_PER_10_MIN` (30) | per-user rate limits (answered `429` with `Retry-After`) |
| `SUPPORT_DB_NAME` (`impex_support`) | the service's own database |

The Super Admin and Organization portals reach the service through `SUPPORT_SERVICE_URL` (set in `docker-compose.yml`).

## Security model

* **Organization comes from the verified identity only.** The Support Service validates the bearer token with the Auth Service (inactive user
  → 401) and the tenant with the Organization Service (inactive organization → 403). A request body or query that names an organization,
  requester, number, status or recipient is ignored. Another organization's ticket answers a `404` identical to a ticket that does not exist.
* **Super Admin role is verified by the Auth Service on every call**; an organization administrator's token gets `403` at every
  `/api/v1/support/admin/*` endpoint, and an organization cookie does not open the Super Admin portal.
* **Idempotency-Key** on creating a ticket and on every message (both sides): double clicks and retries record once; the same key with a
  different request is `409`.
* **Text is text.** Messages are length-limited, control and bidirectional-override characters are removed, and both portals render them
  as plain text (React escapes; the e-mail HTML is escaped). Nothing a person writes is ever interpreted as markup.
* **Rate limits** are counted in the database per user, so they hold across several service instances.
* **Support during first-time setup.** An administrator who has not finished the setup wizard can still open *Help & Support* (and see the
  Super Admin's answers), because setup is exactly where people get stuck. Setup itself is unchanged and still mandatory.
* **Business APIs are gated on the server** (see [`onboarding.md`](onboarding.md)): until the organization *and* the administrator are set
  up, the portal's product/warehouse/stock/scan/sales/purchasing routes answer `403 setup_required`; authentication, setup, Help & Support,
  the logo and health endpoints stay reachable.

## Run it

```powershell
# one-time: create the database in an existing Postgres volume (never resets anything), then migrate
Get-Content database/add-support-database.sql | docker exec -i impex-postgres sh -c 'psql -U $POSTGRES_USER -d postgres'   # safe to repeat: does nothing if impex_support exists
docker compose run --rm --no-deps support-service alembic upgrade head
docker compose run --rm --no-deps support-service alembic check                                                       # "No new upgrade operations detected."

# local mail catcher + services
docker compose --profile mailpit up -d mailpit support-service dashboard super-admin
docker compose restart gateway https-proxy
# Mailpit inbox: http://localhost:8025
```

For production set `SUPPORT_NOTIFICATION_EMAIL` and the `SMTP_*` provider settings in `.env`, then `docker compose up -d support-service`.

## Verify it

```powershell
# unit/integration tests (each suite builds its own throwaway database from the migrations)
docker compose run --rm --no-deps support-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -q"
docker build --target test -t impex-dashboard-test ./frontend/dashboard;   docker run --rm impex-dashboard-test sh -c "npx tsc --noEmit && npx vitest run"
docker build --target test -t impex-super-admin-test ./frontend/super-admin; docker run --rm impex-super-admin-test sh -c "npx tsc --noEmit && npx vitest run"

# the live end-to-end script (needs Mailpit as the mail server and a support address; see the top of the file for the exact command)
python scripts/verify_support.py
```

`verify_support.py` runs the whole workflow against the live stack — **Organization Admin opens a ticket → the Super Admin sees it in the
Support Inbox and receives the email → the Super Admin replies in the portal → the Organization Admin sees the reply and receives the
email** — plus follow-ups, every status move, forged identities, two organizations, a non-Super-Admin at the inbox, hostile text, an SMTP
outage with recovery, unfinished onboarding, deactivated users/organizations and the database guarantees. It creates throwaway
organizations ("Support Check …") and removes exactly those rows (by id) and the emails it caused afterwards.

### Manual end-to-end (browser)

1. Start Mailpit and the services (above), with `SUPPORT_NOTIFICATION_EMAIL` set (e.g. `support@impex.test`).
2. Sign in to the Organization Portal (`http://localhost:3001`) as an organization administrator → **Help & Support → New request** → send.
3. Open Mailpit (`http://localhost:8025`): the *New support request* email to the support address, with a link to the ticket.
4. Sign in to the Super Admin portal (`http://localhost:3000`) → **Support Inbox**: the ticket is there, unread. Open it, write a reply, **Send reply**.
5. Back in the Organization Portal: the list shows **New reply**; open the ticket to read it. Mailpit shows the *Impex Support replied* email to the administrator's address.
6. Stop Mailpit (`docker compose stop mailpit`), send another reply: it is saved and shown at once, the ticket page shows the email as *Waiting to send*; start Mailpit again and it is delivered within a minute.
