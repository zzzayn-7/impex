"""a product no longer needs a selling price

Impex has no universal selling price: each client is charged what is negotiated for THEIR order, and that price is recorded on the Sales Order line
(Sales Service, migration 0006). A product can therefore be registered and stocked without one.

Non-destructive: the column stays and every existing value is kept exactly as it is (it is only no longer required). New products simply have NULL.
The `selling_price >= 0` check still guards any value that is stored (a NULL passes it).

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("products", "selling_price", existing_type=sa.Numeric(14, 4), nullable=True)


def downgrade() -> None:
    # Re-requiring the price is only possible while every product has one; products registered without a price are given 0 (a stored, explicit zero).
    op.execute("UPDATE products SET selling_price = 0 WHERE selling_price IS NULL")
    op.alter_column("products", "selling_price", existing_type=sa.Numeric(14, 4), nullable=False)
