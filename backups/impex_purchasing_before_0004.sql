--
-- PostgreSQL database dump
--

\restrict avhN49OzJDloaeObHtSKQ4zItrpZs4oqa9kWtTEOyXWxTDsaFE5bCsIeQlJQU2z

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: goods_receipt_lines_guard(); Type: FUNCTION; Schema: public; Owner: impex_admin
--

CREATE FUNCTION public.goods_receipt_lines_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


ALTER FUNCTION public.goods_receipt_lines_guard() OWNER TO impex_admin;

--
-- Name: goods_receipts_guard(); Type: FUNCTION; Schema: public; Owner: impex_admin
--

CREATE FUNCTION public.goods_receipts_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


ALTER FUNCTION public.goods_receipts_guard() OWNER TO impex_admin;

--
-- Name: purchase_order_lines_frozen(); Type: FUNCTION; Schema: public; Owner: impex_admin
--

CREATE FUNCTION public.purchase_order_lines_frozen() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


ALTER FUNCTION public.purchase_order_lines_frozen() OWNER TO impex_admin;

--
-- Name: purchase_orders_lifecycle(); Type: FUNCTION; Schema: public; Owner: impex_admin
--

CREATE FUNCTION public.purchase_orders_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


ALTER FUNCTION public.purchase_orders_lifecycle() OWNER TO impex_admin;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alembic_version; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.alembic_version (
    version_num character varying(32) NOT NULL
);


ALTER TABLE public.alembic_version OWNER TO impex_admin;

--
-- Name: goods_receipt_counters; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.goods_receipt_counters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    last_number integer DEFAULT 0 NOT NULL
);


ALTER TABLE public.goods_receipt_counters OWNER TO impex_admin;

--
-- Name: goods_receipt_lines; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.goods_receipt_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    goods_receipt_id uuid NOT NULL,
    purchase_order_line_id uuid NOT NULL,
    product_id uuid NOT NULL,
    product_sku character varying(64) NOT NULL,
    product_name character varying(255) NOT NULL,
    unit character varying(20) NOT NULL,
    accepted_quantity numeric(18,4) DEFAULT 0 NOT NULL,
    rejected_quantity numeric(18,4) DEFAULT 0 NOT NULL,
    notes character varying(500),
    inventory_movement_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_goods_receipt_lines_accepted_non_negative CHECK ((accepted_quantity >= (0)::numeric)),
    CONSTRAINT ck_goods_receipt_lines_movement_only_when_accepted CHECK (((inventory_movement_id IS NULL) OR (accepted_quantity > (0)::numeric))),
    CONSTRAINT ck_goods_receipt_lines_rejected_non_negative CHECK ((rejected_quantity >= (0)::numeric)),
    CONSTRAINT ck_goods_receipt_lines_something_received CHECK (((accepted_quantity + rejected_quantity) > (0)::numeric))
);


ALTER TABLE public.goods_receipt_lines OWNER TO impex_admin;

--
-- Name: goods_receipt_requests; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.goods_receipt_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    idempotency_key character varying(100) NOT NULL,
    request_hash character varying(64) NOT NULL,
    goods_receipt_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.goods_receipt_requests OWNER TO impex_admin;

--
-- Name: goods_receipts; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.goods_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    purchase_order_id uuid NOT NULL,
    number character varying(32) NOT NULL,
    supplier_reference character varying(100),
    received_date date NOT NULL,
    notes text,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    posting_key character varying(100) NOT NULL,
    posting_attempts integer DEFAULT 0 NOT NULL,
    posting_started_at timestamp with time zone,
    last_posting_attempt_at timestamp with time zone,
    last_posting_error text,
    inventory_operation_id uuid,
    created_by uuid NOT NULL,
    created_by_email character varying(320) NOT NULL,
    confirmed_at timestamp with time zone,
    confirmed_by_email character varying(320),
    cancelled_at timestamp with time zone,
    cancelled_by_email character varying(320),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_goods_receipts_cancelled_has_time CHECK ((((status)::text <> 'cancelled'::text) OR (cancelled_at IS NOT NULL))),
    CONSTRAINT ck_goods_receipts_confirmed_only_when_posted CHECK ((((status)::text = 'confirmed'::text) = ((inventory_operation_id IS NOT NULL) AND (confirmed_at IS NOT NULL) AND (confirmed_by_email IS NOT NULL)))),
    CONSTRAINT ck_goods_receipts_nothing_confirmed_before_confirmation CHECK ((((status)::text = 'confirmed'::text) OR ((inventory_operation_id IS NULL) AND (confirmed_at IS NULL) AND (confirmed_by_email IS NULL)))),
    CONSTRAINT ck_goods_receipts_posting_attempts_non_negative CHECK ((posting_attempts >= 0)),
    CONSTRAINT ck_goods_receipts_posting_has_intent_time CHECK ((((status)::text <> 'posting'::text) OR (posting_started_at IS NOT NULL))),
    CONSTRAINT ck_goods_receipts_posting_key_from_id CHECK (((posting_key)::text = ('goods-receipt-'::text || (id)::text))),
    CONSTRAINT ck_goods_receipts_status_valid CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'posting'::character varying, 'confirmed'::character varying, 'cancelled'::character varying])::text[])))
);


ALTER TABLE public.goods_receipts OWNER TO impex_admin;

--
-- Name: purchase_order_counters; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.purchase_order_counters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    last_number integer DEFAULT 0 NOT NULL
);


ALTER TABLE public.purchase_order_counters OWNER TO impex_admin;

--
-- Name: purchase_order_lines; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.purchase_order_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    purchase_order_id uuid NOT NULL,
    product_id uuid NOT NULL,
    product_sku character varying(64) NOT NULL,
    product_name character varying(255) NOT NULL,
    unit character varying(20) NOT NULL,
    quantity numeric(18,4) NOT NULL,
    unit_price numeric(18,4) NOT NULL,
    line_total numeric(18,4) NOT NULL,
    notes character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_purchase_order_lines_line_total_matches CHECK ((line_total = round((quantity * unit_price), 4))),
    CONSTRAINT ck_purchase_order_lines_quantity_positive CHECK ((quantity > (0)::numeric)),
    CONSTRAINT ck_purchase_order_lines_unit_price_non_negative CHECK ((unit_price >= (0)::numeric))
);


ALTER TABLE public.purchase_order_lines OWNER TO impex_admin;

--
-- Name: purchase_order_requests; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.purchase_order_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    idempotency_key character varying(100) NOT NULL,
    request_hash character varying(64) NOT NULL,
    purchase_order_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.purchase_order_requests OWNER TO impex_admin;

--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.purchase_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    number character varying(32) NOT NULL,
    supplier_reference character varying(100),
    order_date date NOT NULL,
    expected_delivery_date date,
    currency_code character varying(3) NOT NULL,
    notes text,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    created_by uuid NOT NULL,
    created_by_email character varying(320) NOT NULL,
    ordered_at timestamp with time zone,
    ordered_by_email character varying(320),
    cancelled_at timestamp with time zone,
    cancelled_by_email character varying(320),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_purchase_orders_currency_code_format CHECK (((currency_code)::text ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT ck_purchase_orders_expected_not_before_order CHECK (((expected_delivery_date IS NULL) OR (expected_delivery_date >= order_date))),
    CONSTRAINT ck_purchase_orders_status_valid CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'ordered'::character varying, 'partially_received'::character varying, 'received'::character varying, 'cancelled'::character varying])::text[])))
);


ALTER TABLE public.purchase_orders OWNER TO impex_admin;

--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.suppliers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    name_key character varying(255) NOT NULL,
    code character varying(32),
    contact_person character varying(255),
    email character varying(320),
    phone character varying(50),
    address text,
    country_code character varying(2),
    tax_identifier character varying(50),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_suppliers_country_code_format CHECK (((country_code IS NULL) OR ((country_code)::text ~ '^[A-Z]{2}$'::text)))
);


ALTER TABLE public.suppliers OWNER TO impex_admin;

--
-- Data for Name: alembic_version; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.alembic_version (version_num) FROM stdin;
0003
\.


--
-- Data for Name: goods_receipt_counters; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.goods_receipt_counters (id, organization_id, last_number) FROM stdin;
\.


--
-- Data for Name: goods_receipt_lines; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.goods_receipt_lines (id, organization_id, goods_receipt_id, purchase_order_line_id, product_id, product_sku, product_name, unit, accepted_quantity, rejected_quantity, notes, inventory_movement_id, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: goods_receipt_requests; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.goods_receipt_requests (id, organization_id, idempotency_key, request_hash, goods_receipt_id, created_at) FROM stdin;
\.


--
-- Data for Name: goods_receipts; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.goods_receipts (id, organization_id, purchase_order_id, number, supplier_reference, received_date, notes, status, posting_key, posting_attempts, posting_started_at, last_posting_attempt_at, last_posting_error, inventory_operation_id, created_by, created_by_email, confirmed_at, confirmed_by_email, cancelled_at, cancelled_by_email, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: purchase_order_counters; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.purchase_order_counters (id, organization_id, last_number) FROM stdin;
9775dce1-a2e3-4559-b5d9-0cb18dd1dfa1	401dc009-d310-42ae-be14-567d5e0c4546	1
\.


--
-- Data for Name: purchase_order_lines; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.purchase_order_lines (id, organization_id, purchase_order_id, product_id, product_sku, product_name, unit, quantity, unit_price, line_total, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: purchase_order_requests; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.purchase_order_requests (id, organization_id, idempotency_key, request_hash, purchase_order_id, created_at) FROM stdin;
bade0993-0b2c-493d-8e84-d10467a8eb78	401dc009-d310-42ae-be14-567d5e0c4546	ui-c2636669-c6f7-4690-83c2-80b028fb9a53	d9a05c5950c87482f91a05d5b4796b637b6532234eddc9c6d0eeea436067687e	f6a4bf2d-73b3-4a7c-b931-25bb0204d076	2026-11-08 01:26:48.204232+00
\.


--
-- Data for Name: purchase_orders; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.purchase_orders (id, organization_id, supplier_id, number, supplier_reference, order_date, expected_delivery_date, currency_code, notes, status, created_by, created_by_email, ordered_at, ordered_by_email, cancelled_at, cancelled_by_email, created_at, updated_at) FROM stdin;
f6a4bf2d-73b3-4a7c-b931-25bb0204d076	401dc009-d310-42ae-be14-567d5e0c4546	bd880887-f985-4a29-8df5-f9e3ac06ba5b	PO-000001	\N	2026-11-08	2026-12-12	USD	\N	draft	d47e3ac2-2fb6-4ad0-b3d7-b107c33a094a	org.admin.test@example.com	\N	\N	\N	\N	2026-11-08 01:26:48.204232+00	2026-11-08 01:26:48.204232+00
\.


--
-- Data for Name: suppliers; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.suppliers (id, organization_id, name, name_key, code, contact_person, email, phone, address, country_code, tax_identifier, is_active, created_at, updated_at) FROM stdin;
bd880887-f985-4a29-8df5-f9e3ac06ba5b	401dc009-d310-42ae-be14-567d5e0c4546	Shopify	shopify	\N	Muhammad	muhammad@gmail.com	\N	\N	PK	\N	t	2026-11-08 01:25:11.126727+00	2026-11-08 01:25:11.126727+00
b5164def-1b4e-4d07-aee0-2b599f9edd67	401dc009-d310-42ae-be14-567d5e0c4546	Amazon	amazon	\N	\N	\N	\N	\N	\N	\N	f	2026-11-11 18:57:49.49164+00	2026-11-11 18:57:57.314239+00
\.


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: goods_receipt_counters pk_goods_receipt_counters; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipt_counters
    ADD CONSTRAINT pk_goods_receipt_counters PRIMARY KEY (id);


--
-- Name: goods_receipt_lines pk_goods_receipt_lines; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipt_lines
    ADD CONSTRAINT pk_goods_receipt_lines PRIMARY KEY (id);


--
-- Name: goods_receipt_requests pk_goods_receipt_requests; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipt_requests
    ADD CONSTRAINT pk_goods_receipt_requests PRIMARY KEY (id);


--
-- Name: goods_receipts pk_goods_receipts; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipts
    ADD CONSTRAINT pk_goods_receipts PRIMARY KEY (id);


--
-- Name: purchase_order_counters pk_purchase_order_counters; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.purchase_order_counters
    ADD CONSTRAINT pk_purchase_order_counters PRIMARY KEY (id);


--
-- Name: purchase_order_lines pk_purchase_order_lines; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT pk_purchase_order_lines PRIMARY KEY (id);


--
-- Name: purchase_order_requests pk_purchase_order_requests; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.purchase_order_requests
    ADD CONSTRAINT pk_purchase_order_requests PRIMARY KEY (id);


--
-- Name: purchase_orders pk_purchase_orders; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT pk_purchase_orders PRIMARY KEY (id);


--
-- Name: suppliers pk_suppliers; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT pk_suppliers PRIMARY KEY (id);


--
-- Name: goods_receipt_counters uq_goods_receipt_counters_organization_id; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipt_counters
    ADD CONSTRAINT uq_goods_receipt_counters_organization_id UNIQUE (organization_id);


--
-- Name: goods_receipt_lines uq_goods_receipt_lines_receipt_order_line; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipt_lines
    ADD CONSTRAINT uq_goods_receipt_lines_receipt_order_line UNIQUE (organization_id, goods_receipt_id, purchase_order_line_id);


--
-- Name: goods_receipt_requests uq_goods_receipt_requests_organization_id_idempotency_key; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipt_requests
    ADD CONSTRAINT uq_goods_receipt_requests_organization_id_idempotency_key UNIQUE (organization_id, idempotency_key);


--
-- Name: goods_receipts uq_goods_receipts_organization_id_id; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipts
    ADD CONSTRAINT uq_goods_receipts_organization_id_id UNIQUE (organization_id, id);


--
-- Name: goods_receipts uq_goods_receipts_organization_id_number; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipts
    ADD CONSTRAINT uq_goods_receipts_organization_id_number UNIQUE (organization_id, number);


--
-- Name: goods_receipts uq_goods_receipts_organization_id_posting_key; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipts
    ADD CONSTRAINT uq_goods_receipts_organization_id_posting_key UNIQUE (organization_id, posting_key);


--
-- Name: purchase_order_counters uq_purchase_order_counters_organization_id; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.purchase_order_counters
    ADD CONSTRAINT uq_purchase_order_counters_organization_id UNIQUE (organization_id);


--
-- Name: purchase_order_lines uq_purchase_order_lines_order_product; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT uq_purchase_order_lines_order_product UNIQUE (organization_id, purchase_order_id, product_id);


--
-- Name: purchase_order_lines uq_purchase_order_lines_organization_id_id; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT uq_purchase_order_lines_organization_id_id UNIQUE (organization_id, id);


--
-- Name: purchase_order_requests uq_purchase_order_requests_organization_id_idempotency_key; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.purchase_order_requests
    ADD CONSTRAINT uq_purchase_order_requests_organization_id_idempotency_key UNIQUE (organization_id, idempotency_key);


--
-- Name: purchase_orders uq_purchase_orders_organization_id_id; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT uq_purchase_orders_organization_id_id UNIQUE (organization_id, id);


--
-- Name: purchase_orders uq_purchase_orders_organization_id_number; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT uq_purchase_orders_organization_id_number UNIQUE (organization_id, number);


--
-- Name: suppliers uq_suppliers_organization_id_code; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT uq_suppliers_organization_id_code UNIQUE (organization_id, code);


--
-- Name: suppliers uq_suppliers_organization_id_id; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT uq_suppliers_organization_id_id UNIQUE (organization_id, id);


--
-- Name: suppliers uq_suppliers_organization_id_name_key; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT uq_suppliers_organization_id_name_key UNIQUE (organization_id, name_key);


--
-- Name: ix_goods_receipt_counters_organization_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_goods_receipt_counters_organization_id ON public.goods_receipt_counters USING btree (organization_id);


--
-- Name: ix_goods_receipt_lines_organization_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_goods_receipt_lines_organization_id ON public.goods_receipt_lines USING btree (organization_id);


--
-- Name: ix_goods_receipt_lines_organization_id_goods_receipt_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_goods_receipt_lines_organization_id_goods_receipt_id ON public.goods_receipt_lines USING btree (organization_id, goods_receipt_id);


--
-- Name: ix_goods_receipt_lines_organization_id_purchase_order_line_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_goods_receipt_lines_organization_id_purchase_order_line_id ON public.goods_receipt_lines USING btree (organization_id, purchase_order_line_id);


--
-- Name: ix_goods_receipt_requests_organization_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_goods_receipt_requests_organization_id ON public.goods_receipt_requests USING btree (organization_id);


--
-- Name: ix_goods_receipts_organization_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_goods_receipts_organization_id ON public.goods_receipts USING btree (organization_id);


--
-- Name: ix_goods_receipts_organization_id_purchase_order_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_goods_receipts_organization_id_purchase_order_id ON public.goods_receipts USING btree (organization_id, purchase_order_id);


--
-- Name: ix_goods_receipts_organization_id_received_date; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_goods_receipts_organization_id_received_date ON public.goods_receipts USING btree (organization_id, received_date);


--
-- Name: ix_goods_receipts_organization_id_status; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_goods_receipts_organization_id_status ON public.goods_receipts USING btree (organization_id, status);


--
-- Name: ix_purchase_order_counters_organization_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_purchase_order_counters_organization_id ON public.purchase_order_counters USING btree (organization_id);


--
-- Name: ix_purchase_order_lines_organization_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_purchase_order_lines_organization_id ON public.purchase_order_lines USING btree (organization_id);


--
-- Name: ix_purchase_order_lines_organization_id_purchase_order_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_purchase_order_lines_organization_id_purchase_order_id ON public.purchase_order_lines USING btree (organization_id, purchase_order_id);


--
-- Name: ix_purchase_order_requests_organization_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_purchase_order_requests_organization_id ON public.purchase_order_requests USING btree (organization_id);


--
-- Name: ix_purchase_orders_organization_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_purchase_orders_organization_id ON public.purchase_orders USING btree (organization_id);


--
-- Name: ix_purchase_orders_organization_id_status; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_purchase_orders_organization_id_status ON public.purchase_orders USING btree (organization_id, status);


--
-- Name: ix_purchase_orders_organization_id_supplier_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_purchase_orders_organization_id_supplier_id ON public.purchase_orders USING btree (organization_id, supplier_id);


--
-- Name: ix_suppliers_organization_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_suppliers_organization_id ON public.suppliers USING btree (organization_id);


--
-- Name: goods_receipt_lines trg_goods_receipt_lines_guard; Type: TRIGGER; Schema: public; Owner: impex_admin
--

CREATE TRIGGER trg_goods_receipt_lines_guard BEFORE INSERT OR DELETE OR UPDATE ON public.goods_receipt_lines FOR EACH ROW EXECUTE FUNCTION public.goods_receipt_lines_guard();


--
-- Name: goods_receipts trg_goods_receipts_guard; Type: TRIGGER; Schema: public; Owner: impex_admin
--

CREATE TRIGGER trg_goods_receipts_guard BEFORE INSERT OR DELETE OR UPDATE ON public.goods_receipts FOR EACH ROW EXECUTE FUNCTION public.goods_receipts_guard();


--
-- Name: purchase_order_lines trg_purchase_order_lines_frozen; Type: TRIGGER; Schema: public; Owner: impex_admin
--

CREATE TRIGGER trg_purchase_order_lines_frozen BEFORE INSERT OR DELETE OR UPDATE ON public.purchase_order_lines FOR EACH ROW EXECUTE FUNCTION public.purchase_order_lines_frozen();


--
-- Name: purchase_orders trg_purchase_orders_lifecycle; Type: TRIGGER; Schema: public; Owner: impex_admin
--

CREATE TRIGGER trg_purchase_orders_lifecycle BEFORE DELETE OR UPDATE ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION public.purchase_orders_lifecycle();


--
-- Name: goods_receipt_lines fk_goods_receipt_lines_goods_receipt_same_organization; Type: FK CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipt_lines
    ADD CONSTRAINT fk_goods_receipt_lines_goods_receipt_same_organization FOREIGN KEY (organization_id, goods_receipt_id) REFERENCES public.goods_receipts(organization_id, id) ON DELETE RESTRICT;


--
-- Name: goods_receipt_lines fk_goods_receipt_lines_purchase_order_line_same_organization; Type: FK CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipt_lines
    ADD CONSTRAINT fk_goods_receipt_lines_purchase_order_line_same_organization FOREIGN KEY (organization_id, purchase_order_line_id) REFERENCES public.purchase_order_lines(organization_id, id) ON DELETE RESTRICT;


--
-- Name: goods_receipt_requests fk_goods_receipt_requests_goods_receipt_same_organization; Type: FK CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipt_requests
    ADD CONSTRAINT fk_goods_receipt_requests_goods_receipt_same_organization FOREIGN KEY (organization_id, goods_receipt_id) REFERENCES public.goods_receipts(organization_id, id) ON DELETE RESTRICT;


--
-- Name: goods_receipts fk_goods_receipts_purchase_order_same_organization; Type: FK CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.goods_receipts
    ADD CONSTRAINT fk_goods_receipts_purchase_order_same_organization FOREIGN KEY (organization_id, purchase_order_id) REFERENCES public.purchase_orders(organization_id, id) ON DELETE RESTRICT;


--
-- Name: purchase_order_lines fk_purchase_order_lines_purchase_order_same_organization; Type: FK CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT fk_purchase_order_lines_purchase_order_same_organization FOREIGN KEY (organization_id, purchase_order_id) REFERENCES public.purchase_orders(organization_id, id) ON DELETE CASCADE;


--
-- Name: purchase_order_requests fk_purchase_order_requests_purchase_order_same_organization; Type: FK CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.purchase_order_requests
    ADD CONSTRAINT fk_purchase_order_requests_purchase_order_same_organization FOREIGN KEY (organization_id, purchase_order_id) REFERENCES public.purchase_orders(organization_id, id) ON DELETE RESTRICT;


--
-- Name: purchase_orders fk_purchase_orders_supplier_same_organization; Type: FK CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT fk_purchase_orders_supplier_same_organization FOREIGN KEY (organization_id, supplier_id) REFERENCES public.suppliers(organization_id, id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict avhN49OzJDloaeObHtSKQ4zItrpZs4oqa9kWtTEOyXWxTDsaFE5bCsIeQlJQU2z

