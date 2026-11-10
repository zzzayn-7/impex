"""The schema created by the migration: it matches the models, money is exact, every tenant row has an organization, and the migration is reversible."""
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import create_engine, text

from app.database import get_database_url
from conftest import alembic_config, targeting_test_database

MIGRATIONS = Path(__file__).resolve().parent.parent / "alembic" / "versions"
TENANT_TABLES = ("accounts", "journal_entries", "journal_lines", "expenses", "finance_events", "finance_requests", "finance_counters", "sync_events", "sync_sources", "finance_organizations",
                 "inventory_costs", "cost_entries", "trade_deliveries", "trade_adjustments", "capital_records", "opening_positions")


def test_the_schema_comes_from_the_migration_and_matches_the_models(engine):
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0002"
    with targeting_test_database():
        command.check(alembic_config())  # raises if models and migrations have drifted apart


def test_money_is_exact_numeric_and_every_tenant_row_has_an_organization(engine):
    with engine.connect() as conn:
        columns = {(r.table_name, r.column_name): (r.data_type, r.is_nullable, r.numeric_precision, r.numeric_scale) for r in conn.execute(text(
            "SELECT table_name, column_name, data_type, is_nullable, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = 'public'"))}
    for key in (("journal_lines", "debit"), ("journal_lines", "credit"), ("journal_entries", "total"), ("expenses", "amount"), ("capital_records", "amount"), ("capital_records", "effect"), ("opening_positions", "equity"),
                ("trade_deliveries", "revenue"), ("trade_deliveries", "cogs"), ("trade_adjustments", "amount"), ("cost_entries", "value"), ("inventory_costs", "total_value")):
        assert columns[key][0] == "numeric" and (columns[key][2], columns[key][3]) == (18, 4), key
    assert not [k for k, v in columns.items() if v[0] in ("double precision", "real")]
    for table in TENANT_TABLES:
        assert columns[(table, "organization_id")][1] == "NO", table


def test_the_guard_triggers_exist(engine):
    with engine.connect() as conn:
        triggers = {r[0] for r in conn.execute(text("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal"))}
    assert triggers == {"trg_journal_entries_guard", "trg_journal_lines_guard", "trg_accounts_guard", "trg_expenses_guard", "trg_finance_events_append_only", "trg_sync_events_guard",
                        "trg_capital_records_trading_append_only", "trg_cost_entries_trading_append_only", "trg_trade_adjustments_trading_append_only", "trg_trade_deliveries_trade_deliveries_guard",
                        "trg_opening_positions_opening_positions_guard"}


def test_the_migration_creates_empty_tables_and_no_sample_data():
    source = "".join(p.read_text(encoding="utf-8").lower() for p in MIGRATIONS.glob("*.py"))
    assert "bulk_insert" not in source and "insert into" not in source and "drop database" not in source


def test_the_migration_is_additive_and_the_only_destructive_code_is_its_own_downgrade():
    source = (MIGRATIONS / "0001_finance_foundation.py").read_text(encoding="utf-8")
    upgrade = source[source.index("def upgrade"):source.index("def downgrade")]
    assert "drop_table" not in upgrade and "drop_column" not in upgrade and "TRUNCATE" not in upgrade.upper()


def test_it_has_a_single_linear_history():
    names = sorted(p.name for p in MIGRATIONS.glob("0*.py"))
    assert names == ["0001_finance_foundation.py", "0002_capital_investment_profit_loss.py"]


def test_the_migration_applies_cleanly_downgrades_and_applies_again_on_a_scratch_database():
    name = "impex_finance_migration_probe"
    admin = create_engine(get_database_url().set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
        conn.execute(text(f"CREATE DATABASE {name}"))
    import os

    previous = os.environ.get("DB_NAME")
    os.environ["DB_NAME"] = name
    try:
        command.upgrade(alembic_config(), "head")
        command.check(alembic_config())
        command.downgrade(alembic_config(), "base")
        probe = create_engine(get_database_url())
        with probe.connect() as conn:
            assert conn.execute(text("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'alembic_version'")).scalar() == 0
            assert conn.execute(text("SELECT count(*) FROM pg_proc WHERE proname LIKE '%guard' OR proname LIKE '%append_only'")).scalar() == 0
        probe.dispose()
        command.upgrade(alembic_config(), "head")
        command.check(alembic_config())
    finally:
        if previous is None:
            os.environ.pop("DB_NAME", None)
        else:
            os.environ["DB_NAME"] = previous
        with admin.connect() as conn:
            conn.execute(text(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
        admin.dispose()
