"""add users.avatar_png and users.avatar_updated_at (each person's own profile picture)

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Additive and nullable: NULL means "no picture", which the portals show as the person's initials. No existing row is changed. What is stored is never
    # an upload: it is a small square PNG re-encoded from the decoded pixels (see app/avatar.py).
    op.add_column("users", sa.Column("avatar_png", sa.LargeBinary(), nullable=True))
    op.add_column("users", sa.Column("avatar_updated_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "avatar_updated_at")
    op.drop_column("users", "avatar_png")
