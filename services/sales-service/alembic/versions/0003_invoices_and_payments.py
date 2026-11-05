"""sales invoices and client payments

Additive. No existing row is changed.

An invoice bills goods that were actually DISPATCHED: its lines are backed by ALLOCATIONS that point at confirmed dispatch lines, and the
quantity of a dispatch line that issued invoices already cover cannot be covered again (checked under a lock, in a trigger, when the
invoice is issued). Invoices never touch inventory: there is no stock column or table here.

Database rules (so that a bug in the application cannot break them):
  * invoice life cycle: draft -> issued | void;  issued -> void (only with no payment on record);  issued / partially_paid / paid follow the
    payments exactly (the status is DERIVED from the sum of the payment rows and checked on every change);  void is final;
  * an issued invoice is frozen (client, dates, currency, amounts, bill-to / seller snapshots) and is never deleted;
  * an invoice line, allocation and total are consistent: line amounts are exact (round to 4 decimals), the totals are the sums of the
    lines, the allocations of a line add up to its quantity, each allocation points at a CONFIRMED dispatch of the invoice's own client;
  * payments are append-only (never updated or deleted); a mistake is corrected by a REVERSAL row; a payment can be reversed once;
    a payment in the invoice's currency can never exceed the outstanding amount, and the invoice's paid total follows the payment rows.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-12
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TIMESTAMP = dict(type_=sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)
MONEY = sa.Numeric(precision=18, scale=4)


def _id():
    return sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False)


def _money(name, default=True, nullable=False):
    return sa.Column(name, MONEY, server_default=sa.text("0") if default else None, nullable=nullable)


INVOICES_GUARD = """
CREATE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  net numeric;
  derived text;
  line_count integer;
  line_sums record;
  over record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'invoices are never deleted; void a draft or an unpaid invoice instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.number IS NOT NULL OR NEW.paid_total <> 0 THEN
      RAISE EXCEPTION 'an invoice starts as an unnumbered, unpaid draft' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.organization_id, NEW.client_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.client_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'the identity of an invoice (id, organization, client, creator) can never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.status = 'void' THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'a void invoice is kept for history and can never be changed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'issued', 'void') THEN
      RAISE EXCEPTION 'a draft invoice can only be issued or voided' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.paid_total <> 0 THEN
      RAISE EXCEPTION 'a draft invoice has no payments' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status = 'draft' THEN
      IF NEW.number IS NOT NULL THEN RAISE EXCEPTION 'a draft invoice has no number yet' USING ERRCODE = 'integrity_constraint_violation'; END IF;
      RETURN NEW;
    END IF;
    IF NEW.status = 'void' THEN RETURN NEW; END IF;

    -- draft -> issued
    IF NEW.number IS NULL OR NEW.issued_at IS NULL OR NEW.issued_by IS NULL THEN
      RAISE EXCEPTION 'an issued invoice needs its number and who issued it, and when' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT count(*), COALESCE(sum(line_subtotal), 0) AS subtotal, COALESCE(sum(discount_amount), 0) AS discount, COALESCE(sum(line_tax), 0) AS tax, COALESCE(sum(line_total), 0) AS total
      INTO line_sums FROM invoice_lines WHERE organization_id = NEW.organization_id AND invoice_id = NEW.id;
    IF line_sums.count = 0 THEN
      RAISE EXCEPTION 'an invoice without lines cannot be issued' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (NEW.subtotal, NEW.discount_total, NEW.tax_total, NEW.total) IS DISTINCT FROM (line_sums.subtotal, line_sums.discount, line_sums.tax, line_sums.total) THEN
      RAISE EXCEPTION 'the totals of an invoice must be the sums of its lines' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.total <= 0 THEN
      RAISE EXCEPTION 'an invoice with a total of zero cannot be issued' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM invoice_lines l
       WHERE l.organization_id = NEW.organization_id AND l.invoice_id = NEW.id
         AND l.quantity IS DISTINCT FROM (SELECT COALESCE(sum(a.quantity), 0) FROM invoice_allocations a WHERE a.organization_id = l.organization_id AND a.invoice_line_id = l.id)
    ) THEN
      RAISE EXCEPTION 'every invoice line must be fully backed by dispatched goods' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- No dispatched quantity is invoiced twice: lock the dispatch lines (in a fixed order), then compare with the ISSUED invoices.
    PERFORM 1 FROM dispatch_lines WHERE organization_id = NEW.organization_id
        AND id IN (SELECT dispatch_line_id FROM invoice_allocations WHERE organization_id = NEW.organization_id AND invoice_id = NEW.id)
      ORDER BY id FOR UPDATE;
    FOR over IN
      SELECT dl.product_name AS product_name, dl.quantity AS dispatched,
             COALESCE(sum(a.quantity), 0) + COALESCE((
               SELECT sum(b.quantity) FROM invoice_allocations b JOIN invoices i ON i.organization_id = b.organization_id AND i.id = b.invoice_id
                WHERE b.organization_id = NEW.organization_id AND b.dispatch_line_id = dl.id AND i.id <> NEW.id AND i.status IN ('issued', 'partially_paid', 'paid')
             ), 0) AS billed
        FROM invoice_allocations a JOIN dispatch_lines dl ON dl.organization_id = a.organization_id AND dl.id = a.dispatch_line_id
       WHERE a.organization_id = NEW.organization_id AND a.invoice_id = NEW.id
       GROUP BY dl.id, dl.product_name, dl.quantity
    LOOP
      IF over.billed > over.dispatched THEN
        RAISE EXCEPTION 'billing % would invoice more than was dispatched', over.product_name USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  -- OLD.status is issued / partially_paid / paid: the commercial details are frozen
  IF ROW(NEW.organization_id, NEW.client_id, NEW.delivery_list_id, NEW.number, NEW.invoice_date, NEW.due_date, NEW.currency_code, NEW.notes, NEW.subtotal, NEW.discount_total,
         NEW.tax_total, NEW.total, NEW.seller_name, NEW.client_name, NEW.client_address, NEW.created_by_email, NEW.issued_at, NEW.issued_by, NEW.issued_by_email)
     IS DISTINCT FROM
     ROW(OLD.organization_id, OLD.client_id, OLD.delivery_list_id, OLD.number, OLD.invoice_date, OLD.due_date, OLD.currency_code, OLD.notes, OLD.subtotal, OLD.discount_total,
         OLD.tax_total, OLD.total, OLD.seller_name, OLD.client_name, OLD.client_address, OLD.created_by_email, OLD.issued_at, OLD.issued_by, OLD.issued_by_email) THEN
    RAISE EXCEPTION 'the details of an invoice that is % are frozen', OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT COALESCE(sum(CASE kind WHEN 'payment' THEN amount ELSE -amount END), 0) INTO net
    FROM invoice_payments WHERE organization_id = OLD.organization_id AND invoice_id = OLD.id;
  IF NEW.status = 'void' THEN
    IF net <> 0 OR OLD.paid_total <> 0 OR OLD.status <> 'issued' THEN
      RAISE EXCEPTION 'an invoice with payments on record cannot be voided; reverse the payments first' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.voided_at IS NULL OR NEW.void_reason IS NULL THEN
      RAISE EXCEPTION 'voiding an issued invoice needs its reason and time' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  derived := CASE WHEN net = 0 THEN 'issued' WHEN net >= OLD.total THEN 'paid' ELSE 'partially_paid' END;
  IF NEW.paid_total IS DISTINCT FROM net OR NEW.status IS DISTINCT FROM derived OR net < 0 OR net > OLD.total THEN
    RAISE EXCEPTION 'the paid amount and the payment status of an invoice must follow its recorded payments' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$
"""

LINES_GUARD = """
CREATE FUNCTION invoice_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice_status text;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id, NEW.invoice_id) IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.invoice_id) THEN
    RAISE EXCEPTION 'an invoice line cannot be moved to another invoice' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO invoice_status FROM invoices WHERE organization_id = NEW.organization_id AND id = NEW.invoice_id FOR SHARE;
  ELSE
    SELECT status INTO invoice_status FROM invoices WHERE organization_id = OLD.organization_id AND id = OLD.invoice_id FOR SHARE;
  END IF;
  IF invoice_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'the lines of an invoice that is % are frozen', invoice_status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$
"""

ALLOCATIONS_GUARD = """
CREATE FUNCTION invoice_allocations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice_status text;
  invoice_client uuid;
  source record;
  target record;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id, NEW.invoice_id, NEW.invoice_line_id, NEW.dispatch_line_id)
                           IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.invoice_id, OLD.invoice_line_id, OLD.dispatch_line_id) THEN
    RAISE EXCEPTION 'an invoice allocation cannot be re-pointed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status, client_id INTO invoice_status, invoice_client FROM invoices WHERE organization_id = NEW.organization_id AND id = NEW.invoice_id FOR SHARE;
  ELSE
    SELECT status, client_id INTO invoice_status, invoice_client FROM invoices WHERE organization_id = OLD.organization_id AND id = OLD.invoice_id FOR SHARE;
  END IF;
  IF invoice_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'the allocations of an invoice that is % are frozen', invoice_status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

  SELECT d.status AS dispatch_status, d.client_id AS dispatch_client, dl.product_id, dl.unit, dl.quantity INTO source
    FROM dispatch_lines dl JOIN dispatches d ON d.organization_id = dl.organization_id AND d.id = dl.dispatch_id
   WHERE dl.organization_id = NEW.organization_id AND dl.id = NEW.dispatch_line_id;
  IF NOT FOUND OR source.dispatch_status <> 'confirmed' THEN
    RAISE EXCEPTION 'only goods of a CONFIRMED dispatch can be invoiced' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF source.dispatch_client IS DISTINCT FROM invoice_client THEN
    RAISE EXCEPTION 'an invoice can bill only the dispatches of its own client' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.quantity > source.quantity THEN
    RAISE EXCEPTION 'an allocation cannot be larger than the dispatched quantity' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT invoice_id, product_id, unit INTO target FROM invoice_lines WHERE organization_id = NEW.organization_id AND id = NEW.invoice_line_id;
  IF NOT FOUND OR target.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
    RAISE EXCEPTION 'the allocation must belong to a line of the same invoice' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF target.product_id IS DISTINCT FROM source.product_id OR target.unit IS DISTINCT FROM source.unit THEN
    RAISE EXCEPTION 'an invoice line bills the product and unit that were dispatched' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$
"""

PAYMENTS_GUARD = """
CREATE FUNCTION invoice_payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice_row record;
  original record;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_ledger_maintenance', true) = 'on' THEN RETURN OLD; END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payments are never edited or deleted; record a reversal instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT status, total, paid_total, currency_code INTO invoice_row FROM invoices WHERE organization_id = NEW.organization_id AND id = NEW.invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown invoice' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.currency_code IS DISTINCT FROM invoice_row.currency_code THEN
    RAISE EXCEPTION 'a payment is in the currency of its invoice; nothing is converted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.kind = 'payment' THEN
    IF invoice_row.status NOT IN ('issued', 'partially_paid') THEN
      RAISE EXCEPTION 'payments can be recorded only against an issued invoice that is not yet paid' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.amount > invoice_row.total - invoice_row.paid_total THEN
      RAISE EXCEPTION 'a payment cannot exceed the outstanding amount of the invoice' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF invoice_row.status NOT IN ('issued', 'partially_paid', 'paid') THEN
      RAISE EXCEPTION 'only a payment on an issued invoice can be reversed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT invoice_id, kind, amount, currency_code INTO original FROM invoice_payments WHERE organization_id = NEW.organization_id AND id = NEW.reverses_payment_id;
    IF NOT FOUND OR original.invoice_id IS DISTINCT FROM NEW.invoice_id OR original.kind <> 'payment' THEN
      RAISE EXCEPTION 'a reversal must undo a payment of the same invoice' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.amount IS DISTINCT FROM original.amount THEN
      RAISE EXCEPTION 'a reversal undoes the whole payment' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$
"""

PAYMENTS_AFTER = """
CREATE FUNCTION invoice_payments_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  net numeric;
BEGIN
  SELECT COALESCE(sum(CASE kind WHEN 'payment' THEN amount ELSE -amount END), 0) INTO net
    FROM invoice_payments WHERE organization_id = NEW.organization_id AND invoice_id = NEW.invoice_id;
  UPDATE invoices
     SET paid_total = net,
         status = CASE WHEN net = 0 THEN 'issued' WHEN net >= total THEN 'paid' ELSE 'partially_paid' END,
         updated_at = now()
   WHERE organization_id = NEW.organization_id AND id = NEW.invoice_id;
  RETURN NULL;
END
$$
"""


def upgrade() -> None:
    op.create_unique_constraint("uq_dispatch_lines_organization_id_id", "dispatch_lines", ["organization_id", "id"])

    op.create_table(
        "invoice_counters",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("last_number", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invoice_counters")),
        sa.UniqueConstraint("organization_id", name="uq_invoice_counters_organization_id"),
    )
    op.create_index(op.f("ix_invoice_counters_organization_id"), "invoice_counters", ["organization_id"], unique=False)

    op.create_table(
        "invoices",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("delivery_list_id", sa.Uuid(), nullable=True),
        sa.Column("number", sa.String(length=32), nullable=True),
        sa.Column("status", sa.String(length=20), server_default=sa.text("'draft'"), nullable=False),
        sa.Column("invoice_date", sa.Date(), nullable=False),
        sa.Column("due_date", sa.Date(), nullable=False),
        sa.Column("currency_code", sa.String(length=3), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("seller_name", sa.String(length=255), nullable=True),
        sa.Column("client_name", sa.String(length=255), nullable=True),
        sa.Column("client_address", sa.Text(), nullable=True),
        _money("subtotal"),
        _money("discount_total"),
        _money("tax_total"),
        _money("total"),
        _money("paid_total"),
        sa.Column("outstanding", MONEY, sa.Computed("total - paid_total", persisted=True), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("created_by_email", sa.String(length=320), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("issued_by", sa.Uuid(), nullable=True),
        sa.Column("issued_by_email", sa.String(length=320), nullable=True),
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("voided_by_email", sa.String(length=320), nullable=True),
        sa.Column("void_reason", sa.String(length=500), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("updated_at", **TIMESTAMP),
        sa.CheckConstraint("status IN ('draft', 'issued', 'partially_paid', 'paid', 'void')", name=op.f("ck_invoices_status_valid")),
        sa.CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name=op.f("ck_invoices_currency_code_format")),
        sa.CheckConstraint("due_date >= invoice_date", name=op.f("ck_invoices_due_not_before_invoice")),
        sa.CheckConstraint("total = subtotal - discount_total + tax_total", name=op.f("ck_invoices_total_matches")),
        sa.CheckConstraint("subtotal >= 0 AND discount_total >= 0 AND tax_total >= 0 AND total >= 0", name=op.f("ck_invoices_amounts_non_negative")),
        sa.CheckConstraint("paid_total >= 0 AND paid_total <= total", name=op.f("ck_invoices_paid_within_total")),
        sa.CheckConstraint("status IN ('draft', 'void') OR number IS NOT NULL", name=op.f("ck_invoices_numbered_once_issued")),
        sa.CheckConstraint("status IN ('draft', 'void') OR (issued_at IS NOT NULL AND issued_by IS NOT NULL AND issued_by_email IS NOT NULL)", name=op.f("ck_invoices_issuer_recorded")),
        sa.CheckConstraint("status <> 'void' OR (voided_at IS NOT NULL AND voided_by_email IS NOT NULL)", name=op.f("ck_invoices_void_recorded")),
        sa.CheckConstraint("status = 'void' OR (voided_at IS NULL AND void_reason IS NULL)", name=op.f("ck_invoices_void_only_when_void")),
        sa.CheckConstraint("status NOT IN ('draft', 'void') OR paid_total = 0", name=op.f("ck_invoices_unpaid_unless_issued")),
        sa.ForeignKeyConstraint(["organization_id", "client_id"], ["clients.organization_id", "clients.id"], name="fk_invoices_client_same_organization", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["organization_id", "delivery_list_id"], ["delivery_lists.organization_id", "delivery_lists.id"],
                                name="fk_invoices_delivery_list_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invoices")),
        sa.UniqueConstraint("organization_id", "number", name="uq_invoices_organization_id_number"),
        sa.UniqueConstraint("organization_id", "id", name="uq_invoices_organization_id_id"),
    )
    op.create_index(op.f("ix_invoices_organization_id"), "invoices", ["organization_id"], unique=False)
    op.create_index("ix_invoices_organization_id_client_id", "invoices", ["organization_id", "client_id"], unique=False)
    op.create_index("ix_invoices_organization_id_status", "invoices", ["organization_id", "status"], unique=False)
    op.create_index("ix_invoices_organization_id_invoice_date", "invoices", ["organization_id", "invoice_date"], unique=False)

    op.create_table(
        "invoice_requests",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=100), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("invoice_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.ForeignKeyConstraint(["organization_id", "invoice_id"], ["invoices.organization_id", "invoices.id"], name="fk_invoice_requests_invoice_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invoice_requests")),
        sa.UniqueConstraint("organization_id", "idempotency_key", name="uq_invoice_requests_organization_id_idempotency_key"),
    )
    op.create_index(op.f("ix_invoice_requests_organization_id"), "invoice_requests", ["organization_id"], unique=False)

    op.create_table(
        "invoice_lines",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("invoice_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("product_sku", sa.String(length=64), nullable=False),
        sa.Column("product_name", sa.String(length=255), nullable=False),
        sa.Column("unit", sa.String(length=20), nullable=False),
        sa.Column("quantity", MONEY, nullable=False),
        sa.Column("unit_price", MONEY, nullable=False),
        sa.Column("discount_amount", MONEY, server_default=sa.text("0"), nullable=False),
        sa.Column("tax_rate", sa.Numeric(precision=7, scale=4), server_default=sa.text("0"), nullable=False),
        sa.Column("tax_label", sa.String(length=50), nullable=True),
        sa.Column("line_subtotal", MONEY, nullable=False),
        sa.Column("line_net", MONEY, nullable=False),
        sa.Column("line_tax", MONEY, nullable=False),
        sa.Column("line_total", MONEY, nullable=False),
        sa.Column("created_at", **TIMESTAMP),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_invoice_lines_quantity_positive")),
        sa.CheckConstraint("unit_price >= 0", name=op.f("ck_invoice_lines_unit_price_non_negative")),
        sa.CheckConstraint("discount_amount >= 0 AND discount_amount <= line_subtotal", name=op.f("ck_invoice_lines_discount_within_subtotal")),
        sa.CheckConstraint("tax_rate >= 0 AND tax_rate <= 100", name=op.f("ck_invoice_lines_tax_rate_range")),
        sa.CheckConstraint("line_subtotal = round(quantity * unit_price, 4)", name=op.f("ck_invoice_lines_subtotal_matches")),
        sa.CheckConstraint("line_net = line_subtotal - discount_amount", name=op.f("ck_invoice_lines_net_matches")),
        sa.CheckConstraint("line_tax = round(line_net * tax_rate / 100, 4)", name=op.f("ck_invoice_lines_tax_matches")),
        sa.CheckConstraint("line_total = line_net + line_tax", name=op.f("ck_invoice_lines_total_matches")),
        sa.ForeignKeyConstraint(["organization_id", "invoice_id"], ["invoices.organization_id", "invoices.id"], name="fk_invoice_lines_invoice_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invoice_lines")),
        sa.UniqueConstraint("organization_id", "id", name="uq_invoice_lines_organization_id_id"),
    )
    op.create_index(op.f("ix_invoice_lines_organization_id"), "invoice_lines", ["organization_id"], unique=False)
    op.create_index("ix_invoice_lines_organization_id_invoice_id", "invoice_lines", ["organization_id", "invoice_id"], unique=False)

    op.create_table(
        "invoice_allocations",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("invoice_id", sa.Uuid(), nullable=False),
        sa.Column("invoice_line_id", sa.Uuid(), nullable=False),
        sa.Column("dispatch_line_id", sa.Uuid(), nullable=False),
        sa.Column("quantity", MONEY, nullable=False),
        sa.Column("created_at", **TIMESTAMP),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_invoice_allocations_quantity_positive")),
        sa.ForeignKeyConstraint(["organization_id", "invoice_id"], ["invoices.organization_id", "invoices.id"], name="fk_invoice_allocations_invoice_same_organization", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["organization_id", "invoice_line_id"], ["invoice_lines.organization_id", "invoice_lines.id"],
                                name="fk_invoice_allocations_invoice_line_same_organization", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["organization_id", "dispatch_line_id"], ["dispatch_lines.organization_id", "dispatch_lines.id"],
                                name="fk_invoice_allocations_dispatch_line_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invoice_allocations")),
        sa.UniqueConstraint("organization_id", "invoice_line_id", "dispatch_line_id", name="uq_invoice_allocations_line_dispatch_line"),
    )
    op.create_index(op.f("ix_invoice_allocations_organization_id"), "invoice_allocations", ["organization_id"], unique=False)
    op.create_index("ix_invoice_allocations_organization_id_invoice_id", "invoice_allocations", ["organization_id", "invoice_id"], unique=False)
    op.create_index("ix_invoice_allocations_organization_id_dispatch_line_id", "invoice_allocations", ["organization_id", "dispatch_line_id"], unique=False)

    op.create_table(
        "invoice_payments",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("invoice_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=10), server_default=sa.text("'payment'"), nullable=False),
        sa.Column("reverses_payment_id", sa.Uuid(), nullable=True),
        sa.Column("payment_date", sa.Date(), nullable=False),
        sa.Column("amount", MONEY, nullable=False),
        sa.Column("currency_code", sa.String(length=3), nullable=False),
        sa.Column("method", sa.String(length=20), nullable=False),
        sa.Column("reference", sa.String(length=100), nullable=True),
        sa.Column("notes", sa.String(length=500), nullable=True),
        sa.Column("idempotency_key", sa.String(length=100), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("recorded_by", sa.Uuid(), nullable=False),
        sa.Column("recorded_by_email", sa.String(length=320), nullable=False),
        sa.Column("created_at", **TIMESTAMP),
        sa.CheckConstraint("kind IN ('payment', 'reversal')", name=op.f("ck_invoice_payments_kind_valid")),
        sa.CheckConstraint("(kind = 'reversal') = (reverses_payment_id IS NOT NULL)", name=op.f("ck_invoice_payments_reversal_links_a_payment")),
        sa.CheckConstraint("kind = 'payment' OR (notes IS NOT NULL AND notes <> '')", name=op.f("ck_invoice_payments_reversal_has_reason")),
        sa.CheckConstraint("amount > 0", name=op.f("ck_invoice_payments_amount_positive")),
        sa.CheckConstraint("currency_code ~ '^[A-Z]{3}$'", name=op.f("ck_invoice_payments_currency_code_format")),
        sa.CheckConstraint("method IN ('cash', 'bank_transfer', 'cheque', 'card', 'mobile_wallet', 'other')", name=op.f("ck_invoice_payments_method_valid")),
        sa.ForeignKeyConstraint(["organization_id", "invoice_id"], ["invoices.organization_id", "invoices.id"], name="fk_invoice_payments_invoice_same_organization", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["organization_id", "reverses_payment_id"], ["invoice_payments.organization_id", "invoice_payments.id"],
                                name="fk_invoice_payments_reversed_payment_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invoice_payments")),
        sa.UniqueConstraint("organization_id", "id", name="uq_invoice_payments_organization_id_id"),
        sa.UniqueConstraint("organization_id", "idempotency_key", name="uq_invoice_payments_organization_id_idempotency_key"),
        sa.UniqueConstraint("organization_id", "reverses_payment_id", name="uq_invoice_payments_organization_id_reverses_payment_id"),
    )
    op.create_index(op.f("ix_invoice_payments_organization_id"), "invoice_payments", ["organization_id"], unique=False)
    op.create_index("ix_invoice_payments_organization_id_invoice_id", "invoice_payments", ["organization_id", "invoice_id"], unique=False)

    op.execute(INVOICES_GUARD)
    op.execute("CREATE TRIGGER trg_invoices_guard BEFORE INSERT OR UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_guard()")
    op.execute(LINES_GUARD)
    op.execute("CREATE TRIGGER trg_invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard()")
    op.execute(ALLOCATIONS_GUARD)
    op.execute("CREATE TRIGGER trg_invoice_allocations_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_allocations FOR EACH ROW EXECUTE FUNCTION invoice_allocations_guard()")
    op.execute(PAYMENTS_GUARD)
    op.execute("CREATE TRIGGER trg_invoice_payments_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_payments FOR EACH ROW EXECUTE FUNCTION invoice_payments_guard()")
    op.execute(PAYMENTS_AFTER)
    op.execute("CREATE TRIGGER trg_invoice_payments_apply AFTER INSERT ON invoice_payments FOR EACH ROW EXECUTE FUNCTION invoice_payments_apply()")


def downgrade() -> None:
    for trigger, table, function in (
        ("trg_invoice_payments_apply", "invoice_payments", "invoice_payments_apply"),
        ("trg_invoice_payments_guard", "invoice_payments", "invoice_payments_guard"),
        ("trg_invoice_allocations_guard", "invoice_allocations", "invoice_allocations_guard"),
        ("trg_invoice_lines_guard", "invoice_lines", "invoice_lines_guard"),
        ("trg_invoices_guard", "invoices", "invoices_guard"),
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {trigger} ON {table}")
        op.execute(f"DROP FUNCTION IF EXISTS {function}()")
    op.drop_table("invoice_payments")
    op.drop_table("invoice_allocations")
    op.drop_table("invoice_lines")
    op.drop_table("invoice_requests")
    op.drop_table("invoices")
    op.drop_table("invoice_counters")
    op.drop_constraint("uq_dispatch_lines_organization_id_id", "dispatch_lines", type_="unique")
