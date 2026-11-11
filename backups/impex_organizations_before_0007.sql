--
-- PostgreSQL database dump
--

\restrict 9alox5BAIVfBhAxwD1a0ew2wshS9cczbP0YjGbXXXOyNjlPBr1PPtnxycIgIA85

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
-- Name: organization_module_history_guard(); Type: FUNCTION; Schema: public; Owner: impex_admin
--

CREATE FUNCTION public.organization_module_history_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('app.allow_ledger_maintenance', true) = 'on' AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'the module history is append-only (% refused)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END
$$;


ALTER FUNCTION public.organization_module_history_guard() OWNER TO impex_admin;

--
-- Name: organization_settings_history_guard(); Type: FUNCTION; Schema: public; Owner: impex_admin
--

CREATE FUNCTION public.organization_settings_history_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('app.allow_ledger_maintenance', true) = 'on' AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'the settings history is append-only (% refused)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END
$$;


ALTER FUNCTION public.organization_settings_history_guard() OWNER TO impex_admin;

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
-- Name: organization_invitations; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.organization_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    email character varying(320) NOT NULL,
    token_hash character varying(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    full_name character varying(255)
);


ALTER TABLE public.organization_invitations OWNER TO impex_admin;

--
-- Name: organization_module_history; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.organization_module_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint NOT NULL,
    organization_id uuid NOT NULL,
    module_key character varying(30) NOT NULL,
    action character varying(10) NOT NULL,
    old_enabled boolean,
    new_enabled boolean NOT NULL,
    changed_by uuid,
    changed_by_name character varying(255),
    changed_by_email character varying(320),
    reason character varying(500),
    batch_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_organization_module_history_action_valid CHECK (((action)::text = ANY ((ARRAY['seeded'::character varying, 'migrated'::character varying, 'enabled'::character varying, 'disabled'::character varying])::text[])))
);


ALTER TABLE public.organization_module_history OWNER TO impex_admin;

--
-- Name: organization_module_history_seq_seq; Type: SEQUENCE; Schema: public; Owner: impex_admin
--

ALTER TABLE public.organization_module_history ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.organization_module_history_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: organization_modules; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.organization_modules (
    organization_id uuid NOT NULL,
    module_key character varying(30) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.organization_modules OWNER TO impex_admin;

--
-- Name: organization_settings_history; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.organization_settings_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint NOT NULL,
    organization_id uuid NOT NULL,
    section character varying(20) NOT NULL,
    field character varying(40) NOT NULL,
    old_value text,
    new_value text,
    changed_by uuid,
    changed_by_name character varying(255),
    changed_by_email character varying(320),
    source character varying(20) DEFAULT 'settings'::character varying NOT NULL,
    version integer NOT NULL,
    batch_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_organization_settings_history_section_valid CHECK (((section)::text = ANY ((ARRAY['company'::character varying, 'branding'::character varying, 'preferences'::character varying])::text[])))
);


ALTER TABLE public.organization_settings_history OWNER TO impex_admin;

--
-- Name: organization_settings_history_seq_seq; Type: SEQUENCE; Schema: public; Owner: impex_admin
--

ALTER TABLE public.organization_settings_history ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.organization_settings_history_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(100) NOT NULL,
    country_code character varying(10) NOT NULL,
    tax_identifier character varying(100),
    contact_email character varying(320) NOT NULL,
    primary_admin_email character varying(320),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    setup_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    setup_completed_at timestamp with time zone,
    setup_completed_by uuid,
    logo_storage_key character varying(255),
    logo_content_type character varying(50),
    logo_updated_at timestamp with time zone,
    contact_phone character varying(40),
    address_street character varying(255),
    address_city character varying(120),
    address_state character varying(120),
    address_postal_code character varying(30),
    website character varying(255),
    description character varying(1000),
    default_currency character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    timezone character varying(64) DEFAULT 'UTC'::character varying NOT NULL,
    date_format character varying(10) DEFAULT 'YYYY-MM-DD'::character varying NOT NULL,
    number_format character varying(12) DEFAULT 'comma_dot'::character varying NOT NULL,
    settings_version integer DEFAULT 1 NOT NULL,
    settings_updated_at timestamp with time zone,
    settings_updated_by uuid,
    CONSTRAINT ck_organizations_completed_has_a_time CHECK ((((setup_status)::text <> 'completed'::text) OR (setup_completed_at IS NOT NULL))),
    CONSTRAINT ck_organizations_date_format_valid CHECK (((date_format)::text = ANY ((ARRAY['DD/MM/YYYY'::character varying, 'MM/DD/YYYY'::character varying, 'YYYY-MM-DD'::character varying])::text[]))),
    CONSTRAINT ck_organizations_default_currency_valid CHECK (((default_currency)::text ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT ck_organizations_logo_key_and_type_together CHECK (((logo_storage_key IS NULL) = (logo_content_type IS NULL))),
    CONSTRAINT ck_organizations_number_format_valid CHECK (((number_format)::text = ANY ((ARRAY['comma_dot'::character varying, 'dot_comma'::character varying, 'space_comma'::character varying, 'indian'::character varying])::text[]))),
    CONSTRAINT ck_organizations_settings_version_positive CHECK ((settings_version >= 1)),
    CONSTRAINT ck_organizations_setup_status_valid CHECK (((setup_status)::text = ANY ((ARRAY['pending'::character varying, 'in_progress'::character varying, 'completed'::character varying])::text[])))
);


ALTER TABLE public.organizations OWNER TO impex_admin;

--
-- Data for Name: alembic_version; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.alembic_version (version_num) FROM stdin;
0006
\.


--
-- Data for Name: organization_invitations; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.organization_invitations (id, organization_id, email, token_hash, expires_at, accepted_at, revoked_at, created_at, full_name) FROM stdin;
\.


--
-- Data for Name: organization_module_history; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.organization_module_history (id, seq, organization_id, module_key, action, old_enabled, new_enabled, changed_by, changed_by_name, changed_by_email, reason, batch_id, created_at) FROM stdin;
726969f6-6acc-43b6-9de8-acd18cd7543e	1	de24b5cf-d75f-401f-a971-e5ce1e252f35	inventory	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	de24b5cf-d75f-401f-a971-e5ce1e252f35	2026-11-06 20:59:02.92926+00
19976db8-39c5-4873-8496-b83d599548d8	2	de24b5cf-d75f-401f-a971-e5ce1e252f35	purchasing	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	de24b5cf-d75f-401f-a971-e5ce1e252f35	2026-11-06 20:59:02.92926+00
033e0328-1be9-4c68-a05f-745c65d51ec4	3	de24b5cf-d75f-401f-a971-e5ce1e252f35	sales	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	de24b5cf-d75f-401f-a971-e5ce1e252f35	2026-11-06 20:59:02.92926+00
b2a4b678-1b0f-456e-a7b1-44f00d6ccf41	4	de24b5cf-d75f-401f-a971-e5ce1e252f35	finance	migrated	\N	f	\N	System	\N	Existing organization: keeps the modules it could already use	de24b5cf-d75f-401f-a971-e5ce1e252f35	2026-11-06 20:59:02.92926+00
e540e8eb-ad97-46c3-ba80-4700ff3ff8aa	5	9b049652-7d52-48d3-ba7a-ecc42d1725bf	inventory	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	9b049652-7d52-48d3-ba7a-ecc42d1725bf	2026-11-06 20:59:02.92926+00
d92ac5d1-161f-4afb-a40b-02222521ac10	6	9b049652-7d52-48d3-ba7a-ecc42d1725bf	purchasing	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	9b049652-7d52-48d3-ba7a-ecc42d1725bf	2026-11-06 20:59:02.92926+00
d38200eb-58d7-4316-899b-8d008c529af9	7	9b049652-7d52-48d3-ba7a-ecc42d1725bf	sales	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	9b049652-7d52-48d3-ba7a-ecc42d1725bf	2026-11-06 20:59:02.92926+00
523f3e42-e49d-4892-a4a2-e193ca433f5b	8	9b049652-7d52-48d3-ba7a-ecc42d1725bf	finance	migrated	\N	f	\N	System	\N	Existing organization: keeps the modules it could already use	9b049652-7d52-48d3-ba7a-ecc42d1725bf	2026-11-06 20:59:02.92926+00
6138fe2e-4708-4beb-a398-465644229f1e	9	2105af1b-6e55-4ec4-bc36-3ae5251e2475	inventory	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	2105af1b-6e55-4ec4-bc36-3ae5251e2475	2026-11-06 20:59:02.92926+00
86666f5c-8b14-481d-bded-6cc52bebc2e3	10	2105af1b-6e55-4ec4-bc36-3ae5251e2475	purchasing	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	2105af1b-6e55-4ec4-bc36-3ae5251e2475	2026-11-06 20:59:02.92926+00
2cfb1606-b328-48f3-a59d-dd8a32dd7c87	11	2105af1b-6e55-4ec4-bc36-3ae5251e2475	sales	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	2105af1b-6e55-4ec4-bc36-3ae5251e2475	2026-11-06 20:59:02.92926+00
d694752c-7456-4ad0-9b23-b047f08d8258	12	2105af1b-6e55-4ec4-bc36-3ae5251e2475	finance	migrated	\N	f	\N	System	\N	Existing organization: keeps the modules it could already use	2105af1b-6e55-4ec4-bc36-3ae5251e2475	2026-11-06 20:59:02.92926+00
d00c6e99-5359-4195-9a8f-315dc815ce50	13	affff01c-e82f-4de6-a989-25dcab67c634	inventory	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	affff01c-e82f-4de6-a989-25dcab67c634	2026-11-06 20:59:02.92926+00
e65e7dd8-5ec2-4b02-b306-048c3f321f9b	14	affff01c-e82f-4de6-a989-25dcab67c634	purchasing	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	affff01c-e82f-4de6-a989-25dcab67c634	2026-11-06 20:59:02.92926+00
b2a276f7-1e96-4610-864f-3fc4c5fb05be	15	affff01c-e82f-4de6-a989-25dcab67c634	sales	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	affff01c-e82f-4de6-a989-25dcab67c634	2026-11-06 20:59:02.92926+00
6b35c742-df4b-4f0a-b3d3-82a3ed15290d	16	affff01c-e82f-4de6-a989-25dcab67c634	finance	migrated	\N	f	\N	System	\N	Existing organization: keeps the modules it could already use	affff01c-e82f-4de6-a989-25dcab67c634	2026-11-06 20:59:02.92926+00
d871d06b-0333-43f3-9d14-fd5e7b4a87b7	17	401dc009-d310-42ae-be14-567d5e0c4546	inventory	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	401dc009-d310-42ae-be14-567d5e0c4546	2026-11-06 20:59:02.92926+00
e7892f0d-4cc9-45a8-a1e4-64c5de694b5c	18	401dc009-d310-42ae-be14-567d5e0c4546	purchasing	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	401dc009-d310-42ae-be14-567d5e0c4546	2026-11-06 20:59:02.92926+00
2ab8e982-3db8-4f0e-afdc-a34e028bac59	19	401dc009-d310-42ae-be14-567d5e0c4546	sales	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	401dc009-d310-42ae-be14-567d5e0c4546	2026-11-06 20:59:02.92926+00
1417291c-5e7e-4fc8-9281-a809c9cfcd13	20	401dc009-d310-42ae-be14-567d5e0c4546	finance	migrated	\N	f	\N	System	\N	Existing organization: keeps the modules it could already use	401dc009-d310-42ae-be14-567d5e0c4546	2026-11-06 20:59:02.92926+00
4a1c9b19-5996-4ef8-97e4-3efea9ad78f1	21	bc3b13f9-6e7d-4f40-8f31-0df3fa242375	inventory	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	bc3b13f9-6e7d-4f40-8f31-0df3fa242375	2026-11-06 20:59:02.92926+00
17a31c67-a42d-438c-99a2-e7acf90807c7	22	bc3b13f9-6e7d-4f40-8f31-0df3fa242375	purchasing	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	bc3b13f9-6e7d-4f40-8f31-0df3fa242375	2026-11-06 20:59:02.92926+00
1ea93be7-9d2d-4dfd-b962-0d1584679d6e	23	bc3b13f9-6e7d-4f40-8f31-0df3fa242375	sales	migrated	\N	t	\N	System	\N	Existing organization: keeps the modules it could already use	bc3b13f9-6e7d-4f40-8f31-0df3fa242375	2026-11-06 20:59:02.92926+00
12bccfaa-94d8-4590-b241-61388838b15c	24	bc3b13f9-6e7d-4f40-8f31-0df3fa242375	finance	migrated	\N	f	\N	System	\N	Existing organization: keeps the modules it could already use	bc3b13f9-6e7d-4f40-8f31-0df3fa242375	2026-11-06 20:59:02.92926+00
c8aee3d1-9966-4d8c-a533-8aa0ca26c2c4	614	401dc009-d310-42ae-be14-567d5e0c4546	finance	enabled	f	t	5cffccb9-ffe3-4328-9e67-5e8e0f2cb1b4	Syed Zain Mehdi	mehdizain784@gmail.com	done	400583ef-a361-41ce-b2bf-25b4dfb5f725	2026-11-07 15:50:08.757753+00
\.


--
-- Data for Name: organization_modules; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.organization_modules (organization_id, module_key, enabled, updated_by, updated_at) FROM stdin;
de24b5cf-d75f-401f-a971-e5ce1e252f35	inventory	t	\N	2026-11-06 20:59:02.92926+00
de24b5cf-d75f-401f-a971-e5ce1e252f35	purchasing	t	\N	2026-11-06 20:59:02.92926+00
de24b5cf-d75f-401f-a971-e5ce1e252f35	sales	t	\N	2026-11-06 20:59:02.92926+00
de24b5cf-d75f-401f-a971-e5ce1e252f35	finance	f	\N	2026-11-06 20:59:02.92926+00
9b049652-7d52-48d3-ba7a-ecc42d1725bf	inventory	t	\N	2026-11-06 20:59:02.92926+00
9b049652-7d52-48d3-ba7a-ecc42d1725bf	purchasing	t	\N	2026-11-06 20:59:02.92926+00
9b049652-7d52-48d3-ba7a-ecc42d1725bf	sales	t	\N	2026-11-06 20:59:02.92926+00
9b049652-7d52-48d3-ba7a-ecc42d1725bf	finance	f	\N	2026-11-06 20:59:02.92926+00
2105af1b-6e55-4ec4-bc36-3ae5251e2475	inventory	t	\N	2026-11-06 20:59:02.92926+00
2105af1b-6e55-4ec4-bc36-3ae5251e2475	purchasing	t	\N	2026-11-06 20:59:02.92926+00
2105af1b-6e55-4ec4-bc36-3ae5251e2475	sales	t	\N	2026-11-06 20:59:02.92926+00
2105af1b-6e55-4ec4-bc36-3ae5251e2475	finance	f	\N	2026-11-06 20:59:02.92926+00
affff01c-e82f-4de6-a989-25dcab67c634	inventory	t	\N	2026-11-06 20:59:02.92926+00
affff01c-e82f-4de6-a989-25dcab67c634	purchasing	t	\N	2026-11-06 20:59:02.92926+00
affff01c-e82f-4de6-a989-25dcab67c634	sales	t	\N	2026-11-06 20:59:02.92926+00
affff01c-e82f-4de6-a989-25dcab67c634	finance	f	\N	2026-11-06 20:59:02.92926+00
401dc009-d310-42ae-be14-567d5e0c4546	inventory	t	\N	2026-11-06 20:59:02.92926+00
401dc009-d310-42ae-be14-567d5e0c4546	purchasing	t	\N	2026-11-06 20:59:02.92926+00
401dc009-d310-42ae-be14-567d5e0c4546	sales	t	\N	2026-11-06 20:59:02.92926+00
bc3b13f9-6e7d-4f40-8f31-0df3fa242375	inventory	t	\N	2026-11-06 20:59:02.92926+00
bc3b13f9-6e7d-4f40-8f31-0df3fa242375	purchasing	t	\N	2026-11-06 20:59:02.92926+00
bc3b13f9-6e7d-4f40-8f31-0df3fa242375	sales	t	\N	2026-11-06 20:59:02.92926+00
bc3b13f9-6e7d-4f40-8f31-0df3fa242375	finance	f	\N	2026-11-06 20:59:02.92926+00
401dc009-d310-42ae-be14-567d5e0c4546	finance	t	5cffccb9-ffe3-4328-9e67-5e8e0f2cb1b4	2026-11-07 15:50:08.757753+00
\.


--
-- Data for Name: organization_settings_history; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.organization_settings_history (id, seq, organization_id, section, field, old_value, new_value, changed_by, changed_by_name, changed_by_email, source, version, batch_id, created_at) FROM stdin;
d5a9eb84-b898-45eb-b962-10052519f2b3	280	401dc009-d310-42ae-be14-567d5e0c4546	preferences	default_currency	USD	PKR	d47e3ac2-2fb6-4ad0-b3d7-b107c33a094a	Test Org Admin	org.admin.test@example.com	settings	2	7c576972-6c11-4d4f-a774-af95c0415b64	2026-11-11 15:14:38.516057+00
993ecee9-ac0b-4df8-913c-777fbc3a82fd	281	401dc009-d310-42ae-be14-567d5e0c4546	preferences	timezone	UTC	Asia/Karachi	d47e3ac2-2fb6-4ad0-b3d7-b107c33a094a	Test Org Admin	org.admin.test@example.com	settings	2	7c576972-6c11-4d4f-a774-af95c0415b64	2026-11-11 15:14:38.516057+00
a24da7bf-7434-49af-b3dc-dd3e45e40992	282	401dc009-d310-42ae-be14-567d5e0c4546	preferences	date_format	YYYY-MM-DD	DD/MM/YYYY	d47e3ac2-2fb6-4ad0-b3d7-b107c33a094a	Test Org Admin	org.admin.test@example.com	settings	2	7c576972-6c11-4d4f-a774-af95c0415b64	2026-11-11 15:14:38.516057+00
\.


--
-- Data for Name: organizations; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.organizations (id, name, slug, country_code, tax_identifier, contact_email, primary_admin_email, is_active, created_at, setup_status, setup_completed_at, setup_completed_by, logo_storage_key, logo_content_type, logo_updated_at, contact_phone, address_street, address_city, address_state, address_postal_code, website, description, default_currency, timezone, date_format, number_format, settings_version, settings_updated_at, settings_updated_by) FROM stdin;
de24b5cf-d75f-401f-a971-e5ce1e252f35	Apple	apple	PK	\N	zainmehdi2006@gmail.com	zainmehdi2006@gmail.com	t	2026-11-06 18:55:43.017765+00	completed	2026-11-06 18:58:14.640254+00	2af074d6-c910-49be-913d-d91cedb9abfe	ur/uR-ZwSDveKrWDLQWXpcVKONW1bwdpFmMFrJuk4CB6TI.png	image/png	2026-11-06 18:57:26.690168+00	\N	\N	\N	\N	\N	\N	\N	USD	UTC	YYYY-MM-DD	comma_dot	1	\N	\N
9b049652-7d52-48d3-ba7a-ecc42d1725bf	Rizviz	rizviz	US	345	zainmehdi2006+1@gmail.com	zainmehdi2006@gmail.com	t	2026-11-03 17:40:21.433944+00	completed	2026-11-06 18:23:04.571616+00	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	USD	UTC	YYYY-MM-DD	comma_dot	1	\N	\N
2105af1b-6e55-4ec4-bc36-3ae5251e2475	Rizviz	rizviz-2	PK	alskdjalkdja	thenewapple2004@gmail.com	zainmehdi2006@gmail.com	t	2026-11-03 18:08:02.265499+00	completed	2026-11-06 18:23:04.571616+00	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	USD	UTC	YYYY-MM-DD	comma_dot	1	\N	\N
affff01c-e82f-4de6-a989-25dcab67c634	Impex Invitation Test	invitation-test-4a843b	US	\N	mehdizain784@gmail.com	mehdizain784@gmail.com	t	2026-11-03 18:29:31.857143+00	completed	2026-11-06 18:23:04.571616+00	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	USD	UTC	YYYY-MM-DD	comma_dot	1	\N	\N
bc3b13f9-6e7d-4f40-8f31-0df3fa242375	Rizviz	rizviz-3	US	\N	thenewapple2004@gmail.com	zainmehdi2006@gmail.com	t	2026-11-03 20:50:25.222417+00	completed	2026-11-06 18:23:04.571616+00	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	USD	UTC	YYYY-MM-DD	comma_dot	1	\N	\N
401dc009-d310-42ae-be14-567d5e0c4546	Test Organization	test-organization-portal	US	\N	org.admin.test@example.com	org.admin.test@example.com	t	2026-11-03 20:33:55.708963+00	completed	2026-11-06 18:23:04.571616+00	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	PKR	Asia/Karachi	DD/MM/YYYY	comma_dot	2	2026-11-11 15:14:38.739951+00	d47e3ac2-2fb6-4ad0-b3d7-b107c33a094a
\.


--
-- Name: organization_module_history_seq_seq; Type: SEQUENCE SET; Schema: public; Owner: impex_admin
--

SELECT pg_catalog.setval('public.organization_module_history_seq_seq', 2302, true);


--
-- Name: organization_settings_history_seq_seq; Type: SEQUENCE SET; Schema: public; Owner: impex_admin
--

SELECT pg_catalog.setval('public.organization_settings_history_seq_seq', 282, true);


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: organization_invitations pk_organization_invitations; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.organization_invitations
    ADD CONSTRAINT pk_organization_invitations PRIMARY KEY (id);


--
-- Name: organization_module_history pk_organization_module_history; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.organization_module_history
    ADD CONSTRAINT pk_organization_module_history PRIMARY KEY (id);


--
-- Name: organization_modules pk_organization_modules; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.organization_modules
    ADD CONSTRAINT pk_organization_modules PRIMARY KEY (organization_id, module_key);


--
-- Name: organization_settings_history pk_organization_settings_history; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.organization_settings_history
    ADD CONSTRAINT pk_organization_settings_history PRIMARY KEY (id);


--
-- Name: organizations pk_organizations; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT pk_organizations PRIMARY KEY (id);


--
-- Name: organization_invitations uq_organization_invitations_token_hash; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.organization_invitations
    ADD CONSTRAINT uq_organization_invitations_token_hash UNIQUE (token_hash);


--
-- Name: organizations uq_organizations_slug; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT uq_organizations_slug UNIQUE (slug);


--
-- Name: ix_organization_module_history_organization_id_seq; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_organization_module_history_organization_id_seq ON public.organization_module_history USING btree (organization_id, seq);


--
-- Name: ix_organization_settings_history_organization_id_seq; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_organization_settings_history_organization_id_seq ON public.organization_settings_history USING btree (organization_id, seq);


--
-- Name: uq_organization_invitations_pending; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE UNIQUE INDEX uq_organization_invitations_pending ON public.organization_invitations USING btree (organization_id, email) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: organization_module_history organization_module_history_guard; Type: TRIGGER; Schema: public; Owner: impex_admin
--

CREATE TRIGGER organization_module_history_guard BEFORE DELETE OR UPDATE ON public.organization_module_history FOR EACH ROW EXECUTE FUNCTION public.organization_module_history_guard();


--
-- Name: organization_settings_history organization_settings_history_guard; Type: TRIGGER; Schema: public; Owner: impex_admin
--

CREATE TRIGGER organization_settings_history_guard BEFORE DELETE OR UPDATE ON public.organization_settings_history FOR EACH ROW EXECUTE FUNCTION public.organization_settings_history_guard();


--
-- Name: organization_invitations fk_organization_invitations_organization_id_organizations; Type: FK CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.organization_invitations
    ADD CONSTRAINT fk_organization_invitations_organization_id_organizations FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: organization_module_history fk_organization_module_history_organization_id_organizations; Type: FK CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.organization_module_history
    ADD CONSTRAINT fk_organization_module_history_organization_id_organizations FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: organization_modules fk_organization_modules_organization_id_organizations; Type: FK CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.organization_modules
    ADD CONSTRAINT fk_organization_modules_organization_id_organizations FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: organization_settings_history fk_organization_settings_history_organization_id_organizations; Type: FK CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.organization_settings_history
    ADD CONSTRAINT fk_organization_settings_history_organization_id_organizations FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict 9alox5BAIVfBhAxwD1a0ew2wshS9cczbP0YjGbXXXOyNjlPBr1PPtnxycIgIA85

