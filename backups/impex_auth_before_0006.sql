--
-- PostgreSQL database dump
--

\restrict aiIqFtb6OibmCCXy61ZCguJLmmSWKMe6mdeRCZsd12LR2h72Wr8pv7m0pTeN9vA

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
-- Name: users; Type: TABLE; Schema: public; Owner: impex_admin
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name character varying(255) NOT NULL,
    email character varying(320) NOT NULL,
    password_hash character varying(255) NOT NULL,
    role character varying(50) DEFAULT 'user'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid,
    profile_setup_completed_at timestamp with time zone,
    theme_background character varying(32),
    theme_accent character varying(32),
    dashboard_layout jsonb,
    CONSTRAINT ck_users_org_admin_requires_org CHECK ((((role)::text <> 'organization-admin'::text) OR (organization_id IS NOT NULL)))
);


ALTER TABLE public.users OWNER TO impex_admin;

--
-- Data for Name: alembic_version; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.alembic_version (version_num) FROM stdin;
0005
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: impex_admin
--

COPY public.users (id, full_name, email, password_hash, role, is_active, created_at, organization_id, profile_setup_completed_at, theme_background, theme_accent, dashboard_layout) FROM stdin;
5cffccb9-ffe3-4328-9e67-5e8e0f2cb1b4	Syed Zain Mehdi	mehdizain784@gmail.com	7990d822e010e26d797f6317477726b4$d8948943cdc0454e2dbd49f77f4fe5bf460ee6705198d75824d1c98fdf280598	super-admin	t	2026-11-03 17:03:57.608923+00	\N	2026-11-06 18:23:02.674864+00	ice	frost-blue	\N
d47e3ac2-2fb6-4ad0-b3d7-b107c33a094a	Test Org Admin	org.admin.test@example.com	9435ec028dd69556a06444c264e1589a$e0e29f031f74dad66c09ebfe9e4d1faab96a6127d44b027b476bada8412fd090	organization-admin	t	2026-11-03 20:33:55.769004+00	401dc009-d310-42ae-be14-567d5e0c4546	2026-11-06 18:23:02.674864+00	ice	dusty-rose	{"order": ["org.kpi.open-purchase-orders", "org.kpi.active-products", "org.kpi.invoiced-this-month", "org.kpi.outstanding-receivables", "org.chart.sales-purchasing-trend", "org.chart.inventory-activity", "org.list.recent-invoices", "org.list.open-purchase-orders", "org.list.recent-stock-movements", "org.finance.snapshot", "org.panel.modules", "org.panel.quick-actions", "org.panel.organization"], "hidden": ["org.chart.collections", "org.overview"], "version": 1, "revision": 6}
2af074d6-c910-49be-913d-d91cedb9abfe	Syed Zain Mehdi Rizvi	zainmehdi2006@gmail.com	a2f31080c5d3f7118d05d9c01b154df5$73943d6c26a0af12f165484bdab024fbbc5052c8dacedb20cfd2555740d51c91	organization-admin	t	2026-11-06 18:55:43.046438+00	de24b5cf-d75f-401f-a971-e5ce1e252f35	2026-11-06 18:58:14.648838+00	graphite	sage-silver	\N
\.


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: users pk_users; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT pk_users PRIMARY KEY (id);


--
-- Name: users uq_users_email; Type: CONSTRAINT; Schema: public; Owner: impex_admin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT uq_users_email UNIQUE (email);


--
-- Name: ix_users_organization_id; Type: INDEX; Schema: public; Owner: impex_admin
--

CREATE INDEX ix_users_organization_id ON public.users USING btree (organization_id);


--
-- PostgreSQL database dump complete
--

\unrestrict aiIqFtb6OibmCCXy61ZCguJLmmSWKMe6mdeRCZsd12LR2h72Wr8pv7m0pTeN9vA

