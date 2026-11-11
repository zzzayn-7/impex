"""organization lock (payment overdue) and deletion: the lock columns and an append-only record of lifecycle events

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Append-only, like the module and settings history. The out-of-band maintenance switch (never set by the application) lets the live scripts remove the throwaway
# organizations they create. There is deliberately NO foreign key to organizations: the record that an organization was deleted must outlive the organization.
GUARD = """
CREATE FUNCTION organization_lifecycle_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_ledger_maintenance', true) = 'on' AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'the organization lifecycle record is append-only (% refused)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END
$$
"""


def upgrade() -> None:
    # Additive. Every existing organization is unlocked and not being deleted, so nothing changes for anybody until the Super Admin acts.
    op.add_column("organizations", sa.Column("is_locked", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("organizations", sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("organizations", sa.Column("locked_by", sa.Uuid(), nullable=True))
    op.add_column("organizations", sa.Column("lock_reason", sa.String(length=500), nullable=True))
    op.add_column("organizations", sa.Column("deletion_requested_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(op.f("ck_organizations_locked_has_a_time"), "organizations", "NOT is_locked OR locked_at IS NOT NULL")
    op.create_check_constraint(op.f("ck_organizations_deleting_means_locked"), "organizations", "deletion_requested_at IS NULL OR is_locked")

    op.create_table(
        "organization_lifecycle_events",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("organization_name", sa.String(length=255), nullable=False),
        sa.Column("organization_slug", sa.String(length=100), nullable=False),
        sa.Column("action", sa.String(length=20), nullable=False),
        sa.Column("reason", sa.String(length=500), nullable=True),
        sa.Column("details", sa.JSON(), nullable=True),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column("actor_name", sa.String(length=255), nullable=True),
        sa.Column("actor_email", sa.String(length=320), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("action IN ('locked', 'unlocked', 'deletion_started', 'deletion_failed', 'deleted')", name=op.f("ck_organization_lifecycle_events_action_valid")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_organization_lifecycle_events")),
    )
    op.create_index("ix_organization_lifecycle_events_organization_id_seq", "organization_lifecycle_events", ["organization_id", "seq"])
    op.execute(GUARD)
    op.execute("CREATE TRIGGER organization_lifecycle_events_guard BEFORE UPDATE OR DELETE ON organization_lifecycle_events FOR EACH ROW EXECUTE FUNCTION organization_lifecycle_events_guard()")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS organization_lifecycle_events_guard ON organization_lifecycle_events")
    op.execute("DROP FUNCTION IF EXISTS organization_lifecycle_events_guard()")
    op.drop_index("ix_organization_lifecycle_events_organization_id_seq", table_name="organization_lifecycle_events")
    op.drop_table("organization_lifecycle_events")
    op.drop_constraint(op.f("ck_organizations_deleting_means_locked"), "organizations", type_="check")
    op.drop_constraint(op.f("ck_organizations_locked_has_a_time"), "organizations", type_="check")
    for column in ("deletion_requested_at", "lock_reason", "locked_by", "locked_at", "is_locked"):
        op.drop_column("organizations", column)
