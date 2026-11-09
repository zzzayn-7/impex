"""stock reservations: stock committed to sales orders, kept by the Inventory Service

Additive. No existing row is changed: every balance starts with nothing reserved, so on-hand and available stock are equal until
the first order is booked.

  * stock_balances.reserved_quantity - how much of the product's stock is committed to active sales orders (the sum of the
    `remaining_quantity` of its active reservations; the application keeps them equal inside one transaction, under the balance's row
    lock). Two CHECKs make the rule part of the database: 0 <= reserved_quantity <= quantity. So NO operation - a manual stock-out, a
    scanner, a dispatch, a bug - can ever take stock that an order has booked: the database refuses the row.
  * stock_reservations - one row per order line: what was reserved in total (original), what dispatches consumed, what was released
    (order reduced or cancelled) and what is still reserved (remaining). original = consumed + released + remaining, always.
    A line can have only one reservation (unique source), and a reservation belongs to the same organization as its product.
  * stock_operations.kind also allows 'reserve' and 'release', and keeps the first answer (`result`) so a retry with the same
    Idempotency-Key replays exactly what was decided the first time.

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-09
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("stock_balances", sa.Column("reserved_quantity", sa.Numeric(18, 4), nullable=False, server_default=sa.text("0")))
    op.create_check_constraint(op.f("ck_stock_balances_reserved_non_negative"), "stock_balances", "reserved_quantity >= 0")
    op.create_check_constraint(op.f("ck_stock_balances_reserved_within_stock"), "stock_balances", "reserved_quantity <= quantity")

    op.drop_constraint(op.f("ck_stock_operations_kind_valid"), "stock_operations", type_="check")
    op.create_check_constraint(
        op.f("ck_stock_operations_kind_valid"), "stock_operations", "kind IN ('opening', 'in', 'out', 'receipt', 'dispatch', 'reserve', 'release')"
    )
    op.add_column("stock_operations", sa.Column("result", postgresql.JSONB(), nullable=True))

    op.create_table(
        "stock_reservations",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("source_type", sa.String(30), nullable=False),
        sa.Column("source_id", sa.Uuid(), nullable=False),
        sa.Column("source_reference", sa.String(32), nullable=False),
        sa.Column("source_line_id", sa.Uuid(), nullable=False),
        sa.Column("original_quantity", sa.Numeric(18, 4), nullable=False),
        sa.Column("consumed_quantity", sa.Numeric(18, 4), nullable=False, server_default=sa.text("0")),
        sa.Column("released_quantity", sa.Numeric(18, 4), nullable=False, server_default=sa.text("0")),
        sa.Column("remaining_quantity", sa.Numeric(18, 4), nullable=False),
        sa.Column("status", sa.String(12), nullable=False, server_default=sa.text("'active'")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stock_reservations")),
        sa.UniqueConstraint("organization_id", "source_type", "source_line_id", name="uq_stock_reservations_source_line"),
        sa.ForeignKeyConstraint(
            ["organization_id", "product_id"], ["products.organization_id", "products.id"],
            name="fk_stock_reservations_product_same_organization", ondelete="RESTRICT",
        ),
        sa.CheckConstraint("source_type = 'sales_order'", name=op.f("ck_stock_reservations_source_type_valid")),
        sa.CheckConstraint("original_quantity > 0", name=op.f("ck_stock_reservations_original_positive")),
        sa.CheckConstraint("consumed_quantity >= 0 AND released_quantity >= 0 AND remaining_quantity >= 0", name=op.f("ck_stock_reservations_quantities_non_negative")),
        sa.CheckConstraint(
            "original_quantity = consumed_quantity + released_quantity + remaining_quantity", name=op.f("ck_stock_reservations_quantities_add_up")
        ),
        sa.CheckConstraint(
            "(status = 'active' AND remaining_quantity > 0) OR "
            "(status = 'fulfilled' AND remaining_quantity = 0 AND consumed_quantity > 0) OR "
            "(status = 'released' AND remaining_quantity = 0 AND consumed_quantity = 0)",
            name=op.f("ck_stock_reservations_status_consistent"),
        ),
    )
    op.create_index("ix_stock_reservations_organization_id", "stock_reservations", ["organization_id"])
    op.create_index("ix_stock_reservations_organization_id_source_id", "stock_reservations", ["organization_id", "source_id"])
    op.create_index(
        "ix_stock_reservations_organization_id_product_id_active", "stock_reservations", ["organization_id", "product_id"],
        postgresql_where=sa.text("status = 'active'"),
    )


def downgrade() -> None:
    op.drop_table("stock_reservations")
    op.drop_column("stock_operations", "result")
    op.drop_constraint(op.f("ck_stock_operations_kind_valid"), "stock_operations", type_="check")
    op.create_check_constraint(op.f("ck_stock_operations_kind_valid"), "stock_operations", "kind IN ('opening', 'in', 'out', 'receipt', 'dispatch')")
    op.drop_constraint(op.f("ck_stock_balances_reserved_within_stock"), "stock_balances", type_="check")
    op.drop_constraint(op.f("ck_stock_balances_reserved_non_negative"), "stock_balances", type_="check")
    op.drop_column("stock_balances", "reserved_quantity")
