"""capital, investment and profit & loss: owner capital records, opening positions, actual inventory cost, delivery-recognised sales and their adjustments

ADDITIVE ONLY. Nothing that exists is changed except one CHECK constraint, widened to admit the new audit entity types (no row is touched): the chart of
accounts, the journal, expenses, the audit trail and the synchronisation inbox stay exactly as they are. Existing organizations simply start with empty new tables.
The only DROP statements are in `downgrade()`.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-11
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0002'
down_revision: Union[str, None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MAINTENANCE = "COALESCE(current_setting('app.allow_ledger_maintenance', true), '') = 'on'"  # NULL-safe, as in 0001

OLD_ENTITY_TYPES = "entity_type IN ('account', 'journal_entry', 'expense', 'sync')"
NEW_ENTITY_TYPES = "entity_type IN ('account', 'journal_entry', 'expense', 'sync', 'capital_record', 'opening', 'delivery', 'cost_basis')"

# Rows that record a fact are never edited or deleted (a mistake is a new, opposite row).
APPEND_ONLY = f"""
CREATE FUNCTION trading_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND {MAINTENANCE} THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'A recorded financial fact can never be changed or deleted: record a correcting entry instead';
END $$;
"""

# A recognised delivery keeps its identity, quantity and moment for ever. Its price and cost may be SETTLED once (while missing); once settled they are final.
DELIVERIES_GUARD = f"""
CREATE FUNCTION trade_deliveries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF {MAINTENANCE} THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'A recognised delivery can never be deleted';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.id <> OLD.id OR NEW.source_key <> OLD.source_key OR NEW.dispatch_id <> OLD.dispatch_id
     OR NEW.dispatch_line_id <> OLD.dispatch_line_id OR NEW.dispatch_number <> OLD.dispatch_number OR NEW.order_number IS DISTINCT FROM OLD.order_number
     OR NEW.client_name <> OLD.client_name OR NEW.product_id <> OLD.product_id OR NEW.quantity <> OLD.quantity OR NEW.delivered_at <> OLD.delivered_at THEN
    RAISE EXCEPTION 'A recognised delivery cannot be rewritten';
  END IF;
  IF OLD.unit_price IS NOT NULL AND (NEW.unit_price IS DISTINCT FROM OLD.unit_price OR NEW.currency_code IS DISTINCT FROM OLD.currency_code) THEN
    RAISE EXCEPTION 'The price of a recognised delivery is final';
  END IF;
  IF OLD.cogs IS NOT NULL AND NEW.cogs IS DISTINCT FROM OLD.cogs THEN RAISE EXCEPTION 'The cost of a recognised delivery is final'; END IF;
  RETURN NEW;
END $$;
"""

# An opening position is only ever reversed (active -> reversed, with who and why); its figures never change.
POSITIONS_GUARD = f"""
CREATE FUNCTION opening_positions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF {MAINTENANCE} THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'An opening position can never be deleted: reverse it instead';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.id <> OLD.id OR NEW.currency_code <> OLD.currency_code OR NEW.effective_date <> OLD.effective_date
     OR NEW.assets <> OLD.assets OR NEW.liabilities <> OLD.liabilities OR NEW.equity <> OLD.equity OR NEW.notes IS DISTINCT FROM OLD.notes THEN
    RAISE EXCEPTION 'An opening position can never be changed: reverse it and record a new one';
  END IF;
  IF OLD.status = 'reversed' AND (NEW.status <> 'reversed' OR NEW.reversal_reason IS DISTINCT FROM OLD.reversal_reason OR NEW.reversed_at IS DISTINCT FROM OLD.reversed_at) THEN
    RAISE EXCEPTION 'A reversed opening position stays reversed';
  END IF;
  RETURN NEW;
END $$;
"""

GUARDS = (
    ("capital_records", "trading_append_only", "BEFORE UPDATE OR DELETE", None),
    ("cost_entries", "trading_append_only", "BEFORE UPDATE OR DELETE", None),
    ("trade_adjustments", "trading_append_only", "BEFORE UPDATE OR DELETE", None),
    ("trade_deliveries", "trade_deliveries_guard", "BEFORE UPDATE OR DELETE", DELIVERIES_GUARD),
    ("opening_positions", "opening_positions_guard", "BEFORE UPDATE OR DELETE", POSITIONS_GUARD),
)


def upgrade() -> None:
    op.drop_constraint(op.f('ck_finance_events_entity_type_valid'), 'finance_events', type_='check')
    op.create_check_constraint(op.f('ck_finance_events_entity_type_valid'), 'finance_events', NEW_ENTITY_TYPES)

    op.create_table('inventory_costs',
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.Column('product_id', sa.Uuid(), nullable=False),
    sa.Column('currency_code', sa.String(length=3), nullable=False),
    sa.Column('product_sku', sa.String(length=64), nullable=False),
    sa.Column('product_name', sa.String(length=255), nullable=False),
    sa.Column('quantity', sa.Numeric(precision=18, scale=4), server_default=sa.text('0'), nullable=False),
    sa.Column('total_value', sa.Numeric(precision=18, scale=4), server_default=sa.text('0'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('quantity >= 0 AND total_value >= 0', name=op.f('ck_inventory_costs_not_negative')),
    sa.CheckConstraint('quantity > 0 OR total_value = 0', name=op.f('ck_inventory_costs_empty_stock_has_no_value')),
    sa.CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name=op.f('ck_inventory_costs_currency_code_valid')),
    sa.PrimaryKeyConstraint('organization_id', 'product_id', 'currency_code', name=op.f('pk_inventory_costs'))
    )

    op.create_table('cost_entries',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('source_key', sa.String(length=160), nullable=False),
    sa.Column('kind', sa.String(length=10), nullable=False),
    sa.Column('product_id', sa.Uuid(), nullable=False),
    sa.Column('product_sku', sa.String(length=64), nullable=False),
    sa.Column('product_name', sa.String(length=255), nullable=False),
    sa.Column('currency_code', sa.String(length=3), nullable=False),
    sa.Column('quantity', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('value', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('quantity_after', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('value_after', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('effective_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('reference', sa.String(length=100), nullable=True),
    sa.Column('counterparty', sa.String(length=150), nullable=True),
    sa.Column('detail', sa.String(length=300), nullable=True),
    sa.Column('link_id', sa.Uuid(), nullable=True),
    sa.Column('created_by_email', sa.String(length=320), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.CheckConstraint("kind IN ('basis', 'receipt', 'delivery')", name=op.f('ck_cost_entries_kind_valid')),
    sa.CheckConstraint('quantity > 0 AND value >= 0', name=op.f('ck_cost_entries_amounts_valid')),
    sa.CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name=op.f('ck_cost_entries_currency_code_valid')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_cost_entries')),
    sa.UniqueConstraint('organization_id', 'source_key', name='uq_cost_entries_organization_id_source_key')
    )
    op.create_index(op.f('ix_cost_entries_organization_id'), 'cost_entries', ['organization_id'], unique=False)
    op.create_index('ix_cost_entries_organization_id_effective_at', 'cost_entries', ['organization_id', 'effective_at'], unique=False)
    op.create_index('ix_cost_entries_organization_id_product_id', 'cost_entries', ['organization_id', 'product_id'], unique=False)

    op.create_table('trade_deliveries',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('source_key', sa.String(length=160), nullable=False),
    sa.Column('dispatch_id', sa.Uuid(), nullable=False),
    sa.Column('dispatch_line_id', sa.Uuid(), nullable=False),
    sa.Column('dispatch_number', sa.String(length=32), nullable=False),
    sa.Column('order_number', sa.String(length=32), nullable=True),
    sa.Column('client_name', sa.String(length=255), nullable=False),
    sa.Column('product_id', sa.Uuid(), nullable=False),
    sa.Column('product_sku', sa.String(length=64), nullable=False),
    sa.Column('product_name', sa.String(length=255), nullable=False),
    sa.Column('quantity', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('currency_code', sa.String(length=3), nullable=True),
    sa.Column('unit_price', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('revenue', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('cogs', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('note', sa.String(length=300), nullable=True),
    sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('reconciled_by_email', sa.String(length=320), nullable=True),
    sa.Column('reconciled_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.CheckConstraint("status IN ('recognized', 'needs_cost', 'needs_price')", name=op.f('ck_trade_deliveries_status_valid')),
    sa.CheckConstraint('quantity > 0', name=op.f('ck_trade_deliveries_quantity_positive')),
    sa.CheckConstraint("currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'", name=op.f('ck_trade_deliveries_currency_code_valid')),
    sa.CheckConstraint('(unit_price IS NULL) = (revenue IS NULL)', name=op.f('ck_trade_deliveries_price_and_revenue_together')),
    sa.CheckConstraint('unit_price IS NULL OR (unit_price >= 0 AND currency_code IS NOT NULL)', name=op.f('ck_trade_deliveries_price_has_currency')),
    sa.CheckConstraint('cogs IS NULL OR cogs >= 0', name=op.f('ck_trade_deliveries_cogs_not_negative')),
    sa.CheckConstraint("(status = 'needs_price' AND revenue IS NULL) OR (status = 'needs_cost' AND revenue IS NOT NULL AND cogs IS NULL) OR (status = 'recognized' AND revenue IS NOT NULL AND cogs IS NOT NULL)", name=op.f('ck_trade_deliveries_status_matches_amounts')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_trade_deliveries')),
    sa.UniqueConstraint('organization_id', 'id', name='uq_trade_deliveries_organization_id_id'),
    sa.UniqueConstraint('organization_id', 'source_key', name='uq_trade_deliveries_organization_id_source_key')
    )
    op.create_index(op.f('ix_trade_deliveries_organization_id'), 'trade_deliveries', ['organization_id'], unique=False)
    op.create_index('ix_trade_deliveries_organization_id_delivered_at', 'trade_deliveries', ['organization_id', 'delivered_at'], unique=False)
    op.create_index('ix_trade_deliveries_organization_id_product_id', 'trade_deliveries', ['organization_id', 'product_id'], unique=False)
    op.create_index('ix_trade_deliveries_organization_id_status', 'trade_deliveries', ['organization_id', 'status'], unique=False)

    op.create_table('trade_adjustments',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('source_key', sa.String(length=160), nullable=False),
    sa.Column('kind', sa.String(length=30), nullable=False),
    sa.Column('invoice_id', sa.Uuid(), nullable=False),
    sa.Column('delivery_id', sa.Uuid(), nullable=False),
    sa.Column('reference', sa.String(length=32), nullable=False),
    sa.Column('description', sa.String(length=300), nullable=False),
    sa.Column('amount', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('currency_code', sa.String(length=3), nullable=False),
    sa.Column('effective_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('reverses_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.CheckConstraint("kind IN ('invoice_adjustment', 'invoice_adjustment_reversal')", name=op.f('ck_trade_adjustments_kind_valid')),
    sa.CheckConstraint('amount <> 0', name=op.f('ck_trade_adjustments_amount_not_zero')),
    sa.CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name=op.f('ck_trade_adjustments_currency_code_valid')),
    sa.CheckConstraint("(kind = 'invoice_adjustment_reversal') = (reverses_id IS NOT NULL)", name=op.f('ck_trade_adjustments_reversal_names_its_original')),
    sa.ForeignKeyConstraint(['organization_id', 'reverses_id'], ['trade_adjustments.organization_id', 'trade_adjustments.id'], name='fk_trade_adjustments_organization_id_trade_adjustments'),
    sa.ForeignKeyConstraint(['organization_id', 'delivery_id'], ['trade_deliveries.organization_id', 'trade_deliveries.id'], name='fk_trade_adjustments_organization_id_trade_deliveries'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_trade_adjustments')),
    sa.UniqueConstraint('organization_id', 'id', name='uq_trade_adjustments_organization_id_id'),
    sa.UniqueConstraint('organization_id', 'source_key', name='uq_trade_adjustments_organization_id_source_key')
    )
    op.create_index(op.f('ix_trade_adjustments_organization_id'), 'trade_adjustments', ['organization_id'], unique=False)
    op.create_index('ix_trade_adjustments_organization_id_effective_at', 'trade_adjustments', ['organization_id', 'effective_at'], unique=False)
    op.create_index('ix_trade_adjustments_organization_id_invoice_id', 'trade_adjustments', ['organization_id', 'invoice_id'], unique=False)

    op.create_table('capital_records',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('kind', sa.String(length=12), nullable=False),
    sa.Column('entry_type', sa.String(length=10), nullable=False),
    sa.Column('is_reversal', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    sa.Column('reverses_id', sa.Uuid(), nullable=True),
    sa.Column('amount', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('effect', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('currency_code', sa.String(length=3), nullable=False),
    sa.Column('effective_date', sa.Date(), nullable=False),
    sa.Column('description', sa.String(length=500), nullable=False),
    sa.Column('reference', sa.String(length=100), nullable=True),
    sa.Column('notes', sa.String(length=500), nullable=True),
    sa.Column('reversal_reason', sa.String(length=500), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=False),
    sa.Column('created_by_email', sa.String(length=320), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.CheckConstraint("kind IN ('contribution', 'withdrawal')", name=op.f('ck_capital_records_kind_valid')),
    sa.CheckConstraint("entry_type IN ('cash', 'asset', 'inventory')", name=op.f('ck_capital_records_entry_type_valid')),
    sa.CheckConstraint('amount > 0', name=op.f('ck_capital_records_amount_positive')),
    sa.CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name=op.f('ck_capital_records_currency_code_valid')),
    sa.CheckConstraint('(reverses_id IS NOT NULL) = is_reversal', name=op.f('ck_capital_records_reversal_names_its_original')),
    sa.CheckConstraint("effect = amount * (CASE WHEN kind = 'contribution' THEN 1 ELSE -1 END) * (CASE WHEN is_reversal THEN -1 ELSE 1 END)", name=op.f('ck_capital_records_effect_matches')),
    sa.CheckConstraint('NOT is_reversal OR (reversal_reason IS NOT NULL AND length(btrim(reversal_reason)) > 0)', name=op.f('ck_capital_records_reversal_has_reason')),
    sa.ForeignKeyConstraint(['organization_id', 'reverses_id'], ['capital_records.organization_id', 'capital_records.id'], name='fk_capital_records_organization_id_capital_records'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_capital_records')),
    sa.UniqueConstraint('organization_id', 'id', name='uq_capital_records_organization_id_id'),
    sa.UniqueConstraint('organization_id', 'reverses_id', name='uq_capital_records_organization_id_reverses_id')
    )
    op.create_index(op.f('ix_capital_records_organization_id'), 'capital_records', ['organization_id'], unique=False)
    op.create_index('ix_capital_records_organization_id_effective_date', 'capital_records', ['organization_id', 'effective_date'], unique=False)

    op.create_table('opening_positions',
    sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('currency_code', sa.String(length=3), nullable=False),
    sa.Column('effective_date', sa.Date(), nullable=False),
    sa.Column('assets', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('liabilities', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('equity', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('notes', sa.String(length=500), nullable=True),
    sa.Column('status', sa.String(length=10), server_default=sa.text("'active'"), nullable=False),
    sa.Column('reversed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('reversed_by_email', sa.String(length=320), nullable=True),
    sa.Column('reversal_reason', sa.String(length=500), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=False),
    sa.Column('created_by_email', sa.String(length=320), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('organization_id', sa.Uuid(), nullable=False),
    sa.CheckConstraint("status IN ('active', 'reversed')", name=op.f('ck_opening_positions_status_valid')),
    sa.CheckConstraint('assets >= 0 AND liabilities >= 0', name=op.f('ck_opening_positions_amounts_not_negative')),
    sa.CheckConstraint('equity = assets - liabilities', name=op.f('ck_opening_positions_equity_matches')),
    sa.CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name=op.f('ck_opening_positions_currency_code_valid')),
    sa.CheckConstraint("status = 'active' OR (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL)", name=op.f('ck_opening_positions_reversed_has_reason')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_opening_positions')),
    sa.UniqueConstraint('organization_id', 'id', name='uq_opening_positions_organization_id_id')
    )
    op.create_index(op.f('ix_opening_positions_organization_id'), 'opening_positions', ['organization_id'], unique=False)
    op.create_index('uq_opening_positions_organization_id_active_currency', 'opening_positions', ['organization_id', 'currency_code'], unique=True, postgresql_where=sa.text("status = 'active'"))

    # Confirmed dispatches (the moment revenue is recognised) are a NEW kind of event in the Sales feed. Reading the feed again from Finance's activation brings in the
    # ones that happened since: each is stored under its unique key, so everything already received is simply ignored. This changes a reading position, not a record.
    op.execute("UPDATE sync_sources SET cursor_time = NULL WHERE source = 'sales'")

    created = set()
    for table, function, timing, body in GUARDS:
        if function not in created:
            op.execute(body or APPEND_ONLY)
            created.add(function)
        op.execute(f"CREATE TRIGGER trg_{table}_{function} {timing} ON {table} FOR EACH ROW EXECUTE FUNCTION {function}()")


def downgrade() -> None:
    for table, function, _timing, _body in reversed(GUARDS):
        op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_{function} ON {table}")
    for function in ("trading_append_only", "trade_deliveries_guard", "opening_positions_guard"):
        op.execute(f"DROP FUNCTION IF EXISTS {function}()")
    op.drop_index('uq_opening_positions_organization_id_active_currency', table_name='opening_positions', postgresql_where=sa.text("status = 'active'"))
    op.drop_index(op.f('ix_opening_positions_organization_id'), table_name='opening_positions')
    op.drop_table('opening_positions')
    op.drop_index('ix_capital_records_organization_id_effective_date', table_name='capital_records')
    op.drop_index(op.f('ix_capital_records_organization_id'), table_name='capital_records')
    op.drop_table('capital_records')
    op.drop_index('ix_trade_adjustments_organization_id_invoice_id', table_name='trade_adjustments')
    op.drop_index('ix_trade_adjustments_organization_id_effective_at', table_name='trade_adjustments')
    op.drop_index(op.f('ix_trade_adjustments_organization_id'), table_name='trade_adjustments')
    op.drop_table('trade_adjustments')
    op.drop_index('ix_trade_deliveries_organization_id_status', table_name='trade_deliveries')
    op.drop_index('ix_trade_deliveries_organization_id_product_id', table_name='trade_deliveries')
    op.drop_index('ix_trade_deliveries_organization_id_delivered_at', table_name='trade_deliveries')
    op.drop_index(op.f('ix_trade_deliveries_organization_id'), table_name='trade_deliveries')
    op.drop_table('trade_deliveries')
    op.drop_index('ix_cost_entries_organization_id_product_id', table_name='cost_entries')
    op.drop_index('ix_cost_entries_organization_id_effective_at', table_name='cost_entries')
    op.drop_index(op.f('ix_cost_entries_organization_id'), table_name='cost_entries')
    op.drop_table('cost_entries')
    op.drop_table('inventory_costs')
    op.drop_constraint(op.f('ck_finance_events_entity_type_valid'), 'finance_events', type_='check')
    op.create_check_constraint(op.f('ck_finance_events_entity_type_valid'), 'finance_events', OLD_ENTITY_TYPES)
