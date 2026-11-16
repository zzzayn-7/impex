"""order invoices: installments (up to five invoices for one order, the later ones dated in the future)

ADDITIVE for the data (two columns with a default, so every invoice that exists is "installment 1 of 1" exactly as before), and two constraints are replaced because they said "one
invoice per order" and "total = subtotal":

  * installment_no / installment_count   which of the order's invoices this is (1 of 1 for an invoice without installments, 1..5 of 2..5 with them);
  * `subtotal` stays the ORDER's total and `total` is what THIS invoice asks for (the whole order when there are no installments, a part of it otherwise);
  * one invoice per (order, installment number) instead of one per order.

The table is still append-only (the trigger from 0007); adding columns with a default fires nothing.

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-17
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("order_invoices", sa.Column("installment_no", sa.Integer(), server_default=sa.text("1"), nullable=False))
    op.add_column("order_invoices", sa.Column("installment_count", sa.Integer(), server_default=sa.text("1"), nullable=False))
    op.drop_constraint(op.f("uq_order_invoices_organization_id_order_id"), "order_invoices", type_="unique")
    op.drop_constraint(op.f("ck_order_invoices_total_matches"), "order_invoices", type_="check")
    op.create_unique_constraint(op.f("uq_order_invoices_organization_id_order_id_installment_no"), "order_invoices", ["organization_id", "order_id", "installment_no"])
    op.create_check_constraint(op.f("ck_order_invoices_installment_range"), "order_invoices", "installment_count BETWEEN 1 AND 5 AND installment_no BETWEEN 1 AND installment_count")
    op.create_check_constraint(op.f("ck_order_invoices_total_within_order"), "order_invoices", "subtotal >= 0 AND total >= 0 AND total <= subtotal AND (installment_count > 1 OR total = subtotal)")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_order_invoices_total_within_order"), "order_invoices", type_="check")
    op.drop_constraint(op.f("ck_order_invoices_installment_range"), "order_invoices", type_="check")
    op.drop_constraint(op.f("uq_order_invoices_organization_id_order_id_installment_no"), "order_invoices", type_="unique")
    op.create_check_constraint(op.f("ck_order_invoices_total_matches"), "order_invoices", "subtotal >= 0 AND total = subtotal")
    op.create_unique_constraint(op.f("uq_order_invoices_organization_id_order_id"), "order_invoices", ["organization_id", "order_id"])
    op.drop_column("order_invoices", "installment_count")
    op.drop_column("order_invoices", "installment_no")
