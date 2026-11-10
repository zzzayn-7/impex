"""client-specific selling prices on sales orders

Impex has no universal selling price for a product: every client is charged what is negotiated for THEIR order, and that agreed price is recorded when the
order is created. This migration is ADDITIVE and non-destructive:

  * sales_orders.currency_code   - the one currency of the order's prices (never converted). NULL for orders made before prices were recorded.
  * delivery_list_items.unit_price - the agreed price of ONE unit for this order line (a stable snapshot: a change to the product catalog never touches
                                    it). The order lines ARE the delivery-list items, so there is exactly one authoritative line record. NULL for
                                    orders / lists made before prices were recorded: their negotiated prices are unknown and are NOT invented.

No existing row is changed, so every older order, delivery list, dispatch, invoice and payment is exactly as it was.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sales_orders", sa.Column("currency_code", sa.String(length=3), nullable=True))
    op.create_check_constraint(op.f("ck_sales_orders_currency_code_format"), "sales_orders", "currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'")
    op.add_column("delivery_list_items", sa.Column("unit_price", sa.Numeric(18, 4), nullable=True))
    op.create_check_constraint(op.f("ck_delivery_list_items_unit_price_non_negative"), "delivery_list_items", "unit_price IS NULL OR unit_price >= 0")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_delivery_list_items_unit_price_non_negative"), "delivery_list_items", type_="check")
    op.drop_column("delivery_list_items", "unit_price")
    op.drop_constraint(op.f("ck_sales_orders_currency_code_format"), "sales_orders", type_="check")
    op.drop_column("sales_orders", "currency_code")
