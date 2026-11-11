"""The migration step and the readiness gate: a service cannot become ready while a required database migration is pending or has failed.

Every test works on its own SCRATCH database (created and dropped here), so neither the real database nor the shared test database is ever touched.
Covers: the gate refuses a database with no migrations, one that is behind the head, and one that is newer than the code, and accepts exactly the head; the
service's lifespan (what uvicorn runs at start-up) fails when the gate refuses, and starts when it passes; the migration step applies pending migrations, is a
no-op when nothing is pending, never touches existing data, exits non-zero (leaving the database un-stamped and the gate closed) when a migration fails or the
database is unreachable, and two steps started at once apply each migration exactly once; the step can never stamp, reset or downgrade.
"""
import re
import threading
import uuid
from pathlib import Path

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from app import db_migrations
from app.database import get_database_url
from app.db_migrations import SchemaNotReady, current_revisions, expected_heads, run_migrations, verify_database_schema

SERVICE = db_migrations.SERVICE


@pytest.fixture
def scratch(monkeypatch):
    """An empty database of its own; DB_NAME points at it for everything that builds its URL from the environment (the gate, the step, Alembic's env.py)."""
    name = f"impex_{SERVICE}_gate_{uuid.uuid4().hex[:8]}"
    admin = create_engine(get_database_url().set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    monkeypatch.setenv("DB_NAME", name)
    monkeypatch.setenv("SCHEMA_CHECK", "on")
    monkeypatch.setenv("SCHEMA_CHECK_WAIT_SECONDS", "0")
    monkeypatch.setenv("SUPPORT_OUTBOX_WORKER", "off")
    monkeypatch.setenv("FINANCE_SYNC_ENABLED", "false")
    yield name
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    admin.dispose()


def engine_of(name):
    return create_engine(get_database_url().set(database=name))


def revisions(name):
    eng = engine_of(name)
    try:
        return current_revisions(eng)
    finally:
        eng.dispose()


def head():
    return next(iter(expected_heads()))


def previous_revision():
    return db_migrations._script().get_revision(head()).down_revision


# --- the gate -------------------------------------------------------------------------------------------------------------------------------------
def test_the_gate_refuses_a_database_where_no_migration_was_ever_applied(scratch):
    with pytest.raises(SchemaNotReady, match="migrations are pending"):
        verify_database_schema()


def test_the_gate_refuses_a_database_that_is_behind_the_head(scratch):
    behind = previous_revision()
    if behind is None:
        pytest.skip("this service has a single migration: 'behind' is the same as 'never applied'")
    command.upgrade(db_migrations._config(), behind)
    assert revisions(scratch) == {behind}
    with pytest.raises(SchemaNotReady) as refused:
        verify_database_schema()
    assert behind in str(refused.value) and head() in str(refused.value) and f"{SERVICE}-migrate" in str(refused.value)  # says what is missing and what to run


def test_the_gate_accepts_exactly_the_head(scratch):
    command.upgrade(db_migrations._config(), "head")
    assert verify_database_schema() == head()


def test_the_gate_refuses_a_database_newer_than_the_code(scratch):
    command.upgrade(db_migrations._config(), "head")
    eng = engine_of(scratch)
    with eng.begin() as conn:
        conn.execute(text("UPDATE alembic_version SET version_num = 'from_a_newer_release'"))
    eng.dispose()
    with pytest.raises(SchemaNotReady, match="NEWER than this code"):
        verify_database_schema()
    assert revisions(scratch) == {"from_a_newer_release"}  # nothing was changed


def test_the_gate_refuses_when_the_database_cannot_be_reached(scratch, monkeypatch):
    monkeypatch.setenv("DB_PORT", "1")
    with pytest.raises(SchemaNotReady, match="cannot be reached"):
        verify_database_schema()


def test_the_gate_can_only_be_switched_off_explicitly(scratch, monkeypatch, capsys):
    monkeypatch.setenv("SCHEMA_CHECK", "off")
    assert verify_database_schema() == ""
    assert "WARNING" in capsys.readouterr().out


# --- the service's start-up (its lifespan) -----------------------------------------------------------------------------------------------------
def test_the_service_does_not_start_while_a_migration_is_pending(scratch):
    from app.main import app

    with pytest.raises(SchemaNotReady):
        with TestClient(app):
            pytest.fail("the service started with migrations pending")


def test_the_service_does_not_start_after_a_failed_migration(scratch, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("simulated migration failure")

    monkeypatch.setattr(db_migrations.command, "upgrade", broken)
    assert run_migrations() == 1
    from app.main import app

    with pytest.raises(SchemaNotReady):
        with TestClient(app):
            pytest.fail("the service started although its migration failed")


def test_the_service_starts_once_the_migrations_are_applied(scratch):
    from app.main import app

    assert run_migrations() == 0
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200


# --- the migration step --------------------------------------------------------------------------------------------------------------------------
def test_the_step_applies_pending_migrations_and_reports_success(scratch, capsys):
    assert run_migrations() == 0
    assert revisions(scratch) == {head()}
    out = capsys.readouterr().out
    assert "DATABASE MIGRATION SUCCEEDED" in out and head() in out and f"[migrate:{SERVICE}]" in out


def test_the_step_is_a_no_op_when_nothing_is_pending(scratch, capsys, monkeypatch):
    assert run_migrations() == 0
    capsys.readouterr()

    def must_not_run(*args, **kwargs):
        raise AssertionError("alembic upgrade ran although nothing was pending")

    monkeypatch.setattr(db_migrations.command, "upgrade", must_not_run)
    assert run_migrations() == 0
    assert "nothing to apply" in capsys.readouterr().out


def test_the_step_keeps_existing_data(scratch):
    behind = previous_revision()
    if behind is not None:
        command.upgrade(db_migrations._config(), behind)
    eng = engine_of(scratch)
    with eng.begin() as conn:
        conn.execute(text("CREATE TABLE precious_marker (note text)"))
        conn.execute(text("INSERT INTO precious_marker VALUES ('still here')"))
    assert run_migrations() == 0
    with eng.connect() as conn:
        assert conn.execute(text("SELECT note FROM precious_marker")).scalar() == "still here"
    eng.dispose()


def test_a_failing_migration_gives_a_nonzero_exit_a_clear_log_and_no_stamp(scratch, monkeypatch, capsys):
    def broken(*args, **kwargs):
        raise RuntimeError("simulated migration failure")

    monkeypatch.setattr(db_migrations.command, "upgrade", broken)
    assert run_migrations() == 1
    err = capsys.readouterr().err
    assert "DATABASE MIGRATION FAILED" in err and "simulated migration failure" in err and f"[migrate:{SERVICE}]" in err
    assert revisions(scratch) == set()  # nothing was stamped: the database still says it has no migrations
    with pytest.raises(SchemaNotReady):
        verify_database_schema()  # and so the service stays closed


def test_a_migration_that_really_fails_in_the_database_is_a_failure(scratch, capsys):
    """Not simulated: a table the migrations must create already exists, so the migration's own SQL raises."""
    from app import models  # noqa: F401
    from app.database import Base

    eng = engine_of(scratch)
    with eng.begin() as conn:
        conn.execute(text(f'CREATE TABLE "{Base.metadata.sorted_tables[0].name}" (unrelated integer)'))
    eng.dispose()
    assert run_migrations() == 1
    assert "DATABASE MIGRATION FAILED" in capsys.readouterr().err
    with pytest.raises(SchemaNotReady):
        verify_database_schema()  # the database is not at head, so the service stays closed


def test_an_unreachable_database_is_a_failure(scratch, monkeypatch, capsys):
    monkeypatch.setenv("DB_PORT", "1")
    monkeypatch.setenv("MIGRATION_DB_WAIT_SECONDS", "0")
    assert run_migrations() == 1
    assert "DATABASE MIGRATION FAILED" in capsys.readouterr().err


def test_two_steps_started_at_once_apply_each_migration_exactly_once(scratch, capsys):
    results = []
    barrier = threading.Barrier(2)

    def go():
        barrier.wait()
        results.append(run_migrations())

    threads = [threading.Thread(target=go) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(120)
    assert results == [0, 0]
    assert revisions(scratch) == {head()}
    out = capsys.readouterr().out
    assert out.count("DATABASE MIGRATION SUCCEEDED") == 1  # one applied it ...
    assert out.count("nothing to apply") == 1  # ... the other waited for the lock, found nothing pending


# --- the step can never be destructive ---------------------------------------------------------------------------------------------------------
def test_the_step_only_ever_upgrades():
    source = Path(db_migrations.__file__).read_text(encoding="utf-8")
    code = re.sub(r'""".*?"""', "", source, flags=re.S)  # the explanation at the top may name what it never does
    for forbidden in ("command.stamp", "command.downgrade", "DROP DATABASE", "DROP TABLE", "drop_all", "create_all", "TRUNCATE"):
        assert forbidden not in code, forbidden
    assert code.count("command.upgrade(") == 1
