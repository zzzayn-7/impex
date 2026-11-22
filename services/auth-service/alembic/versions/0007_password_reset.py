"""password reset by the Super Admin: a temporary password that must be replaced at the first sign-in

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-22
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Additive. Every existing account keeps its password and is "not required to change it" (false), so nobody is affected until the Super Admin resets a password.
    op.add_column("users", sa.Column("must_change_password", sa.Boolean(), server_default=sa.text("false"), nullable=False))
    # When the password last changed: a sign-in (token) made with an earlier password is no longer accepted, so resetting a forgotten or compromised password also ends every old session.
    op.add_column("users", sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=True))
    # A temporary password works until this moment (24 hours after it was sent); after it the person must ask for a new reset.
    op.add_column("users", sa.Column("password_reset_expires_at", sa.DateTime(timezone=True), nullable=True))
    # When the last reset was sent: the Super Admin cannot send another within a minute (no mail flooding).
    op.add_column("users", sa.Column("password_reset_sent_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "password_reset_sent_at")
    op.drop_column("users", "password_reset_expires_at")
    op.drop_column("users", "password_changed_at")
    op.drop_column("users", "must_change_password")
