import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { alphaOrg, orgAdmin, orgAdminB, superAdmin } from "./helpers";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => null,
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import InvoicesLayout from "@/app/invoices/(sales)/layout";
import SalesInvoicePage from "@/app/invoices/(sales)/sales/page";
import SalesInvoiceHistoryPage from "@/app/invoices/(sales)/sales/history/page";
import OrderInvoicePage from "@/app/invoices/(sales)/sales/[id]/page";
import InvoicePage from "@/app/invoices/(sales)/[id]/page";
import NewInvoicePage from "@/app/invoices/(sales)/new/page";
import EditInvoicePage from "@/app/invoices/(sales)/[id]/edit/page";
import ClientPage from "@/app/clients/[id]/page";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-07T10:00:00+00:00";
const A_CLIENT = "a1111111-1111-4111-8111-111111111111";
const B_CLIENT = "b2222222-2222-4222-8222-222222222222";
const A_ISSUED = "a1111111-1111-4111-8111-aaaaaaaaaaaa";
const A_DRAFT = "a1111111-1111-4111-8111-dddddddddddd";
const A_PAID = "a1111111-1111-4111-8111-eeeeeeeeeeee";
const B_INVOICE = "b2222222-2222-4222-8222-bbbbbbbbbbbb";
const A_PAYMENT = "a1111111-1111-4111-8111-999999999999";
const A_LIST = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718";
const A_DLINE = "a1111111-1111-4111-8111-cccccccccccc";
const A_DISPATCH = "a1111111-1111-4111-8111-bbbbbbbbbbbb";

const alpha = { id: A_CLIENT, name: "Alpha Metals", is_active: true };
const beta = { id: B_CLIENT, name: "Beta Textiles", is_active: true };
const clientRow = (c: typeof alpha) => ({ ...c, contact_person: null, email: null, phone: null, address: null, created_at: now, updated_at: now });

const summary = (id: string, number: string | null, c: typeof alpha, extra: Record<string, unknown> = {}) => ({
  id, number, status: "issued", client: c, delivery_list: { id: A_LIST, number: "DL-000001", status: "partially_dispatched" }, invoice_date: "2026-11-01", due_date: "2999-01-01",
  currency_code: "USD", subtotal: "25.0000", discount_total: "0.0000", tax_total: "0.0000", total: "25.0000", paid_total: "0.0000", outstanding: "25.0000", overdue: false, line_count: 1,
  created_by_email: "a@b.c", issued_at: number ? now : null, issued_by_email: number ? "a@b.c" : null, voided_at: null, updated_at: now, ...extra,
});
const detail = (s: ReturnType<typeof summary>, product: string, extra: Record<string, unknown> = {}) => ({
  ...s, seller_name: "Alpha Trading", client_name: s.client.name, client_address: "1 Main St", notes: null, void_reason: null,
  lines: [{
    id: crypto.randomUUID(), product_id: crypto.randomUUID(), product_sku: "SKU-1", product_name: product, unit: "pcs", quantity: "10.0000", unit_price: "2.5000", discount_amount: "0.0000",
    tax_rate: "0.0000", tax_label: null, line_subtotal: "25.0000", line_net: "25.0000", line_tax: "0.0000", line_total: "25.0000",
    allocations: [{ dispatch_line_id: A_DLINE, dispatch_id: A_DISPATCH, dispatch_number: "DS-000001", quantity: "10.0000" }],
  }],
  payments: [], editable: s.status === "draft", can_issue: s.status === "draft", can_void: s.status === "draft" || (s.status === "issued" && s.paid_total === "0.0000"),
  can_record_payment: s.status === "issued" || s.status === "partially_paid", disclaimer: "This document records goods supplied ... does not certify that this invoice meets any tax or legal requirement.", ...extra,
});

const A_ORDER1 = "a1111111-1111-4111-8111-0000000000a1";
const A_ORDER2 = "a1111111-1111-4111-8111-0000000000a2";
const A_ORDER_INVOICE = "a1111111-1111-4111-8111-0000000000b1";
const B_ORDER_INVOICE = "b2222222-2222-4222-8222-0000000000b2";
const order = (id: string, number: string, c: typeof alpha, extra: Record<string, unknown> = {}) => ({
  id, number, client: c, delivery_list: { id: A_LIST, number: "DL-000009", status: "ready" }, status: "active", reservation_status: "reserved", origin: "order", version: 1, product_count: 2,
  total_amount: "350.0000", currency_code: "USD", prices_recorded: true, created_by_email: "a@b.c", created_at: now, updated_at: now, ...extra,
});
const orderInvoice = (id: string, c: typeof alpha, extra: Record<string, unknown> = {}) => ({
  id, number: "INV-000007", invoice_date: "2026-11-07", currency_code: "USD", notes: null, client_id: c.id, client_name: c.name, client_address: "1 Main St", seller_name: "Alpha Trading",
  order_id: A_ORDER1, order_number: "SO-000001", delivery_list_number: "DL-000009", subtotal: "350.0000", total: "350.0000", created_by_email: "a@b.c", created_at: now,
  lines: [{ product_id: crypto.randomUUID(), product_sku: "BOLT-1", product_name: "Steel bolt", unit: "pcs", quantity: "10.0000", unit_price: "30.0000", line_total: "300.0000" }], ...extra,
});
const historyRow = (kind: "order" | "invoice", id: string, number: string | null, c: typeof alpha, extra: Record<string, unknown> = {}) => ({
  kind, id, number, client_id: c.id, client_name: c.name, invoice_date: "2026-11-07", currency_code: "USD", total: "350.0000", status: "issued", order_number: kind === "order" ? "SO-000001" : null, ...extra,
});

const fresh = () => {
  const issued = summary(A_ISSUED, "INV-000001", alpha);
  const draft = summary(A_DRAFT, null, alpha, { status: "draft", subtotal: "10.0000", total: "10.0000", outstanding: "10.0000" });
  const paid = summary(A_PAID, "INV-000002", alpha, { status: "paid", paid_total: "25.0000", outstanding: "0.0000" });
  const theirs = summary(B_INVOICE, "INV-000001", beta, { delivery_list: null });
  const payment = {
    id: A_PAYMENT, invoice_id: A_PAID, kind: "payment", reverses_payment_id: null, payment_date: "2026-11-05", amount: "25.0000", currency_code: "USD", method: "bank_transfer",
    reference: "WIRE-77", notes: null, recorded_by_email: "a@b.c", created_at: now, reversed: false,
  };
  return {
    "token-alpha": {
      clients: [clientRow(alpha)],
      orders: [order(A_ORDER2, "SO-000002", alpha), order(A_ORDER1, "SO-000001", alpha)],
      refs: [{ order_id: A_ORDER1, invoice_id: A_ORDER_INVOICE, number: "INV-000007" }],
      history: [historyRow("order", A_ORDER_INVOICE, "INV-000007", alpha), historyRow("invoice", A_ISSUED, "INV-000001", alpha, { invoice_date: "2026-11-01", total: "25.0000" })],
      orderInvoices: { [A_ORDER_INVOICE]: orderInvoice(A_ORDER_INVOICE, alpha) } as Record<string, any>,
      invoices: [issued, draft, paid],
      details: {
        [A_ISSUED]: detail(issued, "Alpha steel bolt"), [A_DRAFT]: detail(draft, "Alpha steel bolt", { editable: true }),
        [A_PAID]: detail(paid, "Alpha steel bolt", { payments: [payment], can_record_payment: false, can_void: false }),
      } as Record<string, any>,
      billable: [{
        dispatch_line_id: A_DLINE, dispatch_id: A_DISPATCH, dispatch_number: "DS-000001", dispatch_date: "2026-11-07", delivery_list: { id: A_LIST, number: "DL-000001", status: "partially_dispatched" },
        product_id: crypto.randomUUID(), product_sku: "SKU-1", product_name: "Alpha steel bolt", unit: "pcs", dispatched_quantity: "10.0000", invoiced_quantity: "0.0000",
        in_drafts_quantity: "0.0000", remaining_quantity: "10.0000",
      }],
      account: {
        client: alpha, balances: [{ currency_code: "USD", invoiced: "50.0000", paid: "25.0000", outstanding: "25.0000", overdue: "0.0000" }, { currency_code: "PKR", invoiced: "200.0000", paid: "0.0000", outstanding: "200.0000", overdue: "200.0000" }],
        invoices: [issued, paid], payments: [{ ...payment, invoice_number: "INV-000002" }],
      },
    },
    "token-beta": {
      clients: [clientRow(beta)], orders: [order("b2222222-2222-4222-8222-0000000000a3", "SO-000001", beta, { delivery_list: null })], refs: [],
      history: [historyRow("order", B_ORDER_INVOICE, "INV-000001", beta)], orderInvoices: { [B_ORDER_INVOICE]: orderInvoice(B_ORDER_INVOICE, beta, { number: "INV-000001" }) } as Record<string, any>,
      invoices: [theirs], details: { [B_INVOICE]: detail(theirs, "Beta silk scarf") } as Record<string, any>, billable: [],
      account: { client: beta, balances: [], invoices: [theirs], payments: [] },
    },
  };
};
let orgs = fresh();

let calls: { url: string; headers: Record<string, string>; method: string }[] = [];
function stubWorld(options: { status?: number } = {}) {
  calls = [];
  const users: Record<string, any> = { "token-alpha": orgAdmin, "token-beta": orgAdminB, "token-super": superAdmin };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers, method: init.method ?? "GET" });
      const token = (headers.Authorization ?? "").replace("Bearer ", "");
      if (url.endsWith("/api/v1/auth/me")) return users[token] ? json(200, users[token]) : json(401, {});
      if (url.endsWith("/api/v1/tenant/organization")) return users[token] ? json(200, alphaOrg) : json(401, {}); // the layout asks for the organization (its setup and its modules)
      if (!url.includes("/api/v1/sales/")) return json(404, {});
      if (options.status) return json(options.status, { detail: "x" });
      const org = (orgs as any)[token];
      if (!org) return json(401, {});
      const path = new URL(url).pathname.replace("/api/v1/sales", "");
      const params = new URL(url).searchParams;
      const page = (items: any[]) => json(200, { items, total: items.length, limit: Number(params.get("limit")), offset: Number(params.get("offset")) });
      if (path === "/clients") return page(org.clients);
      if (path === "/orders") return page(org.orders.filter((o: any) => (!params.get("client_id") || o.client.id === params.get("client_id")) && (!params.get("q") || o.number.includes(params.get("q")!.toUpperCase()))));
      if (path === "/order-invoices/by-order") return json(200, { items: org.refs.filter((r: any) => (params.get("order_ids") ?? "").split(",").includes(r.order_id)) });
      if (path === "/invoice-history") return page(org.history.filter((h: any) => (!params.get("client_id") || h.client_id === params.get("client_id")) && (!params.get("day") || h.invoice_date === params.get("day"))));
      const orderInvoiceMatch = path.match(/^\/order-invoices\/([^/]+)$/);
      if (orderInvoiceMatch) return org.orderInvoices[orderInvoiceMatch[1]] ? json(200, org.orderInvoices[orderInvoiceMatch[1]]) : json(404, { detail: "Invoice not found." });
      if (path === "/invoices") return page(org.invoices.filter((i: any) => (!params.get("status") || i.status === params.get("status")) && (!params.get("client_id") || i.client.id === params.get("client_id"))));
      if (path === "/billable-lines") return org.clients.some((c: any) => c.id === params.get("client_id")) ? json(200, org.billable) : json(404, { detail: "Client not found." });
      let match = path.match(/^\/invoices\/([^/]+)$/);
      if (match) return org.details[match[1]] ? json(200, org.details[match[1]]) : json(404, { detail: "Invoice not found." });
      match = path.match(/^\/clients\/([^/]+)\/account$/);
      if (match) return org.account.client.id === match[1] ? json(200, org.account) : json(404, { detail: "Client not found." });
      return json(404, {});
    })
  );
}
const salesCalls = () => calls.filter((c) => c.url.includes("/api/v1/sales/"));
const render = async (element: Promise<any>) => renderToStaticMarkup(await element);

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.SALES_SERVICE_URL = "http://sales-service:8003";
  for (const key of Object.keys(jar)) delete jar[key];
  orgs = fresh();
});
afterEach(() => vi.unstubAllGlobals());

describe("the Invoices layout", () => {
  it("is inside the protected frame, with Sales Invoice in the Sales menu", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = renderToStaticMarkup(await InvoicesLayout({ children: "x" }));
    expect(html).toContain('href="/invoices/sales"');
    expect(html).toContain('href="/invoices/suppliers"'); // Purchase Invoice is in the Purchasing menu
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/invoices\/sales"|<a[^>]*href="\/invoices\/sales"[^>]*aria-current="page"/);
  });
  it("sends a visitor without a session to the login page", async () => {
    stubWorld();
    await expect(InvoicesLayout({ children: "x" })).rejects.toThrow("REDIRECT:/login");
  });
});

describe("Sales Invoice > New invoice", () => {
  it("lists the prepared orders, newest first, with a Create invoice button, or View invoice for an order that already has one", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(SalesInvoicePage({ searchParams: {} }));
    for (const expected of ["New invoice", "History", "SO-000002", "SO-000001", "Alpha Metals", "350.00 USD", "All clients", "Create invoice for SO-000002", "View invoice INV-000007"]) expect(html, expected).toContain(expected);
    expect(html).not.toContain("Create invoice for SO-000001"); // it has its invoice already
    expect(html).toContain(`href="/invoices/sales/${A_ORDER_INVOICE}"`);
    expect(html.indexOf("SO-000002")).toBeLessThan(html.indexOf("SO-000001"));
  });

  it("asks the service only for the PREPARED orders, with the whitelisted filters", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await SalesInvoicePage({ searchParams: { client: A_CLIENT, q: "so-2", page: "2", organization_id: B_CLIENT, sort: "x" } });
    const call = salesCalls().find((c) => new URL(c.url).pathname === "/api/v1/sales/orders")!;
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({ view: "active", booked: "true", limit: "25", offset: "25", q: "so-2", client_id: A_CLIENT });
    calls = [];
    await SalesInvoicePage({ searchParams: { client: "' OR 1=1", page: "banana" } });
    const clean = salesCalls().find((c) => new URL(c.url).pathname === "/api/v1/sales/orders")!;
    expect(Object.fromEntries(new URL(clean.url).searchParams)).toEqual({ view: "active", booked: "true", limit: "25", offset: "0" });
  });

  it("an order made before prices were recorded cannot be invoiced and says so", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    orgs["token-alpha"].orders = [order(A_ORDER2, "SO-000002", alpha, { prices_recorded: false, total_amount: null, currency_code: null })];
    const html = await render(SalesInvoicePage({ searchParams: {} }));
    expect(html).toContain("No prices");
    expect(html).not.toContain("Create invoice for SO-000002");
  });

  it("two organizations: each sees only their own orders", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const a = await render(SalesInvoicePage({ searchParams: {} }));
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const b = await render(SalesInvoicePage({ searchParams: {} }));
    expect(a).toContain("Alpha Metals");
    expect(a).not.toContain("Beta Textiles");
    expect(b).toContain("Beta Textiles");
    expect(b).not.toContain("Alpha Metals");
  });

  it("redirects without a session / for a Super Admin, calling no sales endpoint", async () => {
    stubWorld();
    await expect(SalesInvoicePage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(SalesInvoicePage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    expect(salesCalls()).toHaveLength(0);
  });

  it("explains an inactive organization, an outage and an expired session; and an empty list", async () => {
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 403 });
    expect(await render(SalesInvoicePage({ searchParams: {} }))).toContain("currently inactive or unavailable");
    stubWorld({ status: 503 });
    expect(await render(SalesInvoicePage({ searchParams: {} }))).toContain("temporarily unavailable");
    stubWorld({ status: 401 });
    await expect(SalesInvoicePage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    orgs["token-alpha"].orders = [];
    stubWorld();
    expect(await render(SalesInvoicePage({ searchParams: {} }))).toContain("No orders waiting to be dispatched");
    expect(await render(SalesInvoicePage({ searchParams: { q: "zzz" } }))).toContain("No orders found");
  });
});

describe("Sales Invoice > History", () => {
  it("lists every past invoice, newest first: the order invoices and the older ones, each opening its own page", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(SalesInvoiceHistoryPage({ searchParams: {} }));
    for (const expected of ["New invoice", "History", "INV-000007", "INV-000001", "Alpha Metals", "2026-11-07", "2026-11-01", "350.00 USD", "All clients", "Client", "Date"]) expect(html, expected).toContain(expected);
    expect(html).toContain(`href="/invoices/sales/${A_ORDER_INVOICE}"`); // an order invoice
    expect(html).toContain(`href="/invoices/${A_ISSUED}"`); // an older invoice keeps its own page, with its payments
  });

  it("passes the client and the date (alone or together) and nothing else", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await SalesInvoiceHistoryPage({ searchParams: { client: A_CLIENT, date: "2026-11-07", page: "3", organization_id: B_CLIENT, status: "paid" } });
    const call = salesCalls().find((c) => new URL(c.url).pathname === "/api/v1/sales/invoice-history")!;
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({ limit: "25", offset: "50", client_id: A_CLIENT, day: "2026-11-07" });
    calls = [];
    await SalesInvoiceHistoryPage({ searchParams: { date: "2026-11-07" } });
    expect(Object.fromEntries(new URL(salesCalls().find((c) => new URL(c.url).pathname === "/api/v1/sales/invoice-history")!.url).searchParams)).toEqual({ limit: "25", offset: "0", day: "2026-11-07" });
    calls = [];
    await SalesInvoiceHistoryPage({ searchParams: { client: "' OR 1=1", date: "yesterday", page: "banana" } });
    expect([...new URL(salesCalls().find((c) => new URL(c.url).pathname === "/api/v1/sales/invoice-history")!.url).searchParams.keys()].sort()).toEqual(["limit", "offset"]);
  });

  it("narrows by client, by date, or by both, and says when nothing matches", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const byDay = await render(SalesInvoiceHistoryPage({ searchParams: { date: "2026-11-01" } }));
    expect(byDay).toContain("INV-000001");
    expect(byDay).not.toContain("INV-000007");
    expect(await render(SalesInvoiceHistoryPage({ searchParams: { client: A_CLIENT, date: "2030-01-01" } }))).toContain("No invoices found");
  });

  it("two organizations: each sees only their own invoices", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const a = await render(SalesInvoiceHistoryPage({ searchParams: {} }));
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const b = await render(SalesInvoiceHistoryPage({ searchParams: {} }));
    expect(a).not.toContain("Beta Textiles");
    expect(b).toContain("Beta Textiles");
    expect(b).not.toContain("Alpha Metals");
  });

  it("redirects without a session and explains an outage and an empty history", async () => {
    stubWorld();
    await expect(SalesInvoiceHistoryPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 503 });
    expect(await render(SalesInvoiceHistoryPage({ searchParams: {} }))).toContain("temporarily unavailable");
    orgs["token-alpha"].history = [];
    stubWorld();
    expect(await render(SalesInvoiceHistoryPage({ searchParams: {} }))).toContain("No invoices yet");
  });
});

describe("one order invoice", () => {
  it("shows the order's details read-only, with Print and Download, and nothing to edit", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(OrderInvoicePage({ params: { id: A_ORDER_INVOICE } }));
    for (const expected of ["INV-000007", "Alpha Metals", "1 Main St", "SO-000001", "DL-000009", "2026-11-07", "Steel bolt", "BOLT-1", "300.00 USD", "350.00 USD", "Print", "Download", "Invoice history"]) expect(html, expected).toContain(expected);
    expect(html).toContain(`href="/api/sales/order-invoices/${A_ORDER_INVOICE}/pdf"`);
    expect(html).not.toMatch(/<input|<textarea|<select/);
    for (const absent of ["Record payment", "Void", "Edit draft", "Issue"]) expect(html, absent).not.toContain(absent);
  });

  it("another organization's invoice is shown exactly like one that does not exist, and a malformed id too", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render(OrderInvoicePage({ params: { id: B_ORDER_INVOICE } }))).toContain("Invoice not found.");
    expect(await render(OrderInvoicePage({ params: { id: "not-a-uuid" } }))).toContain("Invoice not found.");
  });

  it("redirects an expired session and explains an outage", async () => {
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 401 });
    await expect(OrderInvoicePage({ params: { id: A_ORDER_INVOICE } })).rejects.toThrow("REDIRECT:/login");
    stubWorld({ status: 503 });
    expect(await render(OrderInvoicePage({ params: { id: A_ORDER_INVOICE } }))).toContain("temporarily unavailable");
  });
});

describe("one invoice", () => {
  const page = (id: string) => render(InvoicePage({ params: { id } }));

  it("shows an issued invoice: parties, lines, totals, payment form and the actions", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_ISSUED);
    for (const expected of ["INV-000001", "Issued", "Alpha Trading", "Alpha Metals", "1 Main St", "2026-11-01", "Alpha steel bolt", "SKU-1", "DS-000001", "25.00", "Outstanding", "Record a payment received", "Print", "Download PDF", "Void invoice", "does not certify"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).toContain(`href="/api/sales/invoices/${A_ISSUED}/pdf"`);
    expect(html).not.toContain("Issue invoice");
    expect(html).not.toContain("Edit draft");
  });

  it("a draft can be edited and issued, and has no number or payment form", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_DRAFT);
    for (const expected of ["Draft invoice", "Edit draft", "Issue invoice", "Discard draft"]) expect(html, expected).toContain(expected);
    expect(html).toContain(`/invoices/${A_DRAFT}/edit`);
    expect(html).not.toContain("Record a payment received");
  });

  it("a paid invoice shows its payments and offers no payment form or voiding", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_PAID);
    for (const expected of ["INV-000002", "Paid", "WIRE-77", "Bank transfer", "Reverse", "cannot be voided", "Payments"]) expect(html, expected).toContain(expected);
    expect(html).not.toContain("Record a payment received");
    expect(html).not.toContain("Void invoice");
  });

  it("another organization's invoice is shown exactly like one that does not exist", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const foreign = await page(B_INVOICE);
    const missing = await page("b2222222-2222-4222-8222-ffffffffffff");
    const malformed = await page("not-an-id");
    expect(foreign).toBe(missing);
    expect(foreign).toContain("Invoice not found.");
    expect(malformed).toContain("Invoice not found.");
    expect(foreign).not.toContain("Beta");
  });

  it("redirects an expired session and explains an outage or an inactive organization", async () => {
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 401 });
    await expect(page(A_ISSUED)).rejects.toThrow("REDIRECT:/login");
    stubWorld({ status: 503 });
    expect(await page(A_ISSUED)).toContain("temporarily unavailable");
    stubWorld({ status: 403 });
    expect(await page(A_ISSUED)).toContain("currently inactive or unavailable");
  });
});

describe("edited invoices", () => {
  it("the old invoice-from-dispatch address goes to Sales Invoice > New invoice and calls no billing endpoint", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await expect(Promise.resolve().then(() => NewInvoicePage())).rejects.toThrow("REDIRECT:/invoices/sales");
    expect(salesCalls()).toHaveLength(0);
  });

  it("edits a draft but refuses to edit an issued invoice", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const draft = await render(EditInvoicePage({ params: { id: A_DRAFT } }));
    for (const expected of ["Edit draft invoice", "Alpha Metals", "Save draft and review"]) expect(draft, expected).toContain(expected);
    const issued = await render(EditInvoicePage({ params: { id: A_ISSUED } }));
    expect(issued).toContain("no longer a draft");
    expect(issued).not.toContain("Save draft and review");
    expect(await render(EditInvoicePage({ params: { id: B_INVOICE } }))).toContain("Invoice not found.");
  });
});

describe("a client's account", () => {
  const page = (id: string) => render(ClientPage({ params: { id } }));
  it("shows the balance per currency, the invoices and the payments", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_CLIENT);
    for (const expected of ["Alpha Metals", "Outstanding balance", "USD", "PKR", "25.00", "200.00", "INV-000001", "INV-000002", "Recent payments", "WIRE-77", "Nothing is converted or added across currencies", "New invoice"]) expect(html, expected).toContain(expected);
    expect(html).toContain(`href="/invoices/sales?client=${A_CLIENT}"`); // New invoice: this client's prepared orders
    expect(html).toContain(`href="/invoices/sales/history?client=${A_CLIENT}"`);
  });
  it("another organization's client is shown exactly like a client that does not exist", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const foreign = await page(B_CLIENT);
    expect(foreign).toBe(await page("b2222222-2222-4222-8222-ffffffffffff"));
    expect(foreign).toContain("Client not found.");
    expect(foreign).not.toContain("Beta");
  });
  it("redirects without a session", async () => {
    stubWorld();
    await expect(page(A_CLIENT)).rejects.toThrow("REDIRECT:/login");
  });
});
