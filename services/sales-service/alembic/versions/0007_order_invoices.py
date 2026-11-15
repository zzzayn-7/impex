"""order invoices: the simple printable invoice of a prepared sales order

ADDITIVE. Two new tables; nothing existing is changed, so every older invoice, payment, order, delivery list and dispatch is exactly as it was.

  * order_invoices       one invoice per sales order (unique), made from the order's own lines at the prices agreed on it, with the client / seller / order details copied in. A
                         printable document: no draft step, no payments, no voiding, and it is not a financial event (the Finance feed only reads `invoices`).
  * order_invoice_lines  its lines (product, SKU, name, unit, quantity, unit price, line total), the total re-checked by the database.

Both are append-only (a trigger refuses UPDATE and DELETE; deleting is possible only in the out-of-band maintenance transaction that an organization purge uses, the same switch
the other ledgers have).

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-16
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

GUARD = """
CREATE FUNCTION order_invoices_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_ledger_maintenance', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are never edited or deleted', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END
$$
"""


def upgrade() -> None:
    op.create_table(
        "order_invoices",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("number", sa.String(length=32), nullable=False),
        sa.Column("invoice_date", sa.Date(), nullable=False),
        sa.Column("currency_code", sa.String(length=3), nullable=False),
        sa.Column("seller_name", sa.String(length=255), nullable=True),
        sa.Column("client_name", sa.String(length=255), nullable=False),
        sa.Column("client_address", sa.Text(), nullable=True),
        sa.Column("order_number", sa.String(length=32), nullable=False),
        sa.Column("delivery_list_number", sa.String(length=32), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("subtotal", sa.Numeric(18, 4), nullable=False),
        sa.Column("total", sa.Numeric(18, 4), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("created_by_email", sa.String(length=320), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["organization_id", "order_id"], ["sales_orders.organization_id", "sales_orders.id"], name=op.f("fk_order_invoices_order_same_organization"), ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["organization_id", "client_id"], ["clients.organization_id", "clients.id"], name=op.f("fk_order_invoices_client_same_organization"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_invoices")),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_order_invoices_organization_id_id")),
        sa.UniqueConstraint("organization_id", "number", name=op.f("uq_order_invoices_organization_id_number")),
        sa.UniqueConstraint("organization_id", "order_id", name=op.f("uq_order_invoices_organization_id_order_id")),
        sa.CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name=op.f("ck_order_invoices_currency_code_format")),
        sa.CheckConstraint("subtotal >= 0 AND total = subtotal", name=op.f("ck_order_invoices_total_matches")),
    )
    op.create_index(op.f("ix_order_invoices_organization_id"), "order_invoices", ["organization_id"], unique=False)
    op.create_index("ix_order_invoices_organization_id_client_id", "order_invoices", ["organization_id", "client_id"], unique=False)
    op.create_index("ix_order_invoices_organization_id_invoice_date", "order_invoices", ["organization_id", "invoice_date"], unique=False)

    op.create_table(
        "order_invoice_lines",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("invoice_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("product_sku", sa.String(length=64), nullable=False),
        sa.Column("product_name", sa.String(length=255), nullable=False),
        sa.Column("unit", sa.String(length=20), nullable=False),
        sa.Column("quantity", sa.Numeric(18, 4), nullable=False),
        sa.Column("unit_price", sa.Numeric(18, 4), nullable=False),
        sa.Column("line_total", sa.Numeric(18, 4), nullable=False),
        sa.ForeignKeyConstraint(["organization_id", "invoice_id"], ["order_invoices.organization_id", "order_invoices.id"], name=op.f("fk_order_invoice_lines_invoice_same_organization"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_invoice_lines")),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_order_invoice_lines_quantity_positive")),
        sa.CheckConstraint("unit_price >= 0", name=op.f("ck_order_invoice_lines_unit_price_non_negative")),
        sa.CheckConstraint("line_total = round(quantity * unit_price, 4)", name=op.f("ck_order_invoice_lines_total_matches")),
    )
    op.create_index(op.f("ix_order_invoice_lines_organization_id"), "order_invoice_lines", ["organization_id"], unique=False)
    op.create_index("ix_order_invoice_lines_organization_id_invoice_id", "order_invoice_lines", ["organization_id", "invoice_id"], unique=False)

    op.execute(GUARD)
    for table in ("order_invoices", "order_invoice_lines"):
        op.execute(f"CREATE TRIGGER trg_{table}_append_only BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION order_invoices_append_only()")


def downgrade() -> None:
    for table in ("order_invoice_lines", "order_invoices"):
        op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_append_only ON {table}")
    op.execute("DROP FUNCTION IF EXISTS order_invoices_append_only()")
    op.drop_table("order_invoice_lines")
    op.drop_table("order_invoices")
