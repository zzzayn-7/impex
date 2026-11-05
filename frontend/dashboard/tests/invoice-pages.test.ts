import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { orgAdmin, orgAdminB, superAdmin } from "./helpers";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import InvoicesLayout from "@/app/invoices/layout";
import InvoicesPage from "@/app/invoices/page";
import InvoicePage from "@/app/invoices/[id]/page";
import NewInvoicePage from "@/app/invoices/new/page";
import EditInvoicePage from "@/app/invoices/[id]/edit/page";
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
      invoices: [issued, draft, paid],
      details: {
        [A_ISSUED]: detail(issued, "Alpha steel bolt"), [A_DRAFT]: detail(draft, "Alpha steel bolt", { editable: true }),
        [A_PAID]: detail(paid, "Alpha steel bolt", { payments: [payment], can_record_payment: false, can_void: false }),
      } as Record<string, any>,
      billable: [{
        dispatch_line_id: A_DLINE, dispatch_id: A_DISPATCH, dispatch_number: "DS-000001", dispatch_date: "2026-11-07", delivery_list: { id: A_LIST, number: "DL-000001", status: "partially_dispatched" },
        product_id: crypto.randomUUID(), product_sku: "SKU-1", product_name: "Alpha steel bolt", unit: "pcs", warehouse_code: "MAIN", dispatched_quantity: "10.0000", invoiced_quantity: "0.0000",
        in_drafts_quantity: "0.0000", remaining_quantity: "10.0000",
      }],
      account: {
        client: alpha, balances: [{ currency_code: "USD", invoiced: "50.0000", paid: "25.0000", outstanding: "25.0000", overdue: "0.0000" }, { currency_code: "PKR", invoiced: "200.0000", paid: "0.0000", outstanding: "200.0000", overdue: "200.0000" }],
        invoices: [issued, paid], payments: [{ ...payment, invoice_number: "INV-000002" }],
      },
    },
    "token-beta": {
      clients: [clientRow(beta)], invoices: [theirs], details: { [B_INVOICE]: detail(theirs, "Beta silk scarf") } as Record<string, any>, billable: [],
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
      if (!url.includes("/api/v1/sales/")) return json(404, {});
      if (options.status) return json(options.status, { detail: "x" });
      const org = (orgs as any)[token];
      if (!org) return json(401, {});
      const path = new URL(url).pathname.replace("/api/v1/sales", "");
      const params = new URL(url).searchParams;
      const page = (items: any[]) => json(200, { items, total: items.length, limit: Number(params.get("limit")), offset: Number(params.get("offset")) });
      if (path === "/clients") return page(org.clients);
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
  it("is inside the protected frame, with Invoices in the navigation", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = renderToStaticMarkup(await InvoicesLayout({ children: "x" }));
    expect(html).toContain('href="/invoices"');
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/invoices"|<a[^>]*href="\/invoices"[^>]*aria-current="page"/);
  });
  it("sends a visitor without a session to the login page", async () => {
    stubWorld();
    await expect(InvoicesLayout({ children: "x" })).rejects.toThrow("REDIRECT:/login");
  });
});

describe("Invoices page", () => {
  it("lists the invoices with number, client, dates, amounts and status", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(InvoicesPage({ searchParams: {} }));
    for (const expected of ["Invoices", "INV-000001", "INV-000002", "Draft", "Alpha Metals", "2026-11-01", "25.00", "Issued", "Paid", "All statuses", "Any payment status", "All clients", "New Invoice", "Showing 1–3 of 3", "never changes your stock"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).toContain(`href="/invoices/${A_ISSUED}"`);
    expect(html).toContain('href="/invoices/new"');
  });

  it("two organizations: each sees only their own invoices", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const a = await render(InvoicesPage({ searchParams: {} }));
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const b = await render(InvoicesPage({ searchParams: {} }));
    expect(a).toContain("Alpha Metals");
    expect(a).not.toContain("Beta Textiles");
    expect(b).toContain("Beta Textiles");
    expect(b).not.toContain("Alpha Metals");
  });

  it("passes only whitelisted filters to the service", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await InvoicesPage({ searchParams: { q: "acme", status: "issued", payment: "overdue", client: A_CLIENT, from: "2026-11-01", to: "2026-11-30", page: "2", organization_id: B_CLIENT, sort: "x" } });
    const call = salesCalls().find((c) => new URL(c.url).pathname === "/api/v1/sales/invoices")!;
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({
      q: "acme", status: "issued", payment_status: "overdue", client_id: A_CLIENT, date_from: "2026-11-01", date_to: "2026-11-30", limit: "25", offset: "25",
    });
    calls = [];
    await InvoicesPage({ searchParams: { status: "shipped", payment: "maybe", client: "' OR 1=1", from: "yesterday", to: "../", page: "banana" } });
    const clean = salesCalls().find((c) => new URL(c.url).pathname === "/api/v1/sales/invoices")!;
    expect([...new URL(clean.url).searchParams.keys()].sort()).toEqual(["limit", "offset"]);
  });

  it("redirects without a session / for a Super Admin, calling no sales endpoint", async () => {
    stubWorld();
    await expect(InvoicesPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(InvoicesPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    expect(salesCalls()).toHaveLength(0);
  });

  it("explains an inactive organization, an outage and an expired session; and an empty list", async () => {
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 403 });
    expect(await render(InvoicesPage({ searchParams: {} }))).toContain("currently inactive or unavailable");
    stubWorld({ status: 503 });
    expect(await render(InvoicesPage({ searchParams: {} }))).toContain("temporarily unavailable");
    stubWorld({ status: 401 });
    await expect(InvoicesPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    orgs["token-alpha"].invoices = [];
    stubWorld();
    expect(await render(InvoicesPage({ searchParams: {} }))).toContain("No invoices yet");
    expect(await render(InvoicesPage({ searchParams: { q: "zzz" } }))).toContain("No invoices match these filters");
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

describe("new and edited invoices", () => {
  it("starts by choosing a client and calls no billing endpoint yet", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(NewInvoicePage({ searchParams: {} }));
    expect(html).toContain("Choose the client first");
    expect(html).toContain("Alpha Metals");
    expect(salesCalls().some((c) => c.url.includes("/billable-lines"))).toBe(false);
  });

  it("shows the client's confirmed dispatch lines with how much is left to bill", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(NewInvoicePage({ searchParams: { client: A_CLIENT } }));
    for (const expected of ["New invoice", "DS-000001", "Alpha steel bolt", "SKU-1", "Left to bill", "Bill Alpha steel bolt", "One currency per invoice", "never changes your stock"]) expect(html, expected).toContain(expected);
    const call = salesCalls().find((c) => c.url.includes("/billable-lines"))!;
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({ client_id: A_CLIENT });
  });

  it("another organization's client is not found, and a malformed one falls back to the client picker", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render(NewInvoicePage({ searchParams: { client: B_CLIENT } }))).toContain("Client not found.");
    expect(await render(NewInvoicePage({ searchParams: { client: "' OR 1=1" } }))).toContain("Choose the client first");
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
    expect(html).toContain(`href="/invoices/new?client=${A_CLIENT}"`);
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
