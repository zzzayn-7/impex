"""hidden movements: a movement can be taken off the Stock Movements page without touching the ledger

Additive. The stock ledger (`stock_movements`) stays append-only and exactly as it is: balances, `balance_after` and every report are unchanged. A row here only
says "this organization no longer wants to see this movement on its Movements page"; the movement itself is never edited or deleted.

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: Union[str, None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "hidden_movements",
        sa.Column("movement_id", sa.Uuid(), nullable=False),
        sa.Column("hidden_by", sa.Uuid(), nullable=False),
        sa.Column("hidden_by_email", sa.String(length=320), nullable=False),
        sa.Column("hidden_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(["movement_id"], ["stock_movements.id"], name=op.f("fk_hidden_movements_movement_id_stock_movements"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("organization_id", "movement_id", name=op.f("pk_hidden_movements")),
    )
    op.create_index(op.f("ix_hidden_movements_organization_id"), "hidden_movements", ["organization_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_hidden_movements_organization_id"), table_name="hidden_movements")
    op.drop_table("hidden_movements")
