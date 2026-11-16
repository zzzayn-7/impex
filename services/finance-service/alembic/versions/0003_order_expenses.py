"""order expenses: what an organization spends on one sales order, for the PNL calculator

ADDITIVE ONLY. One new table; nothing that exists is changed. It is a CALCULATOR's notes, not a ledger entry: it posts nothing to the journal and changes no capital, profit & loss
or accounting figure, so the rows may be edited (one row per organization and order, rewritten when the person saves again). The selling price is never stored here: it is the
order's own total, read from the Sales Service whenever it is shown.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-18
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "order_expenses",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("currency_code", sa.String(length=3), nullable=False),
        sa.Column("goods_cost", sa.Numeric(18, 4), server_default=sa.text("0"), nullable=False),
        sa.Column("delivery_charges", sa.Numeric(18, 4), server_default=sa.text("0"), nullable=False),
        sa.Column("other_expenses", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=False),
        sa.Column("updated_by_email", sa.String(length=320), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_expenses")),
        sa.UniqueConstraint("organization_id", "order_id", name=op.f("uq_order_expenses_organization_id_order_id")),
        sa.CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name=op.f("ck_order_expenses_currency_code_valid")),
        sa.CheckConstraint("goods_cost >= 0 AND delivery_charges >= 0", name=op.f("ck_order_expenses_amounts_not_negative")),
        sa.CheckConstraint("jsonb_typeof(other_expenses) = 'array' AND jsonb_array_length(other_expenses) <= 20", name=op.f("ck_order_expenses_other_expenses_list")),
    )
    op.create_index(op.f("ix_order_expenses_organization_id"), "order_expenses", ["organization_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_order_expenses_organization_id"), table_name="order_expenses")
    op.drop_table("order_expenses")
