"""suppliers, purchase orders and purchase order lines

A new database (impex_purchasing): nothing existing is touched. Purchase orders never move stock, so there is no stock
table here at all. Once an order is Ordered, the database itself freezes its commercial details and its lines.

Revision ID: 0001
Revises:
Create Date: 2026-11-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TIMESTAMP = dict(type_=sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)


def _id():
    return sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False)


def upgrade() -> None:
    op.create_table(
        "suppliers",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("name_key", sa.String(length=255), nullable=False),
        sa.Column("code", sa.String(length=32), nullable=True),
        sa.Column("contact_person", sa.String(length=255), nullable=True),
        sa.Column("email", sa.String(length=320), nullable=True),
        sa.Column("phone", sa.String(length=50), nullable=True),
        sa.Column("address", sa.Text(), nullable=True),
        sa.Column("country_code", sa.String(length=2), nullable=True),
        sa.Column("tax_identifier", sa.String(length=50), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("updated_at", **TIMESTAMP),
        sa.CheckConstraint("country_code IS NULL OR country_code ~ '^[A-Z]{2}$'", name=op.f("ck_suppliers_country_code_format")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_suppliers")),
        sa.UniqueConstraint("organization_id", "name_key", name="uq_suppliers_organization_id_name_key"),
        sa.UniqueConstraint("organization_id", "code", name="uq_suppliers_organization_id_code"),
        sa.UniqueConstraint("organization_id", "id", name="uq_suppliers_organization_id_id"),
    )
    op.create_index(op.f("ix_suppliers_organization_id"), "suppliers", ["organization_id"], unique=False)

    op.create_table(
        "purchase_order_counters",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("last_number", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_purchase_order_counters")),
        sa.UniqueConstraint("organization_id", name="uq_purchase_order_counters_organization_id"),
    )
    op.create_index(op.f("ix_purchase_order_counters_organization_id"), "purchase_order_counters", ["organization_id"], unique=False)

    op.create_table(
        "purchase_orders",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("supplier_id", sa.Uuid(), nullable=False),
        sa.Column("number", sa.String(length=32), nullable=False),
        sa.Column("supplier_reference", sa.String(length=100), nullable=True),
        sa.Column("order_date", sa.Date(), nullable=False),
        sa.Column("expected_delivery_date", sa.Date(), nullable=True),
        sa.Column("currency_code", sa.String(length=3), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=20), server_default=sa.text("'draft'"), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("created_by_email", sa.String(length=320), nullable=False),
        sa.Column("ordered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ordered_by_email", sa.String(length=320), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_by_email", sa.String(length=320), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("updated_at", **TIMESTAMP),
        sa.CheckConstraint("status IN ('draft', 'ordered', 'cancelled')", name=op.f("ck_purchase_orders_status_valid")),
        sa.CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name=op.f("ck_purchase_orders_currency_code_format")),
        sa.CheckConstraint("expected_delivery_date IS NULL OR expected_delivery_date >= order_date", name=op.f("ck_purchase_orders_expected_not_before_order")),
        sa.ForeignKeyConstraint(["organization_id", "supplier_id"], ["suppliers.organization_id", "suppliers.id"],
                                name="fk_purchase_orders_supplier_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_purchase_orders")),
        sa.UniqueConstraint("organization_id", "number", name="uq_purchase_orders_organization_id_number"),
        sa.UniqueConstraint("organization_id", "id", name="uq_purchase_orders_organization_id_id"),
    )
    op.create_index(op.f("ix_purchase_orders_organization_id"), "purchase_orders", ["organization_id"], unique=False)
    op.create_index("ix_purchase_orders_organization_id_supplier_id", "purchase_orders", ["organization_id", "supplier_id"], unique=False)
    op.create_index("ix_purchase_orders_organization_id_status", "purchase_orders", ["organization_id", "status"], unique=False)

    op.create_table(
        "purchase_order_requests",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=100), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("purchase_order_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.ForeignKeyConstraint(["organization_id", "purchase_order_id"], ["purchase_orders.organization_id", "purchase_orders.id"],
                                name="fk_purchase_order_requests_purchase_order_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_purchase_order_requests")),
        sa.UniqueConstraint("organization_id", "idempotency_key", name="uq_purchase_order_requests_organization_id_idempotency_key"),
    )
    op.create_index(op.f("ix_purchase_order_requests_organization_id"), "purchase_order_requests", ["organization_id"], unique=False)

    op.create_table(
        "purchase_order_lines",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("purchase_order_id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("product_sku", sa.String(length=64), nullable=False),
        sa.Column("product_name", sa.String(length=255), nullable=False),
        sa.Column("unit", sa.String(length=20), nullable=False),
        sa.Column("quantity", sa.Numeric(precision=18, scale=4), nullable=False),
        sa.Column("unit_price", sa.Numeric(precision=18, scale=4), nullable=False),
        sa.Column("line_total", sa.Numeric(precision=18, scale=4), nullable=False),
        sa.Column("planned_warehouse_id", sa.Uuid(), nullable=True),
        sa.Column("planned_warehouse_code", sa.String(length=32), nullable=True),
        sa.Column("notes", sa.String(length=500), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("updated_at", **TIMESTAMP),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_purchase_order_lines_quantity_positive")),
        sa.CheckConstraint("unit_price >= 0", name=op.f("ck_purchase_order_lines_unit_price_non_negative")),
        sa.CheckConstraint("line_total = round(quantity * unit_price, 4)", name=op.f("ck_purchase_order_lines_line_total_matches")),
        sa.ForeignKeyConstraint(["organization_id", "purchase_order_id"], ["purchase_orders.organization_id", "purchase_orders.id"],
                                name="fk_purchase_order_lines_purchase_order_same_organization", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_purchase_order_lines")),
        sa.UniqueConstraint("organization_id", "purchase_order_id", "product_id", name="uq_purchase_order_lines_order_product"),
    )
    op.create_index(op.f("ix_purchase_order_lines_organization_id"), "purchase_order_lines", ["organization_id"], unique=False)
    op.create_index("ix_purchase_order_lines_organization_id_purchase_order_id", "purchase_order_lines", ["organization_id", "purchase_order_id"], unique=False)

    # ---- the order's life cycle, enforced by the database ------------------------------------------------------------
    # Only draft -> ordered, draft -> cancelled and ordered -> cancelled are possible. After the order is placed, nothing
    # commercial can be changed: not the supplier, dates, currency, reference, notes, and (see below) not the lines.
    # Orders are never deleted; the maintenance switch is the same out-of-band one the stock ledger uses (the application
    # never sets it; the verification scripts use it to remove their own throwaway data).
    op.execute(
        """
        CREATE FUNCTION purchase_orders_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
            RAISE EXCEPTION 'purchase orders are never deleted; cancel the order instead'
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF OLD.status = 'draft' THEN
            IF NEW.status = 'ordered' AND NOT EXISTS (
              SELECT 1 FROM purchase_order_lines WHERE organization_id = OLD.organization_id AND purchase_order_id = OLD.id
            ) THEN
              RAISE EXCEPTION 'a purchase order without lines cannot be marked Ordered' USING ERRCODE = 'integrity_constraint_violation';
            END IF;
            RETURN NEW;
          END IF;
          IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'ordered' AND NEW.status = 'cancelled') THEN
            RAISE EXCEPTION 'a purchase order that is % cannot become %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF (NEW.organization_id, NEW.number, NEW.supplier_id, NEW.supplier_reference, NEW.order_date, NEW.expected_delivery_date,
              NEW.currency_code, NEW.notes, NEW.created_by, NEW.created_by_email, NEW.created_at, NEW.ordered_at, NEW.ordered_by_email)
             IS DISTINCT FROM
             (OLD.organization_id, OLD.number, OLD.supplier_id, OLD.supplier_reference, OLD.order_date, OLD.expected_delivery_date,
              OLD.currency_code, OLD.notes, OLD.created_by, OLD.created_by_email, OLD.created_at, OLD.ordered_at, OLD.ordered_by_email) THEN
            RAISE EXCEPTION 'the details of a purchase order that is % are frozen', OLD.status USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER trg_purchase_orders_lifecycle BEFORE UPDATE OR DELETE ON purchase_orders "
        "FOR EACH ROW EXECUTE FUNCTION purchase_orders_lifecycle()"
    )
    op.execute(
        """
        CREATE FUNCTION purchase_order_lines_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
          org uuid;
          order_id uuid;
          order_status text;
        BEGIN
          IF TG_OP = 'DELETE' THEN org := OLD.organization_id; order_id := OLD.purchase_order_id;
          ELSE org := NEW.organization_id; order_id := NEW.purchase_order_id; END IF;
          IF TG_OP = 'DELETE' AND current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
          SELECT status INTO order_status FROM purchase_orders WHERE organization_id = org AND id = order_id FOR SHARE;
          IF order_status IS NOT NULL AND order_status <> 'draft' THEN
            RAISE EXCEPTION 'the lines of a purchase order that is % are frozen', order_status USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER trg_purchase_order_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines "
        "FOR EACH ROW EXECUTE FUNCTION purchase_order_lines_frozen()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_purchase_order_lines_frozen ON purchase_order_lines")
    op.execute("DROP FUNCTION IF EXISTS purchase_order_lines_frozen()")
    op.execute("DROP TRIGGER IF EXISTS trg_purchase_orders_lifecycle ON purchase_orders")
    op.execute("DROP FUNCTION IF EXISTS purchase_orders_lifecycle()")
    op.drop_table("purchase_order_lines")
    op.drop_table("purchase_order_requests")
    op.drop_table("purchase_orders")
    op.drop_table("purchase_order_counters")
    op.drop_table("suppliers")
