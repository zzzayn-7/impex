"""purchase orders can be deleted (by the organization's administrator) while no goods were ever received against them

Until now the database refused every DELETE of a purchase order ("cancel it instead"). It still does, EXCEPT inside the one transaction in which the application deletes an order
on purpose (it sets `app.deleting_purchase_order = 'on'` for that transaction only, see app/orders.py), and even then the database itself refuses to delete:
  * an order that is partially received or received (goods arrived, stock moved, Finance may have posted it), and
  * an order that has ANY goods receipt (draft, confirmed or cancelled): receipts are never deleted, so the order they name stays.
The lines of the order go with it (the same rule); nothing else is relaxed: a confirmed receipt, a stock movement, an invoice or any other order cannot be deleted by this.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-11
"""
import importlib.util
from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD_DELETE_BRANCH = """  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'purchase orders are never deleted; cancel the order instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;"""

NEW_DELETE_BRANCH = """  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
    IF current_setting('app.deleting_purchase_order', true) = 'on' THEN
      IF OLD.status NOT IN ('draft', 'ordered', 'cancelled') THEN
        RAISE EXCEPTION 'a purchase order that is % has goods received against it and cannot be deleted', OLD.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM goods_receipts WHERE organization_id = OLD.organization_id AND purchase_order_id = OLD.id) THEN
        RAISE EXCEPTION 'a purchase order with goods receipts cannot be deleted: the receipts are never deleted'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'purchase orders are never deleted; cancel the order instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;"""

OLD_LINES_BRANCH = "  IF TG_OP = 'DELETE' AND current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;\n"
NEW_LINES_BRANCH = OLD_LINES_BRANCH + """  IF TG_OP = 'DELETE' AND current_setting('app.deleting_purchase_order', true) = 'on' THEN
    -- the lines go with their order, but only an order that may be deleted at all (never one with goods received)
    IF EXISTS (SELECT 1 FROM purchase_orders WHERE organization_id = OLD.organization_id AND id = OLD.purchase_order_id AND status NOT IN ('draft', 'ordered', 'cancelled')) THEN
      RAISE EXCEPTION 'the lines of a purchase order with goods received cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
"""


def _previous():
    """The definitions this migration replaces (migration 0002's), so the downgrade can put them back exactly."""
    path = Path(__file__).with_name("0002_goods_receipts.py")
    spec = importlib.util.spec_from_file_location("purchasing_migration_0002", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.NEW_LIFECYCLE, module.NEW_LINES_FROZEN


def upgrade() -> None:
    lifecycle, lines = _previous()
    assert OLD_DELETE_BRANCH in lifecycle and OLD_LINES_BRANCH in lines
    op.execute(lifecycle.replace(OLD_DELETE_BRANCH, NEW_DELETE_BRANCH))
    op.execute(lines.replace(OLD_LINES_BRANCH, NEW_LINES_BRANCH))


def downgrade() -> None:
    lifecycle, lines = _previous()
    op.execute(lifecycle)
    op.execute(lines)
