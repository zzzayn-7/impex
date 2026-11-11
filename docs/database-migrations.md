# Database migrations

Every database-backed service (Auth, Organization, Inventory, Purchasing, Sales, Support, Finance) owns its own PostgreSQL database and its own Alembic migrations
(`services/<name>-service/alembic/versions`). This page explains how those migrations reach a database, and why a service can no longer run code that expects a
column the database does not have yet (the failure that prompted this: the Auth Service ran code that read `users.avatar_updated_at` before migration `0006` had been
applied, so sign-in failed).

## The rules

1. **Migrations are applied before the service starts.** A one-shot container, `<name>-migrate`, runs `alembic upgrade head`. The service lists it in
   `depends_on` with `condition: service_completed_successfully`, so Docker Compose does not create the service until the migration container has exited with code 0.
2. **A failed migration keeps the updated service from starting.** The migration container exits non-zero, Compose reports the dependency failed, and the service
   container is not started (an already-running old container is not replaced).
3. **The service also checks for itself.** When a service starts (its FastAPI lifespan) it compares the database's `alembic_version` with the migration head of the code
   it is running. If migrations are pending, were never applied, or the database is *newer* than the code, it **refuses to start** with a message saying what to run.
   This protects every path that does not go through Compose (`docker run`, Vercel, a hand-started `uvicorn`, a deploy that forgot the migration step).
4. **Only one thing migrates.** The services never run migrations themselves. The migration step takes a PostgreSQL advisory lock, so two steps started at the same
   moment cannot apply the same migration twice: the second waits, finds nothing pending and exits 0.
5. **Existing data is preserved.** The step only ever runs `alembic upgrade head`. It never runs `alembic stamp`, a downgrade, `create_all`, a drop or a reset, and it
   mounts no volume. Nothing in the deployment files deletes a Docker volume (`down -v`) or a database. `scripts/verify_migration_gate.py` checks this.
6. **Restarts do not migrate.** The migration lives in its own container (`restart: "no"`), not in the service's start command. Restarting a service (`docker restart`,
   a crash, `restart: unless-stopped`, `docker compose restart`) never runs migrations again. A repeated `docker compose up` re-runs the one-shot step, which finds the
   database at head, logs `nothing to apply` and exits in about a second.

## What the logs say

Migration container (`docker compose logs auth-migrate`):

```
[migrate:auth] starting: database postgres:5432/impex_auth
[migrate:auth] applying pending migrations: 0005 -> 0006
[migrate:auth] DATABASE MIGRATION SUCCEEDED: 0005 -> 0006 in 1.4s
```

```
[migrate:auth] DATABASE MIGRATION: nothing to apply, the database is already at revision 0006
```

```
[migrate:auth] DATABASE MIGRATION FAILED: ProgrammingError: ...        (with the traceback; exit code 1)
[migrate:auth] This step never stamps, resets or downgrades the database. Fix the cause and run it again: it is safe to repeat.
```

Service start-up (`docker compose logs auth-service`):

```
[schema:auth] database schema OK: postgres:5432/impex_auth is at revision 0006
```

```
[schema:auth] NOT READY: the database postgres:5432/impex_auth is at revision 0005 but this version of the service needs 0006: migrations are pending.
              Apply the migrations first: `docker compose up -d auth-migrate` (or `docker compose run --rm --no-deps auth-service alembic upgrade head`).
              The service will not start until they are applied.
```

`docker compose ps` shows each service `healthy` only once it is up (a health check calls its `/health`).

## Local development (Docker Compose)

```powershell
docker compose build                 # service and migration container share one image per service
docker compose up -d                 # migrations first, then the services; the data in the postgres_data volume is kept
docker compose logs auth-migrate     # what the migration did
```

* After pulling code that contains a new migration, just `docker compose build <service>` and `docker compose up -d <service>`: the migration container runs first
  (Compose starts it because the service depends on it). If you start the *old* container by hand, or the migration failed, you get the `NOT READY` message above
  instead of a half-working service.
* To apply migrations without starting anything else: `docker compose up auth-migrate` (or `docker compose run --rm --no-deps auth-migrate`). To check models against
  migrations: `docker compose run --rm --no-deps auth-service alembic check` (unchanged).
* The commands in the other docs (`docker compose run --rm --no-deps <service> alembic upgrade head`) still work and are equivalent.
* **Back up before a migration that changes or removes data** (`docker exec impex-postgres sh -c 'pg_dump -U $POSTGRES_USER -d impex_auth' > backups/impex_auth.sql`).
  Additive migrations (new nullable columns, new tables) do not need it.
* Without Docker (`uvicorn` from a virtualenv): run `python -m app.db_migrations` once from the service folder before starting it. The service refuses to start otherwise.
* Never run `alembic stamp head` to silence the check: that records a migration as applied without applying it, which is exactly the failure this prevents.
* Never delete the `postgres_data` volume (`docker compose down -v`) to "fix" a migration: it deletes every organization's data.

## Production

The same two pieces apply on any platform; only *who runs the step* differs.

* **Docker Compose / a single host:** `docker compose up -d` is the deployment. Compose runs each `<name>-migrate` before its service.
* **Kubernetes, ECS, Nomad or similar:** run the same image as a **one-off job** per database before rolling out the service (`command: python -m app.db_migrations`, same
  `DB_*` environment), and let the rollout wait for the job to succeed. Do **not** run it as an init step of every replica: the advisory lock makes that safe, but a
  job is clearer and is where failures should surface. A new replica started before the job finished will exit with `NOT READY` and be retried by the orchestrator.
* **Vercel / hosted Postgres** (see `docs/vercel.md`): run `python -m app.db_migrations` (or `alembic upgrade head`) for each service from CI or a workstation, with that
  service's `DB_*` variables, **before** deploying a version that adds a migration. If you forget, the new deployment fails its start-up check instead of serving errors.
* **Order for a release that adds a migration:** (1) back up if it changes or removes data, (2) apply the migration, (3) start/roll out the new service version. For
  non-additive changes, split the release (add, deploy code that no longer needs the old column, remove) so the *old* version keeps working during the rollout.
* **Rollback:** deploy the previous service version. It will refuse to start while the database is *newer* than it (`NOT READY ... NEWER than this code`), by design:
  restore from backup or write a reviewed downgrade migration; the migration step never downgrades automatically.

## Settings

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `MIGRATION_DB_WAIT_SECONDS` | `60` | how long the migration step waits for PostgreSQL |
| `MIGRATION_LOCK_WAIT_SECONDS` | `300` | how long it waits for another migration step that holds the lock |
| `SCHEMA_CHECK_WAIT_SECONDS` | `30` | how long a starting service waits for PostgreSQL before giving up |
| `SCHEMA_CHECK` | `on` | `off` switches the service's start-up check off. **Only the automated tests set it**; never use it elsewhere |

## Tests

* Each service has `tests/test_migration_gate.py` (17 tests, on scratch databases it creates and drops): the gate refuses a database with no migrations, one behind the head
  and one newer than the code, and accepts exactly the head; the service's lifespan does not start while a migration is pending or after a failed one, and starts once they are
  applied; the step applies pending migrations, is a no-op when nothing is pending, keeps existing data, exits non-zero when a migration really fails or the database is
  unreachable, two steps at once apply each migration exactly once, and the step's code contains no stamp, downgrade, drop or reset.
* `python scripts/verify_migration_gate.py` checks the Compose configuration (every service gated on its migration container, same image and database, no restart, no volume,
  nothing destructive anywhere in the deployment files). With `--live` it also drives scratch databases through *pending → migrated* with the real containers, and proves that
  with the migration step forced to fail `docker compose run <service>` does not start the service.
