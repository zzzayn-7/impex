"""client-dispatch posting: a new operation kind, and a second kind of movement source

Additive only (no row is touched):
  * stock_operations.kind also allows 'dispatch';
  * stock_movements.source_type also allows 'client_dispatch' (a dispatch line of the Sales Service). The check is rewritten so that
    a goods-receipt movement is always an 'in' and a client-dispatch movement is always an 'out' - the source can never contradict
    the direction of the stock movement.
The partial unique index from 0005 (organization, source_type, source_line_id) already guarantees that one dispatch line can
produce AT MOST ONE movement, so even a caller using a different idempotency key could never deduct the same goods twice.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-09
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_stock_operations_kind_valid"), "stock_operations", type_="check")
    op.create_check_constraint(op.f("ck_stock_operations_kind_valid"), "stock_operations", "kind IN ('opening', 'in', 'out', 'transfer', 'receipt', 'dispatch')")
    op.drop_constraint(op.f("ck_stock_movements_source_consistent"), "stock_movements", type_="check")
    op.create_check_constraint(
        op.f("ck_stock_movements_source_consistent"), "stock_movements",
        "(source_type IS NULL AND source_reference IS NULL AND source_line_id IS NULL) OR "
        "(source_type = 'goods_receipt' AND movement_type = 'in' AND source_reference IS NOT NULL AND source_line_id IS NOT NULL) OR "
        "(source_type = 'client_dispatch' AND movement_type = 'out' AND source_reference IS NOT NULL AND source_line_id IS NOT NULL)",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_stock_movements_source_consistent"), "stock_movements", type_="check")
    op.create_check_constraint(
        op.f("ck_stock_movements_source_consistent"), "stock_movements",
        "(source_type IS NULL AND source_reference IS NULL AND source_line_id IS NULL) OR "
        "(source_type = 'goods_receipt' AND source_reference IS NOT NULL AND source_line_id IS NOT NULL)",
    )
    op.drop_constraint(op.f("ck_stock_operations_kind_valid"), "stock_operations", type_="check")
    op.create_check_constraint(op.f("ck_stock_operations_kind_valid"), "stock_operations", "kind IN ('opening', 'in', 'out', 'transfer', 'receipt')")
