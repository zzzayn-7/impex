# Support Service

FastAPI + PostgreSQL (`impex_support`), port **8005**. It owns the **Help & Support** tickets: who asked what, the conversation, the audit
trail of status/priority changes, and the durable outbox of notification emails. Design, configuration, security and operation are in
[`docs/support.md`](../../docs/support.md).

It deliberately has **no onboarding dependency** (an administrator who has not finished first-time setup can still ask for help) and never
changes any other service's data: a *Change Request* is only a request.

## API (`/api/v1/support`, Bearer token required except `/health`)

Organization administrators (organization taken from the verified token, never from the request):

| Method & path | Purpose |
| :--- | :--- |
| `POST /tickets` | open a ticket (`subject`, `category`, `priority`, `message`). **Requires `Idempotency-Key`.** `201`, or `200` for a retry |
| `GET /tickets?status=&category=&q=&unread=&limit=&offset=` | the organization's tickets, newest activity first |
| `GET /tickets/{id}` | the conversation (marks the Super Admin's replies as read). Another organization's id is a `404` |
| `POST /tickets/{id}/messages` | follow up (`body`). **Requires `Idempotency-Key`.** A closed ticket answers `409` |
| `GET /summary` | unread / open / total |

Super Admin (role verified by the Auth Service):

| Method & path | Purpose |
| :--- | :--- |
| `GET /admin/tickets?status=&category=&priority=&organization_id=&q=&unread=&limit=&offset=` | the inbox: every organization |
| `GET /admin/tickets/{id}` | conversation + audit events + notification records (marks the customer's messages as read) |
| `POST /admin/tickets/{id}/messages` | reply (`body`, optional `status`). **Requires `Idempotency-Key`.** The requester is emailed |
| `PATCH /admin/tickets/{id}` | change `status` and/or `priority` (only the documented moves) |
| `GET /admin/summary`, `GET /admin/notifications` | unread count; is the support address set, how many emails are waiting/failed |
| `POST /admin/notifications/{id}/retry` | another delivery attempt for a notification |

## Run the tests

```powershell
docker compose run --rm --no-deps support-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -q"
```

The suites build `impex_support_test` from the Alembic migrations, check `alembic check` (models match migrations) and drop it afterwards.

## Migrations

```powershell
docker compose run --rm --no-deps support-service alembic upgrade head
docker compose run --rm --no-deps support-service alembic check
```
