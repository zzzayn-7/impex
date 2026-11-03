"""allow several administrators per organization; store the invited name

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-04
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

PENDING = "accepted_at IS NULL AND revoked_at IS NULL"


def upgrade() -> None:
    op.add_column("organization_invitations", sa.Column("full_name", sa.String(length=255), nullable=True))
    # Was: one pending invitation per organization. Now: one per organization AND email.
    # Existing data satisfies the new, weaker rule, so this cannot fail.
    op.drop_index("uq_organization_invitations_pending", table_name="organization_invitations")
    op.create_index(
        "uq_organization_invitations_pending",
        "organization_invitations",
        ["organization_id", "email"],
        unique=True,
        postgresql_where=sa.text(PENDING),
    )


def downgrade() -> None:
    # Only safe while every organization has at most one pending invitation.
    op.drop_index("uq_organization_invitations_pending", table_name="organization_invitations")
    op.create_index(
        "uq_organization_invitations_pending",
        "organization_invitations",
        ["organization_id"],
        unique=True,
        postgresql_where=sa.text(PENDING),
    )
    op.drop_column("organization_invitations", "full_name")
