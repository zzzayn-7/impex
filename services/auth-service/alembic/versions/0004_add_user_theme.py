"""add users.theme_background and users.theme_accent (each person's own colour theme for the portals)

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-09
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Additive and nullable: NULL means "never chosen", which the portals show as the original Impex theme. No existing row is changed, so every
    # account looks exactly as it did before until its owner picks something. Only identifiers of the approved palettes are stored (see app/theme.py).
    op.add_column("users", sa.Column("theme_background", sa.String(length=32), nullable=True))
    op.add_column("users", sa.Column("theme_accent", sa.String(length=32), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "theme_accent")
    op.drop_column("users", "theme_background")
