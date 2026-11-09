"""sales orders: a customer order that books stock and owns an automatically generated delivery list

Additive. No existing row is changed: every existing delivery list, dispatch, invoice and payment stays exactly as it is.

  * sales_orders - the order header (SO-000001): client, the ONE delivery list it generated, its status (pending_reservation -> active ->
    delivered | closed | cancelled, or failed) and the state of its stock booking in the Inventory Service (reservation_status). Order LINES
    are the delivery-list items of its list (one authoritative record, so the order and its list can never disagree about quantities);
    what was fulfilled comes from the confirmed dispatch lines.
  * sales_order_counters / sales_order_requests - numbering SO-000001 and an Idempotency-Key per create request, so saving twice never
    makes two orders or two bookings.
  * pending_action / pending_key / pending_lines - the durable INTENT of a change that needs the Inventory Service (create, edit, cancel):
    saved before the Inventory Service is asked, so a crash or timeout can always be recovered by asking again with the same key.
  * Database rules: an order moves only along its lifecycle and agrees with its delivery list (active <-> list Ready / Partially
    Dispatched, delivered / closed <-> Dispatched, cancelled / failed <-> Cancelled); a finished order never changes and no order is ever
    deleted.
  * The items guard (0002) kept every list frozen once it left draft. A list that belongs to an active ORDER stays editable while goods
    remain to be delivered - only quantities may change (never below what was dispatched), products can be added, and a line with no
    dispatch history can be removed. Everything else stays frozen, exactly as before.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-09
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TIMESTAMP = dict(type_=sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)

ORDERS_GUARD = """
CREATE FUNCTION sales_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  list_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'sales orders are never deleted; cancel the order instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_reservation' THEN
      RAISE EXCEPTION 'a sales order starts as pending_reservation' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.organization_id, NEW.number, NEW.client_id, NEW.delivery_list_id, NEW.created_by, NEW.created_at, NEW.origin)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.number, OLD.client_id, OLD.delivery_list_id, OLD.created_by, OLD.created_at, OLD.origin) THEN
    RAISE EXCEPTION 'the identity of a sales order can never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.status IN ('delivered', 'closed', 'cancelled', 'failed') THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'a sales order that is % can never be changed', OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'pending_reservation' AND NEW.status IN ('active', 'failed'))
      OR (OLD.status = 'active' AND NEW.status IN ('delivered', 'closed', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'a sales order that is % cannot become %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT status INTO list_status FROM delivery_lists WHERE organization_id = NEW.organization_id AND id = NEW.delivery_list_id FOR SHARE;
    IF NEW.status = 'active' AND list_status NOT IN ('ready', 'partially_dispatched') THEN
      RAISE EXCEPTION 'an order is active only while its delivery list is Ready or Partially Dispatched' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status IN ('delivered', 'closed') AND list_status IS DISTINCT FROM 'dispatched' THEN
      RAISE EXCEPTION 'an order is delivered or closed only when its delivery list is fully dispatched' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status IN ('cancelled', 'failed') AND list_status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'an order is cancelled only together with its delivery list' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$
"""

ITEMS_GUARD = """
CREATE OR REPLACE FUNCTION delivery_list_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  list_status text;
  on_order boolean;
  held numeric;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id, NEW.delivery_list_id) IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.delivery_list_id) THEN
    RAISE EXCEPTION 'a delivery list item cannot be moved to another list or organization' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO list_status FROM delivery_lists WHERE organization_id = NEW.organization_id AND id = NEW.delivery_list_id FOR SHARE;
  ELSE
    SELECT status INTO list_status FROM delivery_lists WHERE organization_id = OLD.organization_id AND id = OLD.delivery_list_id FOR SHARE;
  END IF;
  IF list_status IS NOT NULL AND list_status <> 'draft' THEN
    SELECT EXISTS (
      SELECT 1 FROM sales_orders
       WHERE organization_id = COALESCE(NEW.organization_id, OLD.organization_id)
         AND delivery_list_id = COALESCE(NEW.delivery_list_id, OLD.delivery_list_id)
         AND status = 'active'
    ) INTO on_order;
    IF NOT (on_order AND list_status IN ('ready', 'partially_dispatched')) THEN
      RAISE EXCEPTION 'the items of a delivery list that is % are frozen', list_status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- an active order's lines: quantities can change (never below what was dispatched or is being dispatched), products can be added,
    -- and a line nothing was ever dispatched from can be removed; nothing else about a line changes
    IF TG_OP = 'UPDATE' THEN
      IF (NEW.product_id, NEW.product_sku, NEW.product_name, NEW.unit) IS DISTINCT FROM (OLD.product_id, OLD.product_sku, OLD.product_name, OLD.unit) THEN
        RAISE EXCEPTION 'only the quantity of an order line can change' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT COALESCE(sum(dl.quantity), 0) INTO held
        FROM dispatch_lines dl
        JOIN dispatches d ON d.organization_id = dl.organization_id AND d.id = dl.dispatch_id
       WHERE dl.organization_id = OLD.organization_id AND dl.delivery_list_item_id = OLD.id AND d.status IN ('confirmed', 'posting');
      IF NEW.quantity < held THEN
        RAISE EXCEPTION 'an order line cannot be reduced below the quantity already dispatched' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$
"""

ITEMS_GUARD_BEFORE = """
CREATE OR REPLACE FUNCTION delivery_list_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  list_status text;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id, NEW.delivery_list_id) IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.delivery_list_id) THEN
    RAISE EXCEPTION 'a delivery list item cannot be moved to another list or organization' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO list_status FROM delivery_lists WHERE organization_id = NEW.organization_id AND id = NEW.delivery_list_id FOR SHARE;
  ELSE
    SELECT status INTO list_status FROM delivery_lists WHERE organization_id = OLD.organization_id AND id = OLD.delivery_list_id FOR SHARE;
  END IF;
  IF list_status IS NOT NULL AND list_status <> 'draft' THEN
    RAISE EXCEPTION 'the items of a delivery list that is % are frozen', list_status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$
"""


def _id():
    return sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False)


def upgrade() -> None:
    op.create_table(
        "sales_order_counters",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("last_number", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sales_order_counters")),
        sa.UniqueConstraint("organization_id", name="uq_sales_order_counters_organization_id"),
    )
    op.create_index("ix_sales_order_counters_organization_id", "sales_order_counters", ["organization_id"])

    op.create_table(
        "sales_orders",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("number", sa.String(32), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("delivery_list_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(24), server_default=sa.text("'pending_reservation'"), nullable=False),
        sa.Column("reservation_status", sa.String(12), server_default=sa.text("'pending'"), nullable=False),
        sa.Column("origin", sa.String(12), server_default=sa.text("'order'"), nullable=False),
        sa.Column("version", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("pending_action", sa.String(12), nullable=True),
        sa.Column("pending_key", sa.String(100), nullable=True),
        sa.Column("pending_lines", postgresql.JSONB(), nullable=True),
        sa.Column("pending_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("created_by_email", sa.String(320), nullable=False),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("updated_at", **TIMESTAMP),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_by_email", sa.String(320), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sales_orders")),
        sa.UniqueConstraint("organization_id", "number", name="uq_sales_orders_organization_id_number"),
        sa.UniqueConstraint("organization_id", "id", name="uq_sales_orders_organization_id_id"),
        sa.UniqueConstraint("organization_id", "delivery_list_id", name="uq_sales_orders_organization_id_delivery_list_id"),
        sa.ForeignKeyConstraint(["organization_id", "client_id"], ["clients.organization_id", "clients.id"], name="fk_sales_orders_client_same_organization", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["organization_id", "delivery_list_id"], ["delivery_lists.organization_id", "delivery_lists.id"],
            name="fk_sales_orders_delivery_list_same_organization", ondelete="RESTRICT",
        ),
        sa.CheckConstraint("status IN ('pending_reservation', 'active', 'delivered', 'closed', 'cancelled', 'failed')", name=op.f("ck_sales_orders_status_valid")),
        sa.CheckConstraint("reservation_status IN ('pending', 'reserved', 'updating', 'consumed', 'released', 'none')", name=op.f("ck_sales_orders_reservation_status_valid")),
        sa.CheckConstraint("origin IN ('order', 'list')", name=op.f("ck_sales_orders_origin_valid")),
        sa.CheckConstraint("version >= 1", name=op.f("ck_sales_orders_version_positive")),
        sa.CheckConstraint(
            "(status = 'pending_reservation' AND reservation_status = 'pending') OR "
            "(status = 'active' AND reservation_status IN ('reserved', 'updating')) OR "
            "(status = 'delivered' AND reservation_status = 'consumed') OR "
            "(status IN ('closed', 'cancelled') AND reservation_status = 'released') OR "
            "(status = 'failed' AND reservation_status = 'none')",
            name=op.f("ck_sales_orders_reservation_matches_status"),
        ),
        sa.CheckConstraint("(status IN ('delivered', 'closed')) = (completed_at IS NOT NULL)", name=op.f("ck_sales_orders_completed_when_finished")),
        sa.CheckConstraint("status NOT IN ('cancelled', 'closed') OR cancelled_at IS NOT NULL", name=op.f("ck_sales_orders_cancelled_has_time")),
        sa.CheckConstraint("(pending_action IS NULL) = (pending_key IS NULL)", name=op.f("ck_sales_orders_pending_consistent")),
        sa.CheckConstraint("pending_action IS NULL OR pending_action IN ('create', 'edit', 'cancel', 'close')", name=op.f("ck_sales_orders_pending_action_valid")),
    )
    op.create_index("ix_sales_orders_organization_id", "sales_orders", ["organization_id"])
    op.create_index("ix_sales_orders_organization_id_status", "sales_orders", ["organization_id", "status"])
    op.create_index("ix_sales_orders_organization_id_completed_at", "sales_orders", ["organization_id", "completed_at"])
    op.create_index("ix_sales_orders_organization_id_client_id", "sales_orders", ["organization_id", "client_id"])

    op.create_table(
        "sales_order_requests",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("idempotency_key", sa.String(100), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sales_order_requests")),
        sa.UniqueConstraint("organization_id", "idempotency_key", name="uq_sales_order_requests_organization_id_idempotency_key"),
        sa.ForeignKeyConstraint(["organization_id", "order_id"], ["sales_orders.organization_id", "sales_orders.id"], name="fk_sales_order_requests_order_same_organization", ondelete="RESTRICT"),
    )
    op.create_index("ix_sales_order_requests_organization_id", "sales_order_requests", ["organization_id"])

    op.execute(ORDERS_GUARD)
    op.execute("CREATE TRIGGER trg_sales_orders_guard BEFORE INSERT OR UPDATE OR DELETE ON sales_orders FOR EACH ROW EXECUTE FUNCTION sales_orders_guard()")
    op.execute(ITEMS_GUARD)


def downgrade() -> None:
    op.execute(ITEMS_GUARD_BEFORE)
    op.execute("DROP TRIGGER IF EXISTS trg_sales_orders_guard ON sales_orders")
    op.drop_table("sales_order_requests")
    op.execute("SET LOCAL app.allow_ledger_maintenance = 'on'")  # lets the drop of the guarded table go through
    op.drop_table("sales_orders")
    op.execute("DROP FUNCTION IF EXISTS sales_orders_guard()")
    op.drop_table("sales_order_counters")
