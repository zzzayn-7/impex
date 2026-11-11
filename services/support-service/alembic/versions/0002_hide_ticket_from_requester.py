"""a requester can delete a ticket from THEIR side

Additive. The ticket, its messages, its audit events and its notification records are untouched (they are never deleted): the column only records that the
organization no longer wants to see the ticket in its own Help & Support list. The Super Admin still sees it, exactly as before.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("support_tickets", sa.Column("hidden_by_organization_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("support_tickets", "hidden_by_organization_at")
