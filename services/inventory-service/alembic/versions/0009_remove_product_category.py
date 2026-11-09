"""remove product categories

DESTRUCTIVE and IRREVERSIBLE (it was requested explicitly: the business deals only in hardware products, so "category" is removed everywhere).
Take a backup first (pg_dump of impex_inventory). It drops products.category and its index, in one transaction. Nothing else changes: products,
SKUs, prices, units, stock balances, the stock ledger and the reservations are untouched.

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-09
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index("ix_products_organization_id_category", table_name="products")
    op.drop_column("products", "category")


def downgrade() -> None:
    raise RuntimeError(
        "Removing product categories cannot be reversed: the category of every product was deleted. "
        "Restore the pre-migration backup of impex_inventory instead."
    )
