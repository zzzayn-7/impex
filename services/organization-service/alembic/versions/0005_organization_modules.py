"""module management: per-organization entitlements and their append-only history

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-07
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# The history is append-only. The maintenance switch is the same out-of-band one the other services use for their own guarded tables:
# the application never sets it; the live verification scripts set it to delete their own throwaway organizations (and so, by cascade,
# the history rows of those organizations).
HISTORY_GUARD = """
CREATE FUNCTION organization_module_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_ledger_maintenance', true) = 'on' AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'the module history is append-only (% refused)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END
$$
"""


def upgrade() -> None:
    op.create_table(
        "organization_modules",
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("module_key", sa.String(length=30), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], name=op.f("fk_organization_modules_organization_id_organizations"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("organization_id", "module_key", name=op.f("pk_organization_modules")),
    )
    op.create_table(
        "organization_module_history",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("module_key", sa.String(length=30), nullable=False),
        sa.Column("action", sa.String(length=10), nullable=False),
        sa.Column("old_enabled", sa.Boolean(), nullable=True),
        sa.Column("new_enabled", sa.Boolean(), nullable=False),
        sa.Column("changed_by", sa.Uuid(), nullable=True),
        sa.Column("changed_by_name", sa.String(length=255), nullable=True),
        sa.Column("changed_by_email", sa.String(length=320), nullable=True),
        sa.Column("reason", sa.String(length=500), nullable=True),
        sa.Column("batch_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("action IN ('seeded', 'migrated', 'enabled', 'disabled')", name=op.f("ck_organization_module_history_action_valid")),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], name=op.f("fk_organization_module_history_organization_id_organizations"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_organization_module_history")),
    )
    op.create_index("ix_organization_module_history_organization_id_seq", "organization_module_history", ["organization_id", "seq"])

    # Every organization that exists TODAY keeps everything it could use before this release: Inventory, Purchasing and Sales are
    # enabled for it (nobody is locked out by the migration). Finance is planned and not available. The Super Admin can then switch off
    # what an organization does not use. Organizations created later start with Inventory only (app/modules.py).
    op.execute(
        """
        INSERT INTO organization_modules (organization_id, module_key, enabled, updated_at)
        SELECT o.id, m.key, m.enabled, now()
        FROM organizations o CROSS JOIN (VALUES ('inventory', true), ('purchasing', true), ('sales', true), ('finance', false)) AS m(key, enabled)
        """
    )
    op.execute(
        """
        INSERT INTO organization_module_history (organization_id, module_key, action, old_enabled, new_enabled, changed_by_name, reason, batch_id)
        SELECT o.id, m.key, 'migrated', NULL, m.enabled, 'System',
               'Existing organization: keeps the modules it could already use', o.id
        FROM organizations o CROSS JOIN (VALUES ('inventory', true), ('purchasing', true), ('sales', true), ('finance', false)) AS m(key, enabled)
        """
    )

    op.execute(HISTORY_GUARD)
    op.execute("CREATE TRIGGER organization_module_history_guard BEFORE UPDATE OR DELETE ON organization_module_history FOR EACH ROW EXECUTE FUNCTION organization_module_history_guard()")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS organization_module_history_guard ON organization_module_history")
    op.execute("DROP FUNCTION IF EXISTS organization_module_history_guard()")
    op.drop_index("ix_organization_module_history_organization_id_seq", table_name="organization_module_history")
    op.drop_table("organization_module_history")
    op.drop_table("organization_modules")
