"""client dispatch: dispatches, partial dispatching, and the database rules that protect delivery history

Additive. No existing row is changed: every existing delivery list keeps its status (draft / ready / cancelled) and its items.

Part 1 - delivery-list states and freezing. A list gets two more states, Partially Dispatched and Dispatched:
    draft -> ready | cancelled;   ready -> draft | cancelled | partially_dispatched | dispatched;   partially_dispatched -> dispatched.
The database refuses: a list called Dispatched unless every item is fully covered by CONFIRMED dispatches (Partially Dispatched: some but
not all); reopening a list that has any dispatch; cancelling a list whose goods are being (or have been) dispatched. Until now the
rule "items change only while the list is a draft" lived only in the application; a trigger now enforces it, and also makes an item's
`id`, `organization_id` and `delivery_list_id` immutable (an item can never be re-pointed at another list to slip past the freeze).

Part 2 - dispatches (drafts, then posting, then confirmed; or cancelled). The database refuses: deleting a dispatch, changing a
confirmed or cancelled dispatch in any way, changing a dispatch that is being posted (except its bookkeeping), confirming one before
every line carries its Inventory movement, a line that is not an item of the dispatch's delivery list or in another product / unit than
the item, a dispatch for another client than the list's, and dispatching more than the client requested (checked under a lock on the
delivery list when a dispatch starts posting).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-09
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TIMESTAMP = dict(type_=sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)


def _id():
    return sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False)


LISTS_LIFECYCLE = """
CREATE FUNCTION delivery_lists_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  open_items integer;
  dispatched_total numeric;
BEGIN
  IF (NEW.id, NEW.organization_id, NEW.number, NEW.client_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.number, OLD.client_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'the identity of a delivery list (id, organization, number, client, creator) can never change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  IF NOT (
       (OLD.status = 'draft' AND NEW.status IN ('ready', 'cancelled'))
    OR (OLD.status = 'ready' AND NEW.status IN ('draft', 'cancelled', 'partially_dispatched', 'dispatched'))
    OR (OLD.status = 'partially_dispatched' AND NEW.status = 'dispatched')
  ) THEN
    RAISE EXCEPTION 'a delivery list that is % cannot become %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status = 'draft' AND EXISTS (
    SELECT 1 FROM dispatches WHERE organization_id = OLD.organization_id AND delivery_list_id = OLD.id AND status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'a delivery list with dispatches cannot be reopened for editing' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'cancelled' AND EXISTS (
    SELECT 1 FROM dispatches WHERE organization_id = OLD.organization_id AND delivery_list_id = OLD.id AND status IN ('posting', 'confirmed')
  ) THEN
    RAISE EXCEPTION 'a delivery list with goods dispatched (or being dispatched) cannot be cancelled' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status IN ('partially_dispatched', 'dispatched') THEN
    SELECT count(*) FILTER (WHERE dispatched < requested), COALESCE(sum(dispatched), 0)
      INTO open_items, dispatched_total
      FROM (
        SELECT i.quantity AS requested,
               COALESCE((
                 SELECT sum(dl.quantity)
                   FROM dispatch_lines dl
                   JOIN dispatches d ON d.organization_id = dl.organization_id AND d.id = dl.dispatch_id
                  WHERE dl.organization_id = i.organization_id AND dl.delivery_list_item_id = i.id AND d.status = 'confirmed'
               ), 0) AS dispatched
          FROM delivery_list_items i
         WHERE i.organization_id = OLD.organization_id AND i.delivery_list_id = OLD.id
      ) x;
    IF NEW.status = 'dispatched' AND open_items > 0 THEN
      RAISE EXCEPTION 'a delivery list is Dispatched only when every item is fully dispatched' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status = 'partially_dispatched' AND (dispatched_total = 0 OR open_items = 0) THEN
      RAISE EXCEPTION 'a delivery list is Partially Dispatched only when some, but not all, of the goods are dispatched' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$
"""

ITEMS_GUARD = """
CREATE FUNCTION delivery_list_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

DISPATCHES_GUARD = """
CREATE FUNCTION dispatches_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  list_status text;
  list_client uuid;
  over record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'dispatches are never deleted; cancel a draft instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a dispatch starts as a draft' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT status, client_id INTO list_status, list_client FROM delivery_lists WHERE organization_id = NEW.organization_id AND id = NEW.delivery_list_id FOR SHARE;
    IF list_status IS NULL OR list_status NOT IN ('ready', 'partially_dispatched') THEN
      RAISE EXCEPTION 'goods can be dispatched only against a Ready or Partially Dispatched delivery list' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF list_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'a dispatch is for the client of its delivery list' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.organization_id, NEW.delivery_list_id, NEW.client_id, NEW.number, NEW.posting_key, NEW.created_by, NEW.created_by_email, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.delivery_list_id, OLD.client_id, OLD.number, OLD.posting_key, OLD.created_by, OLD.created_by_email, OLD.created_at) THEN
    RAISE EXCEPTION 'the identity of a dispatch can never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.status IN ('confirmed', 'cancelled') THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'a dispatch that is % can never be changed', OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'posting', 'cancelled') THEN
      RAISE EXCEPTION 'a draft dispatch can only be confirmed (posted) or cancelled' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status = 'posting' THEN
      -- The intent to deduct stock. The list is locked first, so two dispatches of the same list are judged one after the other.
      SELECT status INTO list_status FROM delivery_lists WHERE organization_id = NEW.organization_id AND id = NEW.delivery_list_id FOR UPDATE;
      IF list_status IS NULL OR list_status NOT IN ('ready', 'partially_dispatched') THEN
        RAISE EXCEPTION 'goods can be dispatched only against a Ready or Partially Dispatched delivery list' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM dispatch_lines WHERE organization_id = NEW.organization_id AND dispatch_id = NEW.id) THEN
        RAISE EXCEPTION 'a dispatch without lines cannot be confirmed' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      FOR over IN
        SELECT i.product_name AS product_name, i.quantity AS requested,
               mine.total + COALESCE((
                 SELECT sum(dl.quantity)
                   FROM dispatch_lines dl
                   JOIN dispatches d ON d.organization_id = dl.organization_id AND d.id = dl.dispatch_id
                  WHERE dl.organization_id = NEW.organization_id AND dl.delivery_list_item_id = i.id
                    AND d.id <> NEW.id AND d.status IN ('posting', 'confirmed')
               ), 0) AS total
          FROM (
            SELECT delivery_list_item_id, sum(quantity) AS total FROM dispatch_lines
             WHERE organization_id = NEW.organization_id AND dispatch_id = NEW.id GROUP BY delivery_list_item_id
          ) mine
          JOIN delivery_list_items i ON i.organization_id = NEW.organization_id AND i.id = mine.delivery_list_item_id
      LOOP
        IF over.total > over.requested THEN
          RAISE EXCEPTION 'dispatching % would exceed the quantity the client requested', over.product_name USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END LOOP;
    END IF;
    RETURN NEW;
  END IF;

  -- OLD.status = 'posting'
  IF NEW.status NOT IN ('posting', 'confirmed', 'draft') THEN
    RAISE EXCEPTION 'a dispatch that is being posted can only be confirmed, or returned to draft after a rejection' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.dispatch_date, NEW.delivery_address, NEW.transport_details, NEW.tracking_reference, NEW.notes)
     IS DISTINCT FROM (OLD.dispatch_date, OLD.delivery_address, OLD.transport_details, OLD.tracking_reference, OLD.notes) THEN
    RAISE EXCEPTION 'the details of a dispatch that is being posted are frozen' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'confirmed' AND EXISTS (
    SELECT 1 FROM dispatch_lines WHERE organization_id = NEW.organization_id AND dispatch_id = NEW.id AND inventory_movement_id IS NULL
  ) THEN
    RAISE EXCEPTION 'a dispatch cannot be confirmed before every line carries its inventory movement' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'draft' AND EXISTS (
    SELECT 1 FROM dispatch_lines WHERE organization_id = NEW.organization_id AND dispatch_id = NEW.id AND inventory_movement_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a dispatch with inventory movements cannot go back to draft' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$
"""

DISPATCH_LINES_GUARD = """
CREATE FUNCTION dispatch_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
     AND (NEW.warehouse_id, NEW.warehouse_code, NEW.quantity) IS NOT DISTINCT FROM (OLD.warehouse_id, OLD.warehouse_code, OLD.quantity) THEN
    RETURN NEW;  -- the one allowed change: recording which movement the Inventory Service made for this line
  END IF;
  RAISE EXCEPTION 'the lines of a dispatch that is % are frozen', dispatch_status USING ERRCODE = 'integrity_constraint_violation';
END
$$
"""


def upgrade() -> None:
    op.drop_constraint(op.f("ck_delivery_lists_status_valid"), "delivery_lists", type_="check")
    op.create_check_constraint(
        op.f("ck_delivery_lists_status_valid"), "delivery_lists",
        "status IN ('draft', 'ready', 'partially_dispatched', 'dispatched', 'cancelled')",
    )
    op.create_unique_constraint("uq_delivery_list_items_organization_id_id", "delivery_list_items", ["organization_id", "id"])

    op.create_table(
        "dispatch_counters",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("last_number", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_dispatch_counters")),
        sa.UniqueConstraint("organization_id", name="uq_dispatch_counters_organization_id"),
    )
    op.create_index(op.f("ix_dispatch_counters_organization_id"), "dispatch_counters", ["organization_id"], unique=False)

    op.create_table(
        "dispatches",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("delivery_list_id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("number", sa.String(length=32), nullable=False),
        sa.Column("dispatch_date", sa.Date(), nullable=False),
        sa.Column("delivery_address", sa.Text(), nullable=True),
        sa.Column("transport_details", sa.String(length=500), nullable=True),
        sa.Column("tracking_reference", sa.String(length=100), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=20), server_default=sa.text("'draft'"), nullable=False),
        sa.Column("posting_key", sa.String(length=100), nullable=False),
        sa.Column("posting_attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("posting_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_posting_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_posting_error", sa.Text(), nullable=True),
        sa.Column("inventory_operation_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("created_by_email", sa.String(length=320), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("confirmed_by_email", sa.String(length=320), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_by_email", sa.String(length=320), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("updated_at", **TIMESTAMP),
        sa.CheckConstraint("status IN ('draft', 'posting', 'confirmed', 'cancelled')", name=op.f("ck_dispatches_status_valid")),
        sa.CheckConstraint("posting_key = 'dispatch-' || CAST(id AS text)", name=op.f("ck_dispatches_posting_key_from_id")),
        sa.CheckConstraint("posting_attempts >= 0", name=op.f("ck_dispatches_posting_attempts_non_negative")),
        sa.CheckConstraint(
            "(status = 'confirmed') = (inventory_operation_id IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_by_email IS NOT NULL)",
            name=op.f("ck_dispatches_confirmed_only_when_posted"),
        ),
        sa.CheckConstraint("status = 'confirmed' OR (inventory_operation_id IS NULL AND confirmed_at IS NULL AND confirmed_by_email IS NULL)",
                           name=op.f("ck_dispatches_nothing_confirmed_before_confirmation")),
        sa.CheckConstraint("status <> 'cancelled' OR cancelled_at IS NOT NULL", name=op.f("ck_dispatches_cancelled_has_time")),
        sa.CheckConstraint("status <> 'posting' OR posting_started_at IS NOT NULL", name=op.f("ck_dispatches_posting_has_intent_time")),
        sa.ForeignKeyConstraint(["organization_id", "delivery_list_id"], ["delivery_lists.organization_id", "delivery_lists.id"],
                                name="fk_dispatches_delivery_list_same_organization", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["organization_id", "client_id"], ["clients.organization_id", "clients.id"],
                                name="fk_dispatches_client_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_dispatches")),
        sa.UniqueConstraint("organization_id", "number", name="uq_dispatches_organization_id_number"),
        sa.UniqueConstraint("organization_id", "id", name="uq_dispatches_organization_id_id"),
        sa.UniqueConstraint("organization_id", "posting_key", name="uq_dispatches_organization_id_posting_key"),
    )
    op.create_index(op.f("ix_dispatches_organization_id"), "dispatches", ["organization_id"], unique=False)
    op.create_index("ix_dispatches_organization_id_delivery_list_id", "dispatches", ["organization_id", "delivery_list_id"], unique=False)
    op.create_index("ix_dispatches_organization_id_client_id", "dispatches", ["organization_id", "client_id"], unique=False)
    op.create_index("ix_dispatches_organization_id_status", "dispatches", ["organization_id", "status"], unique=False)
    op.create_index("ix_dispatches_organization_id_dispatch_date", "dispatches", ["organization_id", "dispatch_date"], unique=False)

    op.create_table(
        "dispatch_requests",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=100), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("dispatch_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.ForeignKeyConstraint(["organization_id", "dispatch_id"], ["dispatches.organization_id", "dispatches.id"],
                                name="fk_dispatch_requests_dispatch_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_dispatch_requests")),
        sa.UniqueConstraint("organization_id", "idempotency_key", name="uq_dispatch_requests_organization_id_idempotency_key"),
    )
    op.create_index(op.f("ix_dispatch_requests_organization_id"), "dispatch_requests", ["organization_id"], unique=False)

    op.create_table(
        "dispatch_lines",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("dispatch_id", sa.Uuid(), nullable=False),
        sa.Column("delivery_list_item_id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("product_sku", sa.String(length=64), nullable=False),
        sa.Column("product_name", sa.String(length=255), nullable=False),
        sa.Column("unit", sa.String(length=20), nullable=False),
        sa.Column("warehouse_id", sa.Uuid(), nullable=False),
        sa.Column("warehouse_code", sa.String(length=32), nullable=True),
        sa.Column("quantity", sa.Numeric(precision=18, scale=4), nullable=False),
        sa.Column("inventory_movement_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("updated_at", **TIMESTAMP),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_dispatch_lines_quantity_positive")),
        sa.ForeignKeyConstraint(["organization_id", "dispatch_id"], ["dispatches.organization_id", "dispatches.id"],
                                name="fk_dispatch_lines_dispatch_same_organization", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["organization_id", "delivery_list_item_id"], ["delivery_list_items.organization_id", "delivery_list_items.id"],
                                name="fk_dispatch_lines_delivery_list_item_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_dispatch_lines")),
        sa.UniqueConstraint("organization_id", "dispatch_id", "delivery_list_item_id", "warehouse_id", name="uq_dispatch_lines_dispatch_item_warehouse"),
    )
    op.create_index(op.f("ix_dispatch_lines_organization_id"), "dispatch_lines", ["organization_id"], unique=False)
    op.create_index("ix_dispatch_lines_organization_id_dispatch_id", "dispatch_lines", ["organization_id", "dispatch_id"], unique=False)
    op.create_index("ix_dispatch_lines_organization_id_delivery_list_item_id", "dispatch_lines", ["organization_id", "delivery_list_item_id"], unique=False)

    op.execute(LISTS_LIFECYCLE)
    op.execute("CREATE TRIGGER trg_delivery_lists_lifecycle BEFORE UPDATE ON delivery_lists FOR EACH ROW EXECUTE FUNCTION delivery_lists_lifecycle()")
    op.execute(ITEMS_GUARD)
    op.execute("CREATE TRIGGER trg_delivery_list_items_guard BEFORE INSERT OR UPDATE OR DELETE ON delivery_list_items FOR EACH ROW EXECUTE FUNCTION delivery_list_items_guard()")
    op.execute(DISPATCHES_GUARD)
    op.execute("CREATE TRIGGER trg_dispatches_guard BEFORE INSERT OR UPDATE OR DELETE ON dispatches FOR EACH ROW EXECUTE FUNCTION dispatches_guard()")
    op.execute(DISPATCH_LINES_GUARD)
    op.execute("CREATE TRIGGER trg_dispatch_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON dispatch_lines FOR EACH ROW EXECUTE FUNCTION dispatch_lines_guard()")


def downgrade() -> None:
    for trigger, table, function in (
        ("trg_dispatch_lines_guard", "dispatch_lines", "dispatch_lines_guard"),
        ("trg_dispatches_guard", "dispatches", "dispatches_guard"),
        ("trg_delivery_list_items_guard", "delivery_list_items", "delivery_list_items_guard"),
        ("trg_delivery_lists_lifecycle", "delivery_lists", "delivery_lists_lifecycle"),
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {trigger} ON {table}")
        op.execute(f"DROP FUNCTION IF EXISTS {function}()")
    op.drop_table("dispatch_lines")
    op.drop_table("dispatch_requests")
    op.drop_table("dispatches")
    op.drop_table("dispatch_counters")
    op.execute("UPDATE delivery_lists SET status = 'ready' WHERE status IN ('partially_dispatched', 'dispatched')")
    op.drop_constraint(op.f("ck_delivery_lists_status_valid"), "delivery_lists", type_="check")
    op.create_check_constraint(op.f("ck_delivery_lists_status_valid"), "delivery_lists", "status IN ('draft', 'ready', 'cancelled')")
    op.drop_constraint("uq_delivery_list_items_organization_id_id", "delivery_list_items", type_="unique")
