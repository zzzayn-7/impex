"""create products table

Revision ID: 0001
Revises:
Create Date: 2026-11-04
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "products",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("sku", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("category", sa.String(length=100), nullable=False),
        sa.Column("unit", sa.String(length=20), nullable=False),
        sa.Column("hs_code", sa.String(length=16), nullable=True),
        sa.Column("cost_price", sa.Numeric(precision=14, scale=4), nullable=False),
        sa.Column("selling_price", sa.Numeric(precision=14, scale=4), nullable=False),
        sa.Column("currency_code", sa.String(length=3), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("cost_price >= 0", name=op.f("ck_products_cost_price_non_negative")),
        sa.CheckConstraint("selling_price >= 0", name=op.f("ck_products_selling_price_non_negative")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_products")),
        sa.UniqueConstraint("organization_id", "sku", name="uq_products_organization_id_sku"),
    )
    op.create_index(op.f("ix_products_organization_id"), "products", ["organization_id"], unique=False)
    op.create_index("ix_products_organization_id_category", "products", ["organization_id", "category"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_products_organization_id_category", table_name="products")
    op.drop_index(op.f("ix_products_organization_id"), table_name="products")
    op.drop_table("products")
