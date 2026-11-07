"""organization settings: company details, business preferences, a settings version and an append-only change history

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-07
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DATE_FORMATS = "'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'"
NUMBER_FORMATS = "'comma_dot', 'dot_comma', 'space_comma', 'indian'"

# Same append-only rule (and the same out-of-band maintenance switch for the live scripts' throwaway organizations) as the module history.
HISTORY_GUARD = """
CREATE FUNCTION organization_settings_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_ledger_maintenance', true) = 'on' AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'the settings history is append-only (% refused)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END
$$
"""


def upgrade() -> None:
    # Additive. Every existing organization keeps its data exactly as it is: the new company fields are empty, and the preferences start at
    # the values the portal already used (US dollars, UTC, ISO dates, "1,234.56"), so nothing a person sees changes until they choose.
    for name, length in (("contact_phone", 40), ("address_street", 255), ("address_city", 120), ("address_state", 120), ("address_postal_code", 30), ("website", 255), ("description", 1000)):
        op.add_column("organizations", sa.Column(name, sa.String(length=length), nullable=True))
    op.add_column("organizations", sa.Column("default_currency", sa.String(length=3), nullable=False, server_default=sa.text("'USD'")))
    op.add_column("organizations", sa.Column("timezone", sa.String(length=64), nullable=False, server_default=sa.text("'UTC'")))
    op.add_column("organizations", sa.Column("date_format", sa.String(length=10), nullable=False, server_default=sa.text("'YYYY-MM-DD'")))
    op.add_column("organizations", sa.Column("number_format", sa.String(length=12), nullable=False, server_default=sa.text("'comma_dot'")))
    # Optimistic concurrency: every successful settings change adds one; a change must name the version it was made from.
    op.add_column("organizations", sa.Column("settings_version", sa.Integer(), nullable=False, server_default=sa.text("1")))
    op.add_column("organizations", sa.Column("settings_updated_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("organizations", sa.Column("settings_updated_by", sa.Uuid(), nullable=True))
    op.create_check_constraint(op.f("ck_organizations_default_currency_valid"), "organizations", "default_currency ~ '^[A-Z]{3}$'")
    op.create_check_constraint(op.f("ck_organizations_date_format_valid"), "organizations", f"date_format IN ({DATE_FORMATS})")
    op.create_check_constraint(op.f("ck_organizations_number_format_valid"), "organizations", f"number_format IN ({NUMBER_FORMATS})")
    op.create_check_constraint(op.f("ck_organizations_settings_version_positive"), "organizations", "settings_version >= 1")

    op.create_table(
        "organization_settings_history",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("section", sa.String(length=20), nullable=False),
        sa.Column("field", sa.String(length=40), nullable=False),
        sa.Column("old_value", sa.Text(), nullable=True),
        sa.Column("new_value", sa.Text(), nullable=True),
        sa.Column("changed_by", sa.Uuid(), nullable=True),
        sa.Column("changed_by_name", sa.String(length=255), nullable=True),
        sa.Column("changed_by_email", sa.String(length=320), nullable=True),
        sa.Column("source", sa.String(length=20), server_default=sa.text("'settings'"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),  # the settings version this change produced
        sa.Column("batch_id", sa.Uuid(), nullable=False),  # the fields saved together
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("section IN ('company', 'branding', 'preferences')", name=op.f("ck_organization_settings_history_section_valid")),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], name=op.f("fk_organization_settings_history_organization_id_organizations"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_organization_settings_history")),
    )
    op.create_index("ix_organization_settings_history_organization_id_seq", "organization_settings_history", ["organization_id", "seq"])
    op.execute(HISTORY_GUARD)
    op.execute("CREATE TRIGGER organization_settings_history_guard BEFORE UPDATE OR DELETE ON organization_settings_history FOR EACH ROW EXECUTE FUNCTION organization_settings_history_guard()")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS organization_settings_history_guard ON organization_settings_history")
    op.execute("DROP FUNCTION IF EXISTS organization_settings_history_guard()")
    op.drop_index("ix_organization_settings_history_organization_id_seq", table_name="organization_settings_history")
    op.drop_table("organization_settings_history")
    for name in ("settings_version_positive", "number_format_valid", "date_format_valid", "default_currency_valid"):
        op.drop_constraint(op.f(f"ck_organizations_{name}"), "organizations", type_="check")
    for column in ("settings_updated_by", "settings_updated_at", "settings_version", "number_format", "date_format", "timezone", "default_currency",
                   "description", "website", "address_postal_code", "address_state", "address_city", "address_street", "contact_phone"):
        op.drop_column("organizations", column)
