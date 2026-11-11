"""Database migrations: ONE migration step per deployment, and a readiness gate for the service.

Two jobs, both read-only with respect to existing data:

1. `python -m app.db_migrations` is the MIGRATION STEP. docker-compose runs it as a one-shot container (`sales-migrate`) that the service waits for
   (`depends_on: condition: service_completed_successfully`), so pending Alembic migrations are applied BEFORE the service starts, and a failed migration keeps
   the service from starting at all. It takes a PostgreSQL advisory lock, so even two migration steps started at the same moment (two deploys, two replicas'
   deploy jobs) never run the same migration twice: the second one waits, finds nothing pending and exits. It only ever runs `alembic upgrade head`: never
   `alembic stamp`, never a downgrade, never a reset. Exit code 0 = the database is at head, anything else = it is not.

2. `verify_database_schema()` is the GATE the service runs when it starts (its lifespan). If the database is not exactly at the migration head this code
   expects (migrations pending, never applied, or the database is newer than the code), the service REFUSES TO START with a message saying what to run, instead of
   starting and failing on the first request with a missing column. The service itself never runs migrations, so many instances can start at once.

The log lines are meant to be read by a person and grepped by a script:
    [migrate:sales] DATABASE MIGRATION SUCCEEDED ...   /   ... FAILED ...   /   ... nothing to apply ...
    [schema:sales]  database schema OK ...              /   ... NOT READY ...

Environment: the service's usual DB_* variables; MIGRATION_DB_WAIT_SECONDS (default 60: how long to wait for PostgreSQL), MIGRATION_LOCK_WAIT_SECONDS (default 300:
how long to wait for another migration step), SCHEMA_CHECK=off (ONLY for the automated tests: switches the gate off).
"""
import os
import sys
import time
import traceback
import zlib
from pathlib import Path
from typing import Optional, Set

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from app.database import get_database_url

SERVICE = "sales"
SERVICE_DIR = Path(__file__).resolve().parent.parent


class SchemaNotReady(RuntimeError):
    """The database is not at the migration head this version of the service needs."""


def _say(kind: str, message: str, stream=None) -> None:
    print(f"[{kind}:{SERVICE}] {message}", file=stream or sys.stdout, flush=True)


def _config() -> Config:
    config = Config(str(SERVICE_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(SERVICE_DIR / "alembic"))
    return config


def _script() -> ScriptDirectory:
    return ScriptDirectory.from_config(_config())


def expected_heads() -> Set[str]:
    return set(_script().get_heads())


def _engine() -> Engine:
    return create_engine(get_database_url(), pool_pre_ping=True)


def _show(revisions: Set[str]) -> str:
    return ", ".join(sorted(revisions)) if revisions else "none (no migration has been applied)"


def current_revisions(engine: Engine) -> Set[str]:
    with engine.connect() as conn:
        if not conn.execute(text("SELECT to_regclass('alembic_version') IS NOT NULL")).scalar():
            return set()
        return {row[0] for row in conn.execute(text("SELECT version_num FROM alembic_version"))}


def _wait_for_database(engine: Engine, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while True:
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return
        except SQLAlchemyError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)


def _database_label() -> str:
    url = get_database_url()
    return f"{url.host}:{url.port}/{url.database}"


# --------------------------------------------------------------------------------------------------------------------------------------------------
# 1. the readiness gate
# --------------------------------------------------------------------------------------------------------------------------------------------------
def verify_database_schema(wait_seconds: Optional[float] = None) -> str:
    """Returns the revision the database is at when it is exactly the head this code expects; otherwise raises SchemaNotReady (after saying why)."""
    if os.getenv("SCHEMA_CHECK", "on").strip().lower() in ("off", "0", "false", "no"):
        _say("schema", "WARNING: the database schema check is switched off (SCHEMA_CHECK=off). Never do this outside automated tests.")
        return ""
    wait = float(os.getenv("SCHEMA_CHECK_WAIT_SECONDS", "30")) if wait_seconds is None else wait_seconds
    engine = _engine()
    try:
        try:
            _wait_for_database(engine, wait)
            current = current_revisions(engine)
        except SQLAlchemyError as exc:
            message = f"NOT READY: the database {_database_label()} cannot be reached ({type(exc).__name__}). The service will not start."
            _say("schema", message, sys.stderr)
            raise SchemaNotReady(message) from exc
    finally:
        engine.dispose()
    expected = expected_heads()
    if current == expected:
        _say("schema", f"database schema OK: {_database_label()} is at revision {_show(current)}")
        return ", ".join(sorted(current))
    known = {revision.revision for revision in _script().walk_revisions()}
    fix = f"Apply the migrations first: `docker compose up -d {SERVICE}-migrate` (or `docker compose run --rm --no-deps {SERVICE}-service alembic upgrade head`)."
    if current - known:
        message = (f"NOT READY: the database {_database_label()} is at revision {_show(current)}, which this version of the service does not know "
                   f"(it expects {_show(expected)}). The database is NEWER than this code: deploy the matching service version. Nothing was changed.")
    else:
        message = (f"NOT READY: the database {_database_label()} is at revision {_show(current)} but this version of the service needs {_show(expected)}: "
                   f"migrations are pending. {fix} The service will not start until they are applied.")
    _say("schema", message, sys.stderr)
    raise SchemaNotReady(message)


# --------------------------------------------------------------------------------------------------------------------------------------------------
# 2. the migration step
# --------------------------------------------------------------------------------------------------------------------------------------------------
def _lock_key() -> int:
    return zlib.crc32(f"impex-migrate:{get_database_url().database}".encode())


def run_migrations() -> int:
    """Apply every pending migration (`alembic upgrade head`), once, under an advisory lock. Returns the process exit code: 0 only if the database is at head."""
    started = time.monotonic()
    engine = _engine()
    try:
        _say("migrate", f"starting: database {_database_label()}")
        _wait_for_database(engine, float(os.getenv("MIGRATION_DB_WAIT_SECONDS", "60")))
        key = _lock_key()
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as lock:
            deadline = time.monotonic() + float(os.getenv("MIGRATION_LOCK_WAIT_SECONDS", "300"))
            announced = False
            while not lock.execute(text("SELECT pg_try_advisory_lock(:key)"), {"key": key}).scalar():
                if time.monotonic() >= deadline:
                    raise RuntimeError("another migration step has held the migration lock for too long")
                if not announced:
                    _say("migrate", "another migration step is running: waiting for it to finish")
                    announced = True
                time.sleep(1)
            try:
                before, heads = current_revisions(engine), expected_heads()
                if before == heads:
                    _say("migrate", f"DATABASE MIGRATION: nothing to apply, the database is already at revision {_show(heads)}")
                    return 0
                _say("migrate", f"applying pending migrations: {_show(before)} -> {_show(heads)}")
                command.upgrade(_config(), "head")  # the only thing this step ever does to the schema
                after = current_revisions(engine)
                if after != heads:
                    raise RuntimeError(f"after the upgrade the database is at {_show(after)}, not at {_show(heads)}")
                _say("migrate", f"DATABASE MIGRATION SUCCEEDED: {_show(before)} -> {_show(after)} in {time.monotonic() - started:.1f}s")
                return 0
            finally:
                lock.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": key})
    except Exception as exc:  # noqa: BLE001  (every failure must end in a non-zero exit, so nothing depending on this step starts)
        _say("migrate", f"DATABASE MIGRATION FAILED: {type(exc).__name__}: {exc}", sys.stderr)
        traceback.print_exc(file=sys.stderr)
        _say("migrate", "This step never stamps, resets or downgrades the database. Fix the cause and run it again: it is safe to repeat.", sys.stderr)
        return 1
    finally:
        engine.dispose()


if __name__ == "__main__":
    sys.exit(run_migrations())
