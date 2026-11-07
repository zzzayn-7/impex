"""finance foundation: chart of accounts, double-entry journal, expenses, audit trail and the Sales/Purchasing event inbox

A new database (impex_finance): nothing existing is touched. The accounting invariants are enforced by triggers.

Revision ID: 0001
Revises:
Create Date: 2026-11-07
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '0001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# ---------------------------------------------------------------------------------------------------------------------------------
# The accounting rules, enforced by the database itself so that no bug and no direct SQL session can break them.
# Out-of-band maintenance (test/verification cleanup) may DELETE after `SET LOCAL app.allow_ledger_maintenance = 'on'`; the application never does.
# ---------------------------------------------------------------------------------------------------------------------------------
MAINTENANCE = "COALESCE(current_setting('app.allow_ledger_maintenance', true), '') = 'on'"  # NULL-safe: an unset setting is simply "off"

JOURNAL_ENTRIES_GUARD = f"""
CREATE FUNCTION journal_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  debits numeric; credits numeric; line_count integer; inactive integer; orig journal_entries%ROWTYPE; mismatch integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'A journal entry is created as a draft and then posted'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' AND NOT ({MAINTENANCE}) THEN RAISE EXCEPTION 'A posted journal entry can never be deleted: reverse it instead'; END IF;
    RETURN OLD;
  END IF;
  -- UPDATE
  IF NEW.organization_id <> OLD.organization_id OR NEW.id <> OLD.id THEN RAISE EXCEPTION 'A journal entry cannot move to another organization'; END IF;
  IF OLD.status = 'posted' THEN RAISE EXCEPTION 'A posted journal entry can never be changed: reverse it instead'; END IF;
  IF NEW.status = 'posted' THEN
    SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0) INTO line_count, debits, credits
      FROM journal_lines WHERE organization_id = OLD.organization_id AND entry_id = OLD.id;
    IF line_count < 2 THEN RAISE EXCEPTION 'A journal entry needs at least two lines'; END IF;
    IF debits <> credits THEN RAISE EXCEPTION 'Debits (%) and credits (%) must be equal to post', debits, credits; END IF;
    IF debits <= 0 THEN RAISE EXCEPTION 'A journal entry must have an amount'; END IF;
    IF NEW.total IS DISTINCT FROM debits THEN RAISE EXCEPTION 'The entry total must equal its debits'; END IF;
    SELECT count(*) INTO inactive FROM journal_lines l JOIN accounts a ON a.organization_id = l.organization_id AND a.id = l.account_id
      WHERE l.organization_id = OLD.organization_id AND l.entry_id = OLD.id AND NOT a.is_active;
    IF inactive > 0 THEN RAISE EXCEPTION 'An inactive account cannot be posted to'; END IF;
    IF NEW.source_type = 'reversal' THEN
      SELECT * INTO orig FROM journal_entries WHERE organization_id = NEW.organization_id AND id = NEW.reverses_entry_id;
      IF NOT FOUND OR orig.status <> 'posted' THEN RAISE EXCEPTION 'Only a posted entry can be reversed'; END IF;
      IF orig.source_type = 'reversal' THEN RAISE EXCEPTION 'A reversal cannot itself be reversed'; END IF;
      IF orig.currency_code <> NEW.currency_code OR orig.total <> NEW.total THEN RAISE EXCEPTION 'A reversal must match the entry it reverses'; END IF;
      SELECT count(*) INTO mismatch FROM (
        (SELECT account_id, sum(credit) AS d, sum(debit) AS c FROM journal_lines WHERE organization_id = orig.organization_id AND entry_id = orig.id GROUP BY account_id
         EXCEPT SELECT account_id, sum(debit), sum(credit) FROM journal_lines WHERE organization_id = NEW.organization_id AND entry_id = NEW.id GROUP BY account_id)
        UNION ALL
        (SELECT account_id, sum(debit), sum(credit) FROM journal_lines WHERE organization_id = NEW.organization_id AND entry_id = NEW.id GROUP BY account_id
         EXCEPT SELECT account_id, sum(credit), sum(debit) FROM journal_lines WHERE organization_id = orig.organization_id AND entry_id = orig.id GROUP BY account_id)
      ) m;
      IF mismatch > 0 THEN RAISE EXCEPTION 'A reversal must be the exact mirror image of the entry it reverses'; END IF;
    END IF;
  ELSIF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'Invalid journal entry status';
  END IF;
  RETURN NEW;
END $$;
"""

JOURNAL_LINES_GUARD = f"""
CREATE FUNCTION journal_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id <> OLD.organization_id OR NEW.entry_id <> OLD.entry_id) THEN
    RAISE EXCEPTION 'A journal line cannot move to another entry';
  END IF;
  SELECT status INTO parent_status FROM journal_entries
    WHERE organization_id = COALESCE(NEW.organization_id, OLD.organization_id) AND id = COALESCE(NEW.entry_id, OLD.entry_id);
  IF TG_OP = 'DELETE' THEN
    IF parent_status IS NULL OR parent_status = 'draft' OR {MAINTENANCE} THEN RETURN OLD; END IF;  -- no parent: it was just deleted (a draft, or by maintenance)
    RAISE EXCEPTION 'The lines of a posted journal entry can never be changed';
  END IF;
  IF parent_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'The lines of a posted journal entry can never be changed'; END IF;
  RETURN NEW;
END $$;
"""

ACCOUNTS_GUARD = f"""
CREATE FUNCTION accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system AND NOT ({MAINTENANCE}) THEN RAISE EXCEPTION 'A system account cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.organization_id <> OLD.organization_id THEN RAISE EXCEPTION 'An account cannot move to another organization'; END IF;
  IF NEW.is_system IS DISTINCT FROM OLD.is_system OR NEW.system_key IS DISTINCT FROM OLD.system_key THEN RAISE EXCEPTION 'An account cannot become or stop being a system account'; END IF;
  IF OLD.is_system AND (NEW.code <> OLD.code OR NEW.account_type <> OLD.account_type OR NOT NEW.is_active) THEN
    RAISE EXCEPTION 'A system account keeps its code and type and cannot be deactivated';
  END IF;
  IF (NEW.code <> OLD.code OR NEW.account_type <> OLD.account_type)
     AND EXISTS (SELECT 1 FROM journal_lines WHERE organization_id = OLD.organization_id AND account_id = OLD.id) THEN
    RAISE EXCEPTION 'An account with postings keeps its code and type';
  END IF;
  RETURN NEW;
END $$;
"""

EXPENSES_GUARD = f"""
CREATE FUNCTION expenses_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'An expense is created as a draft'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND NOT ({MAINTENANCE}) THEN RAISE EXCEPTION 'A posted expense can never be deleted: reverse it instead'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.id <> OLD.id OR NEW.number <> OLD.number OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'An expense cannot be re-assigned';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'posted') THEN RAISE EXCEPTION 'A draft expense can only be posted'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.expense_date <> OLD.expense_date OR NEW.description <> OLD.description OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.vendor IS DISTINCT FROM OLD.vendor
     OR NEW.account_id <> OLD.account_id OR NEW.amount <> OLD.amount OR NEW.currency_code <> OLD.currency_code OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION 'A posted expense can never be changed: reverse it instead';
  END IF;
  IF OLD.status = 'posted' AND NEW.status NOT IN ('posted', 'reversed') THEN RAISE EXCEPTION 'A posted expense can only be reversed'; END IF;
  IF OLD.status = 'reversed' AND (NEW.status <> 'reversed' OR NEW.reversal_entry_id IS DISTINCT FROM OLD.reversal_entry_id) THEN RAISE EXCEPTION 'A reversed expense can never be changed'; END IF;
  RETURN NEW;
END $$;
"""

APPEND_ONLY = f"""
CREATE FUNCTION finance_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND {MAINTENANCE} THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'The finance audit trail is append-only';
END $$;
"""

SYNC_EVENTS_GUARD = f"""
CREATE FUNCTION sync_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF {MAINTENANCE} THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'A received financial event is kept';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.event_key <> OLD.event_key OR NEW.source <> OLD.source OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.event_time <> OLD.event_time THEN
    RAISE EXCEPTION 'A received financial event cannot be rewritten';
  END IF;
  IF OLD.status IN ('posted', 'skipped') AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'A processed event cannot be processed again'; END IF;
  IF OLD.status = 'posted' AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN RAISE EXCEPTION 'A posted event keeps its journal entry'; END IF;
  RETURN NEW;
END $$;
"""

GUARDS = (
    ("journal_entries", "journal_entries_guard", "BEFORE INSERT OR UPDATE OR DELETE", JOURNAL_ENTRIES_GUARD),
    ("journal_lines", "journal_lines_guard", "BEFORE INSERT OR UPDATE OR DELETE", JOURNAL_LINES_GUARD),
    ("accounts", "accounts_guard", "BEFORE UPDATE OR DELETE", ACCOUNTS_GUARD),
    ("expenses", "expenses_guard", "BEFORE INSERT OR UPDATE OR DELETE", EXPENSES_GUARD),
    ("finance_events", "finance_events_append_only", "BEFORE UPDATE OR DELETE", APPEND_ONLY),
    ("sync_events", "sync_events_guard", "BEFORE UPDATE OR DELETE", SYNC_EVENTS_GUARD),
)


def upgrade() -> None:
    op.create_table('accounts',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('code', sa.String(length=20), nullable=False),
    sa.Column('name', sa.String(length=150), nullable=False),
    sa.Column('account_type', sa.String(length=10), nullable=False),
    sa.Column('description', sa.String(length=500), nullable=True),
    sa.Column('is_active', sa.Boolean(), server_default=sa.text('true'), nullable=False),
    sa.Column('is_system', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    sa.Column('system_key', sa.String(length=40), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.CheckConstraint("account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')", name=op.f('ck_accounts_account_type_valid')),
    sa.CheckConstraint("code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'", name=op.f('ck_accounts_code_format')),
    sa.CheckConstraint('(is_system = (system_key IS NOT NULL))', name=op.f('ck_accounts_system_has_key')),
    sa.CheckConstraint('length(btrim(name)) > 0', name=op.f('ck_accounts_name_not_blank')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_accounts')),
    sa.UniqueConstraint('organization_id', 'code', name='uq_accounts_organization_id_code'),
    sa.UniqueConstraint('organization_id', 'id', name='uq_accounts_organization_id_id')
    )
    op.create_index(op.f('ix_accounts_organization_id'), 'accounts', ['organization_id'], unique=False)
    op.create_index('uq_accounts_organization_id_system_key', 'accounts', ['organization_id', 'system_key'], unique=True, postgresql_where=sa.text('system_key IS NOT NULL'))
    op.create_table('finance_counters',
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=20), nullable=False),
    sa.Column('last_number', sa.Integer(), server_default=sa.text('0'), nullable=False),
    sa.PrimaryKeyConstraint('organization_id', 'name', name=op.f('pk_finance_counters'))
    )
    op.create_table('finance_events',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('seq', sa.BigInteger(), sa.Identity(always=True), nullable=False),
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.Column('entity_type', sa.String(length=15), nullable=False),
    sa.Column('entity_id', sa.Uuid(), nullable=True),
    sa.Column('action', sa.String(length=40), nullable=False),
    sa.Column('actor_id', sa.Uuid(), nullable=True),
    sa.Column('actor_email', sa.String(length=320), nullable=True),
    sa.Column('source', sa.String(length=10), server_default=sa.text("'user'"), nullable=False),
    sa.Column('detail', sa.String(length=500), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("entity_type IN ('account', 'journal_entry', 'expense', 'sync')", name=op.f('ck_finance_events_entity_type_valid')),
    sa.CheckConstraint("source IN ('user', 'sync')", name=op.f('ck_finance_events_source_valid')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_finance_events'))
    )
    op.create_index('ix_finance_events_organization_id_entity_id', 'finance_events', ['organization_id', 'entity_id'], unique=False)
    op.create_index('ix_finance_events_organization_id_seq', 'finance_events', ['organization_id', 'seq'], unique=False)
    op.create_table('finance_organizations',
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.Column('activated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('organization_id', name=op.f('pk_finance_organizations'))
    )
    op.create_table('finance_requests',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.Column('idempotency_key', sa.String(length=100), nullable=False),
    sa.Column('scope', sa.String(length=30), nullable=False),
    sa.Column('request_hash', sa.String(length=64), nullable=False),
    sa.Column('entity_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_finance_requests')),
    sa.UniqueConstraint('organization_id', 'idempotency_key', name='uq_finance_requests_organization_id_idempotency_key')
    )
    op.create_table('journal_entries',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('entry_number', sa.String(length=20), nullable=True),
    sa.Column('entry_date', sa.Date(), nullable=False),
    sa.Column('description', sa.String(length=500), nullable=False),
    sa.Column('reference', sa.String(length=100), nullable=True),
    sa.Column('currency_code', sa.String(length=3), nullable=False),
    sa.Column('status', sa.String(length=10), server_default=sa.text("'draft'"), nullable=False),
    sa.Column('source_type', sa.String(length=12), server_default=sa.text("'manual'"), nullable=False),
    sa.Column('source_key', sa.String(length=160), nullable=True),
    sa.Column('source_summary', sa.String(length=300), nullable=True),
    sa.Column('reverses_entry_id', sa.Uuid(), nullable=True),
    sa.Column('reversal_reason', sa.String(length=500), nullable=True),
    sa.Column('total', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('created_by_email', sa.String(length=320), nullable=True),
    sa.Column('posted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('posted_by', sa.Uuid(), nullable=True),
    sa.Column('posted_by_email', sa.String(length=320), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.CheckConstraint("(reverses_entry_id IS NULL) = (source_type <> 'reversal')", name=op.f('ck_journal_entries_reversal_names_its_original')),
    sa.CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name=op.f('ck_journal_entries_currency_code_valid')),
    sa.CheckConstraint("source_type IN ('manual', 'expense', 'sales', 'purchasing', 'reversal')", name=op.f('ck_journal_entries_source_type_valid')),
    sa.CheckConstraint("status <> 'posted' OR (entry_number IS NOT NULL AND posted_at IS NOT NULL AND total IS NOT NULL AND total > 0)", name=op.f('ck_journal_entries_posted_is_complete')),
    sa.CheckConstraint("status IN ('draft', 'posted')", name=op.f('ck_journal_entries_status_valid')),
    sa.CheckConstraint('length(btrim(description)) > 0', name=op.f('ck_journal_entries_description_not_blank')),
    sa.ForeignKeyConstraint(['organization_id', 'reverses_entry_id'], ['journal_entries.organization_id', 'journal_entries.id'], name='fk_journal_entries_organization_id_journal_entries'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_journal_entries')),
    sa.UniqueConstraint('organization_id', 'entry_number', name='uq_journal_entries_organization_id_entry_number'),
    sa.UniqueConstraint('organization_id', 'id', name='uq_journal_entries_organization_id_id')
    )
    op.create_index(op.f('ix_journal_entries_organization_id'), 'journal_entries', ['organization_id'], unique=False)
    op.create_index('ix_journal_entries_organization_id_entry_date', 'journal_entries', ['organization_id', 'entry_date'], unique=False)
    op.create_index('uq_journal_entries_organization_id_reverses_entry_id', 'journal_entries', ['organization_id', 'reverses_entry_id'], unique=True, postgresql_where=sa.text('reverses_entry_id IS NOT NULL'))
    op.create_index('uq_journal_entries_organization_id_source_key', 'journal_entries', ['organization_id', 'source_key'], unique=True, postgresql_where=sa.text('source_key IS NOT NULL'))
    op.create_table('sync_events',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.Column('source', sa.String(length=12), nullable=False),
    sa.Column('event_key', sa.String(length=160), nullable=False),
    sa.Column('event_type', sa.String(length=30), nullable=False),
    sa.Column('event_time', sa.DateTime(timezone=True), nullable=False),
    sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('status', sa.String(length=10), server_default=sa.text("'pending'"), nullable=False),
    sa.Column('attempts', sa.Integer(), server_default=sa.text('0'), nullable=False),
    sa.Column('next_retry_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('last_error', sa.String(length=300), nullable=True),
    sa.Column('journal_entry_id', sa.Uuid(), nullable=True),
    sa.Column('processed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("source IN ('sales', 'purchasing')", name=op.f('ck_sync_events_source_valid')),
    sa.CheckConstraint("status IN ('pending', 'posted', 'skipped', 'failed')", name=op.f('ck_sync_events_status_valid')),
    sa.CheckConstraint('attempts >= 0', name=op.f('ck_sync_events_attempts_non_negative')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_sync_events')),
    sa.UniqueConstraint('organization_id', 'event_key', name='uq_sync_events_organization_id_event_key')
    )
    op.create_index('ix_sync_events_due', 'sync_events', ['status', 'next_retry_at'], unique=False)
    op.create_index('ix_sync_events_organization_id_event_time', 'sync_events', ['organization_id', 'event_time'], unique=False)
    op.create_table('sync_sources',
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.Column('source', sa.String(length=12), nullable=False),
    sa.Column('cursor_time', sa.DateTime(timezone=True), nullable=True),
    sa.Column('status', sa.String(length=8), server_default=sa.text("'idle'"), nullable=False),
    sa.Column('last_attempt_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_success_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_error', sa.String(length=300), nullable=True),
    sa.Column('consecutive_failures', sa.Integer(), server_default=sa.text('0'), nullable=False),
    sa.CheckConstraint("source IN ('sales', 'purchasing')", name=op.f('ck_sync_sources_source_valid')),
    sa.CheckConstraint("status IN ('idle', 'ok', 'error')", name=op.f('ck_sync_sources_status_valid')),
    sa.PrimaryKeyConstraint('organization_id', 'source', name=op.f('pk_sync_sources'))
    )
    op.create_table('expenses',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('number', sa.String(length=20), nullable=False),
    sa.Column('expense_date', sa.Date(), nullable=False),
    sa.Column('description', sa.String(length=500), nullable=False),
    sa.Column('reference', sa.String(length=100), nullable=True),
    sa.Column('vendor', sa.String(length=150), nullable=True),
    sa.Column('account_id', sa.Uuid(), nullable=False),
    sa.Column('amount', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('currency_code', sa.String(length=3), nullable=False),
    sa.Column('status', sa.String(length=10), server_default=sa.text("'draft'"), nullable=False),
    sa.Column('journal_entry_id', sa.Uuid(), nullable=True),
    sa.Column('reversal_entry_id', sa.Uuid(), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=False),
    sa.Column('created_by_email', sa.String(length=320), nullable=False),
    sa.Column('posted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('posted_by_email', sa.String(length=320), nullable=True),
    sa.Column('reversed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('reversed_by_email', sa.String(length=320), nullable=True),
    sa.Column('reversal_reason', sa.String(length=500), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name=op.f('ck_expenses_currency_code_valid')),
    sa.CheckConstraint("status <> 'reversed' OR reversal_entry_id IS NOT NULL", name=op.f('ck_expenses_reversed_has_entry')),
    sa.CheckConstraint("status = 'draft' OR journal_entry_id IS NOT NULL", name=op.f('ck_expenses_posted_has_entry')),
    sa.CheckConstraint("status IN ('draft', 'posted', 'reversed')", name=op.f('ck_expenses_status_valid')),
    sa.CheckConstraint('amount > 0', name=op.f('ck_expenses_amount_positive')),
    sa.CheckConstraint('length(btrim(description)) > 0', name=op.f('ck_expenses_description_not_blank')),
    sa.ForeignKeyConstraint(['organization_id', 'account_id'], ['accounts.organization_id', 'accounts.id'], name='fk_expenses_organization_id_accounts'),
    sa.ForeignKeyConstraint(['organization_id', 'journal_entry_id'], ['journal_entries.organization_id', 'journal_entries.id'], name='fk_expenses_organization_id_journal_entries'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_expenses')),
    sa.UniqueConstraint('organization_id', 'id', name='uq_expenses_organization_id_id'),
    sa.UniqueConstraint('organization_id', 'number', name='uq_expenses_organization_id_number')
    )
    op.create_index(op.f('ix_expenses_organization_id'), 'expenses', ['organization_id'], unique=False)
    op.create_index('ix_expenses_organization_id_expense_date', 'expenses', ['organization_id', 'expense_date'], unique=False)
    op.create_table('journal_lines',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('entry_id', sa.Uuid(), nullable=False),
    sa.Column('line_no', sa.Integer(), nullable=False),
    sa.Column('account_id', sa.Uuid(), nullable=False),
    sa.Column('debit', sa.Numeric(precision=18, scale=4), server_default=sa.text('0'), nullable=False),
    sa.Column('credit', sa.Numeric(precision=18, scale=4), server_default=sa.text('0'), nullable=False),
    sa.Column('description', sa.String(length=255), nullable=True),
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.CheckConstraint('(debit > 0) <> (credit > 0)', name=op.f('ck_journal_lines_exactly_one_side')),
    sa.CheckConstraint('debit >= 0 AND credit >= 0', name=op.f('ck_journal_lines_amounts_not_negative')),
    sa.ForeignKeyConstraint(['organization_id', 'account_id'], ['accounts.organization_id', 'accounts.id'], name='fk_journal_lines_organization_id_accounts'),
    sa.ForeignKeyConstraint(['organization_id', 'entry_id'], ['journal_entries.organization_id', 'journal_entries.id'], name='fk_journal_lines_organization_id_journal_entries', ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_journal_lines')),
    sa.UniqueConstraint('entry_id', 'line_no', name='uq_journal_lines_entry_id_line_no')
    )
    op.create_index(op.f('ix_journal_lines_organization_id'), 'journal_lines', ['organization_id'], unique=False)
    op.create_index('ix_journal_lines_organization_id_account_id', 'journal_lines', ['organization_id', 'account_id'], unique=False)

    for table, function, timing, body in GUARDS:
        op.execute(body)
        op.execute(f"CREATE TRIGGER trg_{function} {timing} ON {table} FOR EACH ROW EXECUTE FUNCTION {function}()")


def downgrade() -> None:
    for table, function, _timing, _body in reversed(GUARDS):
        op.execute(f"DROP TRIGGER IF EXISTS trg_{function} ON {table}")
        op.execute(f"DROP FUNCTION IF EXISTS {function}()")
    op.drop_index('ix_journal_lines_organization_id_account_id', table_name='journal_lines')
    op.drop_index(op.f('ix_journal_lines_organization_id'), table_name='journal_lines')
    op.drop_table('journal_lines')
    op.drop_index('ix_expenses_organization_id_expense_date', table_name='expenses')
    op.drop_index(op.f('ix_expenses_organization_id'), table_name='expenses')
    op.drop_table('expenses')
    op.drop_table('sync_sources')
    op.drop_index('ix_sync_events_organization_id_event_time', table_name='sync_events')
    op.drop_index('ix_sync_events_due', table_name='sync_events')
    op.drop_table('sync_events')
    op.drop_index('uq_journal_entries_organization_id_source_key', table_name='journal_entries', postgresql_where=sa.text('source_key IS NOT NULL'))
    op.drop_index('uq_journal_entries_organization_id_reverses_entry_id', table_name='journal_entries', postgresql_where=sa.text('reverses_entry_id IS NOT NULL'))
    op.drop_index('ix_journal_entries_organization_id_entry_date', table_name='journal_entries')
    op.drop_index(op.f('ix_journal_entries_organization_id'), table_name='journal_entries')
    op.drop_table('journal_entries')
    op.drop_table('finance_requests')
    op.drop_table('finance_organizations')
    op.drop_index('ix_finance_events_organization_id_seq', table_name='finance_events')
    op.drop_index('ix_finance_events_organization_id_entity_id', table_name='finance_events')
    op.drop_table('finance_events')
    op.drop_table('finance_counters')
    op.drop_index('uq_accounts_organization_id_system_key', table_name='accounts', postgresql_where=sa.text('system_key IS NOT NULL'))
    op.drop_index(op.f('ix_accounts_organization_id'), table_name='accounts')
    op.drop_table('accounts')
