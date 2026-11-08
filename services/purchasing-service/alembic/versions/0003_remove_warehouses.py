"""remove warehouses: purchase-order lines and receipt lines no longer name a warehouse

DESTRUCTIVE and IRREVERSIBLE (requested explicitly: the business has a single location). Take a backup first (pg_dump of impex_purchasing).

  * purchase_order_lines.planned_warehouse_id / planned_warehouse_code are dropped (a plan nobody can make any more);
  * goods_receipt_lines.warehouse_id / warehouse_code are dropped together with the rule "something accepted needs a warehouse";
  * the receipt-line guard trigger no longer mentions the dropped columns (its other rules are unchanged).

Every quantity, product snapshot, the link to the inventory movement and every total is untouched. A receipt line was already unique per
(receipt, purchase-order line), so nothing has to be merged.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-08
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

RECEIPT_LINES_GUARD_WITHOUT_WAREHOUSES = """
CREATE OR REPLACE FUNCTION goods_receipt_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt_status text;
  receipt_order uuid;
  order_line record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
    SELECT status INTO receipt_status FROM goods_receipts WHERE organization_id = OLD.organization_id AND id = OLD.goods_receipt_id FOR SHARE;
    IF receipt_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'the lines of a goods receipt that is % cannot be removed', receipt_status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND
     (NEW.id, NEW.organization_id, NEW.goods_receipt_id, NEW.purchase_order_line_id, NEW.product_id, NEW.product_sku, NEW.product_name, NEW.unit)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.goods_receipt_id, OLD.purchase_order_line_id, OLD.product_id, OLD.product_sku, OLD.product_name, OLD.unit) THEN
    RAISE EXCEPTION 'a goods receipt line cannot be moved or re-pointed at another product' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT status, purchase_order_id INTO receipt_status, receipt_order
    FROM goods_receipts WHERE organization_id = NEW.organization_id AND id = NEW.goods_receipt_id FOR SHARE;

  IF TG_OP = 'INSERT' THEN
    IF receipt_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'lines can only be added to a draft goods receipt' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT purchase_order_id, product_id, unit INTO order_line
      FROM purchase_order_lines WHERE organization_id = NEW.organization_id AND id = NEW.purchase_order_line_id;
    IF NOT FOUND OR order_line.purchase_order_id IS DISTINCT FROM receipt_order THEN
      RAISE EXCEPTION 'that product is not on the purchase order of this goods receipt' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF order_line.product_id IS DISTINCT FROM NEW.product_id OR order_line.unit IS DISTINCT FROM NEW.unit THEN
      RAISE EXCEPTION 'the product and the unit of a receipt line must be those of the purchase order line' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF receipt_status = 'draft' THEN RETURN NEW; END IF;
  IF receipt_status = 'posting' AND OLD.inventory_movement_id IS NULL AND NEW.inventory_movement_id IS NOT NULL
     AND (NEW.accepted_quantity, NEW.rejected_quantity, NEW.notes)
         IS NOT DISTINCT FROM (OLD.accepted_quantity, OLD.rejected_quantity, OLD.notes) THEN
    RETURN NEW;  -- the one allowed change: recording which movement the Inventory Service made for this line
  END IF;
  RAISE EXCEPTION 'the lines of a goods receipt that is % are frozen', receipt_status USING ERRCODE = 'integrity_constraint_violation';
END
$$
"""


def upgrade() -> None:
    op.execute(RECEIPT_LINES_GUARD_WITHOUT_WAREHOUSES)
    op.drop_constraint(op.f("ck_goods_receipt_lines_warehouse_when_accepted"), "goods_receipt_lines", type_="check")
    op.drop_column("goods_receipt_lines", "warehouse_id")
    op.drop_column("goods_receipt_lines", "warehouse_code")
    op.drop_column("purchase_order_lines", "planned_warehouse_id")
    op.drop_column("purchase_order_lines", "planned_warehouse_code")


def downgrade() -> None:
    raise RuntimeError(
        "Removing warehouses cannot be reversed: the warehouse of each receipt line and the planned warehouse of each purchase-order line were "
        "deleted. Restore the pre-migration backup of impex_purchasing instead."
    )
