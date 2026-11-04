"""warehouses, stock balances, idempotent operations and the append-only movement ledger

Additive only: existing products are untouched. The one change to an existing table is a new UNIQUE constraint
on products (organization_id, id), which every existing row already satisfies because id is the primary key.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-04
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TIMESTAMP = dict(type_=sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)


def upgrade() -> None:
    # --- products: target of the composite same-organization foreign keys -----------------------------
    op.create_unique_constraint("uq_products_organization_id_id", "products", ["organization_id", "id"])

    # --- warehouses ------------------------------------------------------------------------------------
    op.create_table(
        "warehouses",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("code", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("address", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("updated_at", **TIMESTAMP),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_warehouses")),
        sa.UniqueConstraint("organization_id", "code", name="uq_warehouses_organization_id_code"),
        sa.UniqueConstraint("organization_id", "id", name="uq_warehouses_organization_id_id"),
    )
    op.create_index(op.f("ix_warehouses_organization_id"), "warehouses", ["organization_id"], unique=False)

    # --- stock_operations: one row per stock-changing request (idempotency) ----------------------------
    op.create_table(
        "stock_operations",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("idempotency_key", sa.String(length=100), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("created_at", **TIMESTAMP),
        sa.CheckConstraint("kind IN ('opening', 'in', 'out', 'transfer')", name=op.f("ck_stock_operations_kind_valid")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stock_operations")),
        sa.UniqueConstraint("organization_id", "idempotency_key", name="uq_stock_operations_organization_id_idempotency_key"),
        sa.UniqueConstraint("organization_id", "id", name="uq_stock_operations_organization_id_id"),
    )
    op.create_index(op.f("ix_stock_operations_organization_id"), "stock_operations", ["organization_id"], unique=False)

    # --- stock_balances --------------------------------------------------------------------------------
    op.create_table(
        "stock_balances",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("warehouse_id", sa.Uuid(), nullable=False),
        sa.Column("quantity", sa.Numeric(precision=18, scale=4), server_default=sa.text("0"), nullable=False),
        sa.Column("updated_at", **TIMESTAMP),
        sa.CheckConstraint("quantity >= 0", name=op.f("ck_stock_balances_quantity_non_negative")),
        sa.ForeignKeyConstraint(["organization_id", "product_id"], ["products.organization_id", "products.id"],
                                name="fk_stock_balances_product_same_organization", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["organization_id", "warehouse_id"], ["warehouses.organization_id", "warehouses.id"],
                                name="fk_stock_balances_warehouse_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stock_balances")),
        sa.UniqueConstraint("organization_id", "product_id", "warehouse_id",
                            name="uq_stock_balances_organization_id_product_id_warehouse_id"),
    )
    op.create_index(op.f("ix_stock_balances_organization_id"), "stock_balances", ["organization_id"], unique=False)
    op.create_index("ix_stock_balances_organization_id_warehouse_id", "stock_balances", ["organization_id", "warehouse_id"], unique=False)

    # --- stock_movements: the append-only ledger -------------------------------------------------------
    op.create_table(
        "stock_movements",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("operation_id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("warehouse_id", sa.Uuid(), nullable=False),
        sa.Column("movement_type", sa.String(length=20), nullable=False),
        sa.Column("quantity", sa.Numeric(precision=18, scale=4), nullable=False),
        sa.Column("balance_after", sa.Numeric(precision=18, scale=4), nullable=False),
        sa.Column("reason", sa.String(length=255), nullable=False),
        sa.Column("transfer_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("created_by_email", sa.String(length=320), nullable=False),
        sa.Column("created_at", **TIMESTAMP),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_stock_movements_quantity_positive")),
        sa.CheckConstraint("balance_after >= 0", name=op.f("ck_stock_movements_balance_after_non_negative")),
        sa.CheckConstraint("movement_type IN ('opening', 'in', 'out', 'transfer_out', 'transfer_in')",
                           name=op.f("ck_stock_movements_movement_type_valid")),
        sa.CheckConstraint("(movement_type IN ('transfer_out', 'transfer_in')) = (transfer_id IS NOT NULL)",
                           name=op.f("ck_stock_movements_transfer_link_matches_type")),
        sa.ForeignKeyConstraint(["organization_id", "product_id"], ["products.organization_id", "products.id"],
                                name="fk_stock_movements_product_same_organization", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["organization_id", "warehouse_id"], ["warehouses.organization_id", "warehouses.id"],
                                name="fk_stock_movements_warehouse_same_organization", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["organization_id", "operation_id"], ["stock_operations.organization_id", "stock_operations.id"],
                                name="fk_stock_movements_operation_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stock_movements")),
    )
    op.create_index(op.f("ix_stock_movements_organization_id"), "stock_movements", ["organization_id"], unique=False)
    op.create_index("ix_stock_movements_organization_id_created_at", "stock_movements", ["organization_id", "created_at"], unique=False)
    op.create_index("ix_stock_movements_organization_id_product_id_created_at", "stock_movements",
                    ["organization_id", "product_id", "created_at"], unique=False)
    op.create_index("ix_stock_movements_organization_id_warehouse_id_created_at", "stock_movements",
                    ["organization_id", "warehouse_id", "created_at"], unique=False)

    # History can never be rewritten: UPDATE is always refused. DELETE is refused too, except inside an explicit
    # out-of-band maintenance transaction (SET LOCAL app.allow_ledger_maintenance = 'on'), which the application
    # never uses; it exists so throwaway test data can be removed.
    op.execute(
        """
        CREATE FUNCTION stock_movements_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'DELETE' AND current_setting('app.allow_ledger_maintenance', true) = 'on' THEN
                RETURN OLD;
            END IF;
            RAISE EXCEPTION 'stock_movements is append-only (% is not allowed)', TG_OP
                USING ERRCODE = 'integrity_constraint_violation';
        END
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER trg_stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements "
        "FOR EACH ROW EXECUTE FUNCTION stock_movements_append_only()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_stock_movements_append_only ON stock_movements")
    op.execute("DROP FUNCTION IF EXISTS stock_movements_append_only()")
    op.drop_table("stock_movements")
    op.drop_table("stock_balances")
    op.drop_table("stock_operations")
    op.drop_table("warehouses")
    op.drop_constraint("uq_products_organization_id_id", "products", type_="unique")
