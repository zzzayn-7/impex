"""goods-receipt posting: a new operation kind, and a source reference on stock movements

Additive only:
  * stock_operations.kind also allows 'receipt' (the check constraint is replaced by a wider one);
  * stock_movements gets three NULLABLE columns that say where a movement came from (a goods receipt line of another service);
  * a partial unique index guarantees that one source line can produce AT MOST ONE movement, so even a bug in a caller
    that used a different idempotency key could never add the same received goods to stock twice.
Existing rows are untouched. (The ledger's append-only trigger only blocks UPDATE and DELETE; adding columns is unaffected.)

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-07
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_stock_operations_kind_valid"), "stock_operations", type_="check")
    op.create_check_constraint(op.f("ck_stock_operations_kind_valid"), "stock_operations", "kind IN ('opening', 'in', 'out', 'transfer', 'receipt')")

    op.add_column("stock_movements", sa.Column("source_type", sa.String(length=30), nullable=True))
    op.add_column("stock_movements", sa.Column("source_reference", sa.String(length=100), nullable=True))
    op.add_column("stock_movements", sa.Column("source_line_id", sa.Uuid(), nullable=True))
    op.create_check_constraint(
        op.f("ck_stock_movements_source_consistent"), "stock_movements",
        "(source_type IS NULL AND source_reference IS NULL AND source_line_id IS NULL) OR "
        "(source_type = 'goods_receipt' AND source_reference IS NOT NULL AND source_line_id IS NOT NULL)",
    )
    op.create_index(
        "uq_stock_movements_source_line", "stock_movements", ["organization_id", "source_type", "source_line_id"],
        unique=True, postgresql_where=sa.text("source_line_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_stock_movements_source_line", table_name="stock_movements")
    op.drop_constraint(op.f("ck_stock_movements_source_consistent"), "stock_movements", type_="check")
    op.drop_column("stock_movements", "source_line_id")
    op.drop_column("stock_movements", "source_reference")
    op.drop_column("stock_movements", "source_type")
    op.drop_constraint(op.f("ck_stock_operations_kind_valid"), "stock_operations", type_="check")
    op.create_check_constraint(op.f("ck_stock_operations_kind_valid"), "stock_operations", "kind IN ('opening', 'in', 'out', 'transfer')")
