"""scannable product identifiers (QR / Code 128 / supplier barcodes) and the unit-of-measurement lock

Additive only: no existing row is changed or removed.
  * new table product_identifiers (tenant-scoped, unique value per organization, same-organization foreign key);
  * a trigger that stops identifiers being re-pointed or deleted (they are retired instead);
  * a trigger on products that refuses to change `unit` once the product has stock movements.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TIMESTAMP = dict(type_=sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)


def upgrade() -> None:
    op.create_table(
        "product_identifiers",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("value", sa.String(length=64), nullable=False),
        sa.Column("label", sa.String(length=100), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_by_email", sa.String(length=320), nullable=False),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('generated', 'manufacturer', 'supplier')", name=op.f("ck_product_identifiers_kind_valid")),
        sa.CheckConstraint("value ~ '^[A-Z0-9][A-Z0-9._:/+-]{0,63}$'", name=op.f("ck_product_identifiers_value_format")),
        sa.ForeignKeyConstraint(["organization_id", "product_id"], ["products.organization_id", "products.id"],
                                name="fk_product_identifiers_product_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product_identifiers")),
        sa.UniqueConstraint("organization_id", "value", name="uq_product_identifiers_organization_id_value"),
    )
    op.create_index(op.f("ix_product_identifiers_organization_id"), "product_identifiers", ["organization_id"], unique=False)
    op.create_index("ix_product_identifiers_organization_id_product_id", "product_identifiers", ["organization_id", "product_id"], unique=False)
    op.create_index("uq_product_identifiers_one_generated_per_product", "product_identifiers", ["organization_id", "product_id"],
                    unique=True, postgresql_where=sa.text("kind = 'generated'"))

    # A code never moves to another product and is never deleted (retire it instead). Deleting is possible only in an
    # explicit out-of-band maintenance transaction, the same switch the stock ledger uses (the application never sets it).
    op.execute(
        """
        CREATE FUNCTION product_identifiers_protect() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
            RAISE EXCEPTION 'product_identifiers rows are never deleted; retire the code instead'
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.product_id IS DISTINCT FROM OLD.product_id
             OR NEW.value IS DISTINCT FROM OLD.value OR NEW.kind IS DISTINCT FROM OLD.kind THEN
            RAISE EXCEPTION 'a product identifier can never be re-pointed or changed; retire it and register a new one'
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER trg_product_identifiers_protect BEFORE UPDATE OR DELETE ON product_identifiers "
        "FOR EACH ROW EXECUTE FUNCTION product_identifiers_protect()"
    )

    # The unit of measurement is what gives every recorded quantity its meaning ("12" of what?). Once a product has
    # stock movements it can no longer change. The API checks first (clear message); this is the backstop.
    op.execute(
        """
        CREATE FUNCTION products_unit_locked() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.unit IS DISTINCT FROM OLD.unit AND EXISTS (
            SELECT 1 FROM stock_movements WHERE organization_id = OLD.organization_id AND product_id = OLD.id
          ) THEN
            RAISE EXCEPTION 'the unit of measurement cannot be changed once the product has stock movements'
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER trg_products_unit_locked BEFORE UPDATE OF unit ON products "
        "FOR EACH ROW EXECUTE FUNCTION products_unit_locked()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_products_unit_locked ON products")
    op.execute("DROP FUNCTION IF EXISTS products_unit_locked()")
    op.execute("DROP TRIGGER IF EXISTS trg_product_identifiers_protect ON product_identifiers")
    op.execute("DROP FUNCTION IF EXISTS product_identifiers_protect()")
    op.drop_table("product_identifiers")
