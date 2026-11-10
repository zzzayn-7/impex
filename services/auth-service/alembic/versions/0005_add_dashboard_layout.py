"""add users.dashboard_layout (each person's own home-page widget arrangement for their portal)

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Additive and nullable: NULL means "never customised", which the portals show as every authorized widget in the default order. No existing row is
    # changed, so every account's home page looks exactly as it did until its owner removes or moves a card. Only widget identifiers and a revision
    # counter are stored (see app/dashboard_layout.py): never HTML, CSS or components.
    op.add_column("users", sa.Column("dashboard_layout", postgresql.JSONB(astext_type=sa.Text()), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "dashboard_layout")
