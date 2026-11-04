"""a SKU and a registered barcode of two different products can never be the same text

A scan resolves a code as a registered barcode first and then as a SKU. If product A's barcode equals product B's SKU
the scan is ambiguous. Registering such a barcode was already refused by the API; this makes the opposite order (a SKU
created or renamed to match an existing barcode) impossible too, and enforces both inside the database, serialized with
an advisory lock per (organization, text) so two concurrent requests cannot both slip through.

Additive only: two triggers. No existing row is changed (a catalog that already contains such a collision keeps working;
it is simply reported as ambiguous when scanned, as before).

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-06
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE FUNCTION products_sku_not_a_barcode() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text || ':' || NEW.sku, 0));
          IF EXISTS (SELECT 1 FROM product_identifiers
                     WHERE organization_id = NEW.organization_id AND value = NEW.sku AND product_id <> NEW.id) THEN
            RAISE EXCEPTION 'the SKU % is already a barcode of another product', NEW.sku
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER trg_products_sku_not_a_barcode BEFORE INSERT OR UPDATE OF sku ON products "
        "FOR EACH ROW EXECUTE FUNCTION products_sku_not_a_barcode()"
    )
    op.execute(
        """
        CREATE FUNCTION product_identifiers_not_a_sku() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text || ':' || NEW.value, 0));
          IF EXISTS (SELECT 1 FROM products
                     WHERE organization_id = NEW.organization_id AND sku = NEW.value AND id <> NEW.product_id) THEN
            RAISE EXCEPTION 'the barcode % is already the SKU of another product', NEW.value
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER trg_product_identifiers_not_a_sku BEFORE INSERT ON product_identifiers "
        "FOR EACH ROW EXECUTE FUNCTION product_identifiers_not_a_sku()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_product_identifiers_not_a_sku ON product_identifiers")
    op.execute("DROP FUNCTION IF EXISTS product_identifiers_not_a_sku()")
    op.execute("DROP TRIGGER IF EXISTS trg_products_sku_not_a_barcode ON products")
    op.execute("DROP FUNCTION IF EXISTS products_sku_not_a_barcode()")
