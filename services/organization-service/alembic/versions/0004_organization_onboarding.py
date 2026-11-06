"""first-time organization setup: setup status and the company logo

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-07
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Additive. Every organization that exists TODAY is marked 'completed' (the column is added with that default, which
    # backfills the existing rows) so none of its administrators is sent through the wizard or locked out by this release.
    # The default is then switched to 'pending': every organization created from now on starts with setup incomplete.
    op.add_column("organizations", sa.Column("setup_status", sa.String(length=20), nullable=False, server_default=sa.text("'completed'")))
    op.add_column("organizations", sa.Column("setup_completed_at", sa.DateTime(timezone=True), nullable=True))
    # The Auth Service user who completed it (a plain id: the users live in another database). NULL for migrated organizations.
    op.add_column("organizations", sa.Column("setup_completed_by", sa.Uuid(), nullable=True))
    # The logo is a file in the logo storage (see app/storage.py); only its unpredictable key is stored here.
    op.add_column("organizations", sa.Column("logo_storage_key", sa.String(length=255), nullable=True))
    op.add_column("organizations", sa.Column("logo_content_type", sa.String(length=50), nullable=True))
    op.add_column("organizations", sa.Column("logo_updated_at", sa.DateTime(timezone=True), nullable=True))

    op.execute("UPDATE organizations SET setup_completed_at = now()")  # every row present now is an existing organization
    op.alter_column("organizations", "setup_status", server_default=sa.text("'pending'"))

    op.create_check_constraint(op.f("ck_organizations_setup_status_valid"), "organizations", "setup_status IN ('pending', 'in_progress', 'completed')")
    op.create_check_constraint(op.f("ck_organizations_completed_has_a_time"), "organizations", "setup_status <> 'completed' OR setup_completed_at IS NOT NULL")
    op.create_check_constraint(op.f("ck_organizations_logo_key_and_type_together"), "organizations", "(logo_storage_key IS NULL) = (logo_content_type IS NULL)")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_organizations_logo_key_and_type_together"), "organizations", type_="check")
    op.drop_constraint(op.f("ck_organizations_completed_has_a_time"), "organizations", type_="check")
    op.drop_constraint(op.f("ck_organizations_setup_status_valid"), "organizations", type_="check")
    for column in ("logo_updated_at", "logo_content_type", "logo_storage_key", "setup_completed_by", "setup_completed_at", "setup_status"):
        op.drop_column("organizations", column)
