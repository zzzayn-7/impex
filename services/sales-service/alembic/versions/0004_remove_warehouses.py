"""remove warehouses: a dispatch line and a delivery-list item no longer name a warehouse

DESTRUCTIVE and IRREVERSIBLE (requested explicitly: the business has a single location). Take a backup first (pg_dump of impex_sales).

  * delivery_list_items.planned_warehouse_id / planned_warehouse_code are dropped (a plan nobody can make any more);
  * dispatch_lines.warehouse_id / warehouse_code are dropped, and a dispatch line is unique per (dispatch, delivery-list item) instead of per
    (dispatch, item, warehouse). Quantities, product snapshots, the link to the inventory movement and every total are untouched;
  * the dispatch-line guard trigger no longer mentions the dropped columns (its other rules are unchanged).

Before touching anything the migration CHECKS that no dispatch has the same item on two lines (the one situation that only existed when an item
could leave from two warehouses). Merging such lines is not possible after the fact - a confirmed line is bound to its own inventory movement -
so if any exist the migration stops with a clear message and NOTHING is changed.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-08
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DISPATCH_LINES_GUARD_WITHOUT_WAREHOUSES = """
CREATE OR REPLACE FUNCTION dispatch_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  dispatch_status text;
  dispatch_list uuid;
  item record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
    SELECT status INTO dispatch_status FROM dispatches WHERE organization_id = OLD.organization_id AND id = OLD.dispatch_id FOR SHARE;
    IF dispatch_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'the lines of a dispatch that is % cannot be removed', dispatch_status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND
     (NEW.id, NEW.organization_id, NEW.dispatch_id, NEW.delivery_list_item_id, NEW.product_id, NEW.product_sku, NEW.product_name, NEW.unit)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.dispatch_id, OLD.delivery_list_item_id, OLD.product_id, OLD.product_sku, OLD.product_name, OLD.unit) THEN
    RAISE EXCEPTION 'a dispatch line cannot be moved or re-pointed at another product' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT status, delivery_list_id INTO dispatch_status, dispatch_list
    FROM dispatches WHERE organization_id = NEW.organization_id AND id = NEW.dispatch_id FOR SHARE;

  IF TG_OP = 'INSERT' THEN
    IF dispatch_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'lines can only be added to a draft dispatch' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT delivery_list_id, product_id, unit INTO item FROM delivery_list_items WHERE organization_id = NEW.organization_id AND id = NEW.delivery_list_item_id;
    IF NOT FOUND OR item.delivery_list_id IS DISTINCT FROM dispatch_list THEN
      RAISE EXCEPTION 'that product is not on the delivery list of this dispatch' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF item.product_id IS DISTINCT FROM NEW.product_id OR item.unit IS DISTINCT FROM NEW.unit THEN
      RAISE EXCEPTION 'the product and the unit of a dispatch line must be those of the delivery list item' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF dispatch_status = 'draft' THEN RETURN NEW; END IF;
  IF dispatch_status = 'posting' AND OLD.inventory_movement_id IS NULL AND NEW.inventory_movement_id IS NOT NULL
     AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity THEN
    RETURN NEW;  -- the one allowed change: recording which movement the Inventory Service made for this line
  END IF;
  RAISE EXCEPTION 'the lines of a dispatch that is % are frozen', dispatch_status USING ERRCODE = 'integrity_constraint_violation';
END
$$
"""


def upgrade() -> None:
    bind = op.get_bind()
    duplicates = bind.execute(sa.text(
        "SELECT dispatch_id, delivery_list_item_id FROM dispatch_lines GROUP BY organization_id, dispatch_id, delivery_list_item_id HAVING count(*) > 1"
    )).all()
    if duplicates:
        raise RuntimeError(
            f"Warehouse removal aborted: {len(duplicates)} dispatch(es) list the same product on more than one line (it left from several "
            "warehouses). Those lines cannot be merged after the fact. Nothing was changed."
        )

    op.execute(DISPATCH_LINES_GUARD_WITHOUT_WAREHOUSES)
    op.drop_constraint("uq_dispatch_lines_dispatch_item_warehouse", "dispatch_lines", type_="unique")
    op.drop_column("dispatch_lines", "warehouse_id")
    op.drop_column("dispatch_lines", "warehouse_code")
    op.create_unique_constraint("uq_dispatch_lines_dispatch_item", "dispatch_lines", ["organization_id", "dispatch_id", "delivery_list_item_id"])

    op.drop_column("delivery_list_items", "planned_warehouse_id")
    op.drop_column("delivery_list_items", "planned_warehouse_code")


def downgrade() -> None:
    raise RuntimeError(
        "Removing warehouses cannot be reversed: the warehouse of each dispatch line and the planned warehouse of each delivery-list item were "
        "deleted. Restore the pre-migration backup of impex_sales instead."
    )
