"""goods receiving: receipts, partial receiving, and the database rules that protect them

Additive. No existing row is changed: every existing purchase order keeps its status (draft / ordered / cancelled), its lines and its totals.

Part 1 - a correction to the Step 16A line freeze. The old trigger judged a line by the order named in the NEW row only, so an
UPDATE that re-pointed a line of an Ordered order at a Draft order (or the other way round) slipped past it. A line now belongs to
one order of one organization for its whole life (id, organization_id and purchase_order_id can never change), and the order's
identity (id, organization, number, creator) is immutable too.

Part 2 - the order gets two more states, Partially Received and Received. Moves are database-enforced:
    draft -> ordered | cancelled;   ordered -> partially_received | received | cancelled;   partially_received -> received.
An order with goods received (or being received) can never be cancelled, and it may only be called Received when every line is
fully received (Partially Received: some but not all), judged from the CONFIRMED receipts.

Part 3 - goods receipts (drafts, then posting, then confirmed; or cancelled). The database refuses: deleting a receipt, changing a
confirmed or cancelled receipt in any way, changing a receipt that is being posted (except its bookkeeping), confirming one before
every accepted line carries its Inventory movement, a line that is not on the receipt's purchase order or in another product or
unit than the order line, and receiving more than was ordered (checked under a lock on the order when a receipt starts posting).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-07
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TIMESTAMP = dict(type_=sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)
MAINTENANCE = "current_setting('app.allow_ledger_maintenance', true) = 'on'"


def _id():
    return sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False)


# ---- the functions as they were in 0001 (restored by downgrade) -----------------------------------------------------------------
OLD_LIFECYCLE = """
CREATE OR REPLACE FUNCTION purchase_orders_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
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

OLD_LINES_FROZEN = """
CREATE OR REPLACE FUNCTION purchase_order_lines_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
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

# ---- Part 1 + 2: the purchase order and its lines -------------------------------------------------------------------------------
NEW_LIFECYCLE = """
CREATE OR REPLACE FUNCTION purchase_orders_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  open_lines integer;
  received_total numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'purchase orders are never deleted; cancel the order instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.number, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.number, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'the identity of a purchase order (id, organization, number, creator) can never change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'ordered', 'cancelled') THEN
      RAISE EXCEPTION 'a draft purchase order can only be placed or cancelled' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status = 'ordered' AND NOT EXISTS (
      SELECT 1 FROM purchase_order_lines WHERE organization_id = OLD.organization_id AND purchase_order_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'a purchase order without lines cannot be marked Ordered' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'ordered' AND NEW.status IN ('cancelled', 'partially_received', 'received'))
    OR (OLD.status = 'partially_received' AND NEW.status = 'received')
  ) THEN
    RAISE EXCEPTION 'a purchase order that is % cannot become %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.organization_id, NEW.number, NEW.supplier_id, NEW.supplier_reference, NEW.order_date, NEW.expected_delivery_date,
      NEW.currency_code, NEW.notes, NEW.created_by, NEW.created_by_email, NEW.created_at, NEW.ordered_at, NEW.ordered_by_email)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.number, OLD.supplier_id, OLD.supplier_reference, OLD.order_date, OLD.expected_delivery_date,
      OLD.currency_code, OLD.notes, OLD.created_by, OLD.created_by_email, OLD.created_at, OLD.ordered_at, OLD.ordered_by_email) THEN
    RAISE EXCEPTION 'the details of a purchase order that is % are frozen', OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'cancelled' AND EXISTS (
      SELECT 1 FROM goods_receipts
       WHERE organization_id = OLD.organization_id AND purchase_order_id = OLD.id AND status IN ('posting', 'confirmed')
    ) THEN
      RAISE EXCEPTION 'a purchase order with goods received (or being received) cannot be cancelled'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status IN ('partially_received', 'received') THEN
      SELECT count(*) FILTER (WHERE received < ordered), COALESCE(sum(received), 0)
        INTO open_lines, received_total
        FROM (
          SELECT l.quantity AS ordered,
                 COALESCE((
                   SELECT sum(rl.accepted_quantity)
                     FROM goods_receipt_lines rl
                     JOIN goods_receipts r ON r.organization_id = rl.organization_id AND r.id = rl.goods_receipt_id
                    WHERE rl.organization_id = l.organization_id AND rl.purchase_order_line_id = l.id AND r.status = 'confirmed'
                 ), 0) AS received
            FROM purchase_order_lines l
           WHERE l.organization_id = OLD.organization_id AND l.purchase_order_id = OLD.id
        ) x;
      IF NEW.status = 'received' AND open_lines > 0 THEN
        RAISE EXCEPTION 'a purchase order is Received only when every line is fully received'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status = 'partially_received' AND (received_total = 0 OR open_lines = 0) THEN
        RAISE EXCEPTION 'a purchase order is Partially Received only when some, but not all, of the goods are received'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$
"""

NEW_LINES_FROZEN = """
CREATE OR REPLACE FUNCTION purchase_order_lines_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_status text;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id, NEW.purchase_order_id)
                          IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.purchase_order_id) THEN
    RAISE EXCEPTION 'a purchase order line cannot be moved to another order or organization'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Because a line can never change order, the order named by the row being changed (OLD for UPDATE and DELETE) is the only one.
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO order_status FROM purchase_orders WHERE organization_id = NEW.organization_id AND id = NEW.purchase_order_id FOR SHARE;
  ELSE
    SELECT status INTO order_status FROM purchase_orders WHERE organization_id = OLD.organization_id AND id = OLD.purchase_order_id FOR SHARE;
  END IF;
  IF order_status IS NOT NULL AND order_status <> 'draft' THEN
    RAISE EXCEPTION 'the lines of a purchase order that is % are frozen', order_status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$
"""

# ---- Part 3: goods receipts -----------------------------------------------------------------------------------------------------
RECEIPTS_GUARD = """
CREATE FUNCTION goods_receipts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_status text;
  over record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'goods receipts are never deleted; cancel a draft instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a goods receipt starts as a draft' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT status INTO order_status FROM purchase_orders WHERE organization_id = NEW.organization_id AND id = NEW.purchase_order_id FOR SHARE;
    IF order_status IS NULL OR order_status NOT IN ('ordered', 'partially_received') THEN
      RAISE EXCEPTION 'goods can be received only against an Ordered or Partially Received purchase order' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.organization_id, NEW.purchase_order_id, NEW.number, NEW.posting_key, NEW.created_by, NEW.created_by_email, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.purchase_order_id, OLD.number, OLD.posting_key, OLD.created_by, OLD.created_by_email, OLD.created_at) THEN
    RAISE EXCEPTION 'the identity of a goods receipt can never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.status IN ('confirmed', 'cancelled') THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'a goods receipt that is % can never be changed', OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'posting', 'cancelled') THEN
      RAISE EXCEPTION 'a draft goods receipt can only be confirmed (posted) or cancelled' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status = 'posting' THEN
      -- The intent to add stock. The order is locked first, so two receipts of the same order are judged one after the other.
      SELECT status INTO order_status FROM purchase_orders WHERE organization_id = NEW.organization_id AND id = NEW.purchase_order_id FOR UPDATE;
      IF order_status IS NULL OR order_status NOT IN ('ordered', 'partially_received') THEN
        RAISE EXCEPTION 'goods can be received only against an Ordered or Partially Received purchase order' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM goods_receipt_lines WHERE organization_id = NEW.organization_id AND goods_receipt_id = NEW.id AND accepted_quantity > 0
      ) THEN
        RAISE EXCEPTION 'a goods receipt that accepts nothing cannot be confirmed' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      FOR over IN
        SELECT pl.product_name AS product_name, pl.quantity AS ordered,
               mine.accepted_quantity + COALESCE((
                 SELECT sum(rl.accepted_quantity)
                   FROM goods_receipt_lines rl
                   JOIN goods_receipts r ON r.organization_id = rl.organization_id AND r.id = rl.goods_receipt_id
                  WHERE rl.organization_id = NEW.organization_id AND rl.purchase_order_line_id = pl.id
                    AND r.id <> NEW.id AND r.status IN ('posting', 'confirmed')
               ), 0) AS total
          FROM goods_receipt_lines mine
          JOIN purchase_order_lines pl ON pl.organization_id = mine.organization_id AND pl.id = mine.purchase_order_line_id
         WHERE mine.organization_id = NEW.organization_id AND mine.goods_receipt_id = NEW.id
      LOOP
        IF over.total > over.ordered THEN
          RAISE EXCEPTION 'receiving % would exceed the ordered quantity', over.product_name USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END LOOP;
    END IF;
    RETURN NEW;
  END IF;

  -- OLD.status = 'posting'
  IF NEW.status NOT IN ('posting', 'confirmed', 'draft') THEN
    RAISE EXCEPTION 'a goods receipt that is being posted can only be confirmed, or returned to draft after a rejection' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.supplier_reference, NEW.received_date, NEW.notes) IS DISTINCT FROM (OLD.supplier_reference, OLD.received_date, OLD.notes) THEN
    RAISE EXCEPTION 'the details of a goods receipt that is being posted are frozen' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'confirmed' AND EXISTS (
    SELECT 1 FROM goods_receipt_lines
     WHERE organization_id = NEW.organization_id AND goods_receipt_id = NEW.id AND accepted_quantity > 0 AND inventory_movement_id IS NULL
  ) THEN
    RAISE EXCEPTION 'a goods receipt cannot be confirmed before every accepted line carries its inventory movement' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'draft' AND EXISTS (
    SELECT 1 FROM goods_receipt_lines WHERE organization_id = NEW.organization_id AND goods_receipt_id = NEW.id AND inventory_movement_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a goods receipt with inventory movements cannot go back to draft' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$
"""

RECEIPT_LINES_GUARD = """
CREATE FUNCTION goods_receipt_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
     AND (NEW.warehouse_id, NEW.warehouse_code, NEW.accepted_quantity, NEW.rejected_quantity, NEW.notes)
         IS NOT DISTINCT FROM (OLD.warehouse_id, OLD.warehouse_code, OLD.accepted_quantity, OLD.rejected_quantity, OLD.notes) THEN
    RETURN NEW;  -- the one allowed change: recording which movement the Inventory Service made for this line
  END IF;
  RAISE EXCEPTION 'the lines of a goods receipt that is % are frozen', receipt_status USING ERRCODE = 'integrity_constraint_violation';
END
$$
"""


def upgrade() -> None:
    # ---- tables ---------------------------------------------------------------------------------------------------------------------
    op.drop_constraint(op.f("ck_purchase_orders_status_valid"), "purchase_orders", type_="check")
    op.create_check_constraint(
        op.f("ck_purchase_orders_status_valid"), "purchase_orders",
        "status IN ('draft', 'ordered', 'partially_received', 'received', 'cancelled')",
    )
    op.create_unique_constraint("uq_purchase_order_lines_organization_id_id", "purchase_order_lines", ["organization_id", "id"])

    op.create_table(
        "goods_receipt_counters",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("last_number", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goods_receipt_counters")),
        sa.UniqueConstraint("organization_id", name="uq_goods_receipt_counters_organization_id"),
    )
    op.create_index(op.f("ix_goods_receipt_counters_organization_id"), "goods_receipt_counters", ["organization_id"], unique=False)

    op.create_table(
        "goods_receipts",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("purchase_order_id", sa.Uuid(), nullable=False),
        sa.Column("number", sa.String(length=32), nullable=False),
        sa.Column("supplier_reference", sa.String(length=100), nullable=True),
        sa.Column("received_date", sa.Date(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=20), server_default=sa.text("'draft'"), nullable=False),
        # the stable Idempotency-Key for the Inventory Service, derived from the receipt id: every retry of the same receipt uses it
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
        sa.CheckConstraint("status IN ('draft', 'posting', 'confirmed', 'cancelled')", name=op.f("ck_goods_receipts_status_valid")),
        sa.CheckConstraint("posting_key = 'goods-receipt-' || CAST(id AS text)", name=op.f("ck_goods_receipts_posting_key_from_id")),
        sa.CheckConstraint("posting_attempts >= 0", name=op.f("ck_goods_receipts_posting_attempts_non_negative")),
        sa.CheckConstraint(
            "(status = 'confirmed') = (inventory_operation_id IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_by_email IS NOT NULL)",
            name=op.f("ck_goods_receipts_confirmed_only_when_posted"),
        ),
        sa.CheckConstraint("status = 'confirmed' OR (inventory_operation_id IS NULL AND confirmed_at IS NULL AND confirmed_by_email IS NULL)",
                           name=op.f("ck_goods_receipts_nothing_confirmed_before_confirmation")),
        sa.CheckConstraint("status <> 'cancelled' OR cancelled_at IS NOT NULL", name=op.f("ck_goods_receipts_cancelled_has_time")),
        sa.CheckConstraint("status <> 'posting' OR posting_started_at IS NOT NULL", name=op.f("ck_goods_receipts_posting_has_intent_time")),
        sa.ForeignKeyConstraint(["organization_id", "purchase_order_id"], ["purchase_orders.organization_id", "purchase_orders.id"],
                                name="fk_goods_receipts_purchase_order_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goods_receipts")),
        sa.UniqueConstraint("organization_id", "number", name="uq_goods_receipts_organization_id_number"),
        sa.UniqueConstraint("organization_id", "id", name="uq_goods_receipts_organization_id_id"),
        sa.UniqueConstraint("organization_id", "posting_key", name="uq_goods_receipts_organization_id_posting_key"),
    )
    op.create_index(op.f("ix_goods_receipts_organization_id"), "goods_receipts", ["organization_id"], unique=False)
    op.create_index("ix_goods_receipts_organization_id_purchase_order_id", "goods_receipts", ["organization_id", "purchase_order_id"], unique=False)
    op.create_index("ix_goods_receipts_organization_id_status", "goods_receipts", ["organization_id", "status"], unique=False)
    op.create_index("ix_goods_receipts_organization_id_received_date", "goods_receipts", ["organization_id", "received_date"], unique=False)

    op.create_table(
        "goods_receipt_requests",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=100), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("goods_receipt_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.ForeignKeyConstraint(["organization_id", "goods_receipt_id"], ["goods_receipts.organization_id", "goods_receipts.id"],
                                name="fk_goods_receipt_requests_goods_receipt_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goods_receipt_requests")),
        sa.UniqueConstraint("organization_id", "idempotency_key", name="uq_goods_receipt_requests_organization_id_idempotency_key"),
    )
    op.create_index(op.f("ix_goods_receipt_requests_organization_id"), "goods_receipt_requests", ["organization_id"], unique=False)

    op.create_table(
        "goods_receipt_lines",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("goods_receipt_id", sa.Uuid(), nullable=False),
        sa.Column("purchase_order_line_id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("product_sku", sa.String(length=64), nullable=False),
        sa.Column("product_name", sa.String(length=255), nullable=False),
        sa.Column("unit", sa.String(length=20), nullable=False),
        sa.Column("warehouse_id", sa.Uuid(), nullable=True),
        sa.Column("warehouse_code", sa.String(length=32), nullable=True),
        sa.Column("accepted_quantity", sa.Numeric(precision=18, scale=4), server_default=sa.text("0"), nullable=False),
        sa.Column("rejected_quantity", sa.Numeric(precision=18, scale=4), server_default=sa.text("0"), nullable=False),
        sa.Column("notes", sa.String(length=500), nullable=True),
        sa.Column("inventory_movement_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("updated_at", **TIMESTAMP),
        sa.CheckConstraint("accepted_quantity >= 0", name=op.f("ck_goods_receipt_lines_accepted_non_negative")),
        sa.CheckConstraint("rejected_quantity >= 0", name=op.f("ck_goods_receipt_lines_rejected_non_negative")),
        sa.CheckConstraint("accepted_quantity + rejected_quantity > 0", name=op.f("ck_goods_receipt_lines_something_received")),
        sa.CheckConstraint("accepted_quantity = 0 OR warehouse_id IS NOT NULL", name=op.f("ck_goods_receipt_lines_warehouse_when_accepted")),
        sa.CheckConstraint("inventory_movement_id IS NULL OR accepted_quantity > 0", name=op.f("ck_goods_receipt_lines_movement_only_when_accepted")),
        sa.ForeignKeyConstraint(["organization_id", "goods_receipt_id"], ["goods_receipts.organization_id", "goods_receipts.id"],
                                name="fk_goods_receipt_lines_goods_receipt_same_organization", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["organization_id", "purchase_order_line_id"], ["purchase_order_lines.organization_id", "purchase_order_lines.id"],
                                name="fk_goods_receipt_lines_purchase_order_line_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goods_receipt_lines")),
        sa.UniqueConstraint("organization_id", "goods_receipt_id", "purchase_order_line_id", name="uq_goods_receipt_lines_receipt_order_line"),
    )
    op.create_index(op.f("ix_goods_receipt_lines_organization_id"), "goods_receipt_lines", ["organization_id"], unique=False)
    op.create_index("ix_goods_receipt_lines_organization_id_goods_receipt_id", "goods_receipt_lines", ["organization_id", "goods_receipt_id"], unique=False)
    op.create_index("ix_goods_receipt_lines_organization_id_purchase_order_line_id", "goods_receipt_lines", ["organization_id", "purchase_order_line_id"], unique=False)

    # ---- the rules ------------------------------------------------------------------------------------------------------------------
    op.execute(NEW_LIFECYCLE)
    op.execute(NEW_LINES_FROZEN)
    op.execute(RECEIPTS_GUARD)
    op.execute(
        "CREATE TRIGGER trg_goods_receipts_guard BEFORE INSERT OR UPDATE OR DELETE ON goods_receipts "
        "FOR EACH ROW EXECUTE FUNCTION goods_receipts_guard()"
    )
    op.execute(RECEIPT_LINES_GUARD)
    op.execute(
        "CREATE TRIGGER trg_goods_receipt_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON goods_receipt_lines "
        "FOR EACH ROW EXECUTE FUNCTION goods_receipt_lines_guard()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_goods_receipt_lines_guard ON goods_receipt_lines")
    op.execute("DROP TRIGGER IF EXISTS trg_goods_receipts_guard ON goods_receipts")
    op.execute("DROP FUNCTION IF EXISTS goods_receipt_lines_guard()")
    op.execute("DROP FUNCTION IF EXISTS goods_receipts_guard()")
    op.drop_table("goods_receipt_lines")
    op.drop_table("goods_receipt_requests")
    op.drop_table("goods_receipts")
    op.drop_table("goods_receipt_counters")

    # orders that were received (wholly or partly) go back to "ordered" so the old status check can be restored
    op.execute("ALTER TABLE purchase_orders DISABLE TRIGGER trg_purchase_orders_lifecycle")
    op.execute("UPDATE purchase_orders SET status = 'ordered' WHERE status IN ('partially_received', 'received')")
    op.execute("ALTER TABLE purchase_orders ENABLE TRIGGER trg_purchase_orders_lifecycle")
    op.drop_constraint(op.f("ck_purchase_orders_status_valid"), "purchase_orders", type_="check")
    op.create_check_constraint(op.f("ck_purchase_orders_status_valid"), "purchase_orders", "status IN ('draft', 'ordered', 'cancelled')")
    op.drop_constraint("uq_purchase_order_lines_organization_id_id", "purchase_order_lines", type_="unique")
    op.execute(OLD_LINES_FROZEN)
    op.execute(OLD_LIFECYCLE)
