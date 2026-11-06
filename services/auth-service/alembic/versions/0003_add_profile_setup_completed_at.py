"""add users.profile_setup_completed_at (first-time onboarding of organization administrators)

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-07
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Additive and nullable. NULL means "this person has not confirmed their profile yet": every administrator created
    # from now on starts that way. Accounts that exist TODAY are marked as already set up, so nobody who can sign in
    # now is sent through the first-time wizard or locked out by this release.
    op.add_column("users", sa.Column("profile_setup_completed_at", sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE users SET profile_setup_completed_at = now() WHERE profile_setup_completed_at IS NULL")


def downgrade() -> None:
    op.drop_column("users", "profile_setup_completed_at")
