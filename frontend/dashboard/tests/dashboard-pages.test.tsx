import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { alphaOrg, orgAdmin, orgAdminB, superAdmin, betaOrg } from "./helpers";

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

import DashboardLayout from "@/app/(dashboard)/layout";
import DashboardPage from "@/app/(dashboard)/page";
import Loading from "@/app/(dashboard)/loading";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();
const month = today.slice(0, 7);
const earlier = (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 2, 10); return d.toISOString().slice(0, 10); })();
const FUTURE = "2999-01-01";
const LONG_AGO = "2000-01-01";

const client = (name: string) => ({ id: crypto.randomUUID(), name, is_active: true });
const invoice = (number: string, status: string, total: string, extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), number, status, client: client("Acme Buyer Ltd"), delivery_list: null, invoice_date: today, due_date: FUTURE, currency_code: "USD", subtotal: total, discount_total: "0.0000", tax_total: "0.0000",
  total, paid_total: "0.0000", outstanding: total, overdue: false, line_count: 1, created_by_email: "a@b.c", issued_at: now, issued_by_email: "a@b.c", voided_at: null, updated_at: now, ...extra,
});
const order = (number: string, status: string, total: string, extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), number, status, supplier: { id: crypto.randomUUID(), name: "Acme Supplies" }, supplier_reference: null, order_date: today, expected_delivery_date: null, currency_code: "USD",
  notes: null, line_count: 1, total_amount: total, created_by_email: "a@b.c", ordered_at: now, ordered_by_email: "a@b.c", cancelled_at: null, cancelled_by_email: null, created_at: now, updated_at: now, ...extra,
});
const movement = (type: string, name = "Steel bolt") => ({
  id: crypto.randomUUID(), operation_id: crypto.randomUUID(), product_id: "p", product_sku: "BOLT", product_name: name, product_unit: "pcs", unit_allows_fractions: false,
  movement_type: type, quantity: "10.0000", balance_after: "10.0000", reason: "x", created_by_email: "a@b.c", created_at: now,
});

type World = {
  products: number; movements: any[];
  ordered: any[]; partial: any[]; poWindow: any[]; invWindow: any[]; issued: any[]; partiallyPaid: any[]; finance: any; totals?: Record<string, number>;
};

const alphaWorld = (): World => {
  const issued = invoice("INV-000002", "issued", "198.0000", { outstanding: "198.0000" });
  const overdue = invoice("INV-000001", "partially_paid", "130.0000", { paid_total: "30.0000", outstanding: "100.0000", overdue: true, due_date: LONG_AGO, invoice_date: earlier });
  const euro = invoice("INV-000003", "issued", "40.0000", { currency_code: "EUR", outstanding: "40.0000" });
  const paid = invoice("INV-000000", "paid", "100.0000", { paid_total: "100.0000", outstanding: "0.0000", invoice_date: earlier });
  const draft = invoice("", "draft", "9999.0000", { number: null });
  const voided = invoice("INV-X", "void", "8888.0000");
  return {
    products: 12,
    movements: [movement("in"), movement("out", "Flour"), movement("opening")],
    ordered: [order("PO-000002", "ordered", "100.0000"), order("PO-000003", "ordered", "50.0000", { currency_code: "EUR", expected_delivery_date: FUTURE })],
    partial: [order("PO-000001", "partially_received", "25.5000")],
    poWindow: [order("PO-000002", "ordered", "100.0000"), order("PO-000001", "partially_received", "25.5000", { order_date: earlier }), order("PO-DRAFT", "draft", "7777.0000"), order("PO-CANCELLED", "cancelled", "6666.0000")],
    invWindow: [issued, euro, overdue, paid, draft, voided],
    issued: [issued, euro], partiallyPaid: [overdue],
    finance: {
      default_currency: "USD", activated_at: now, accounts: 14, active_accounts: 14, draft_entries: 1, posted_entries: 4, draft_expenses: 0, posted_expenses: 2,
      totals_by_currency: [{ currency_code: "USD", assets: "1.0000", liabilities: "0.0000", equity: "0.0000", revenue: "321.0000", expenses: "12.5000", posted_entries: 4 }], recent_entries: [],
      sync: { sources: [], pending: 0, failed: 1, skipped: 0, posted: 3 },
    },
  };
};

const emptyWorld = (): World => ({ products: 0, movements: [], ordered: [], partial: [], poWindow: [], invWindow: [], issued: [], partiallyPaid: [], finance: { ...alphaWorld().finance, posted_entries: 0, draft_entries: 0, posted_expenses: 0, totals_by_currency: [], sync: { sources: [], pending: 0, failed: 0, skipped: 0, posted: 0 } } });

let worlds: Record<string, World> = {};
let orgBody: Record<string, any> = {};
let down = new Set<string>();
let calls: { url: string; headers: Record<string, string> }[] = [];
let users: Record<string, any> = {};

function stubBackend() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    const token = (headers.Authorization ?? "").replace("Bearer ", "");
    if (url.endsWith("/api/v1/auth/me")) return users[token] ? json(200, users[token]) : json(401, {});
    if (url.endsWith("/api/v1/tenant/organization")) {
      if (!users[token]) return json(401, {});
      const body = orgBody[token];
      return body.status ? json(body.status, { detail: "x" }) : json(200, body);
    }
    const target = new URL(url);
    const p = target.searchParams;
    const world = worlds[token];
    const service = ["inventory", "sales", "purchasing", "finance"].find((s) => target.pathname.startsWith(`/api/v1/${s}`));
    if (!world || !service) return json(404, {});
    if (down.has(service)) return json(503, { detail: "down" });
    const page = (items: any[], total = items.length) => json(200, { items, total, limit: Number(p.get("limit")), offset: Number(p.get("offset")) });
    const path = target.pathname.replace(`/api/v1/${service}`, "");
    if (path === "/stock") return page([], world.products);
    if (path === "/stock/movements") return page(world.movements, world.totals?.movements ?? world.movements.length);
    if (path === "/purchase-orders") return p.get("status") === "ordered" ? page(world.ordered, world.totals?.ordered) : p.get("status") === "partially_received" ? page(world.partial) : page(world.poWindow, world.totals?.poWindow);
    if (path === "/invoices") return p.get("status") === "issued" ? page(world.issued) : p.get("status") === "partially_paid" ? page(world.partiallyPaid) : page(world.invWindow.slice(Number(p.get("offset"))), world.totals?.invWindow);
    if (path === "/overview") return json(200, world.finance);
    return json(404, {});
  }));
}

const org = (modules: string[], extra: Record<string, unknown> = {}) => ({ ...alphaOrg, modules, ...extra });
const ALL = ["inventory", "purchasing", "sales", "finance"];
const render = async () => renderToStaticMarkup(await DashboardLayout({ children: await DashboardPage() }));
const businessCalls = () => calls.filter((c) => /\/api\/v1\/(inventory|sales|purchasing|finance)\//.test(c.url));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  for (const key of Object.keys(jar)) delete jar[key];
  jar[TENANT_SESSION_COOKIE] = "token-alpha";
  worlds = { "token-alpha": alphaWorld(), "token-beta": emptyWorld() };
  orgBody = { "token-alpha": org(ALL), "token-beta": { ...betaOrg, modules: ["inventory", "sales"] }, "token-super": { status: 403 } };
  down = new Set();
  users = { "token-alpha": orgAdmin, "token-beta": orgAdminB, "token-super": superAdmin };
  stubBackend();
});
afterEach(() => vi.unstubAllGlobals());

describe("the dashboard shows real figures", () => {
  it("has the glass frame: a rail sidebar, a header with the page name and the administrator's avatar card, and a heading", async () => {
    const html = await render();
    expect(html).toContain('class="ix-dash"');
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain("Alpha Trading GmbH");
    expect(html).not.toContain("Admin Portal"); // the page name replaced the company block
    expect(html).toContain("Organization Admin"); // the role, in the avatar's card
    expect(html).toContain("Olivia Owner");
    expect(html).toContain("Sign out");
    expect(html).toContain("Welcome, Olivia Owner");
    expect(html).toMatch(/<h1[^>]*>Dashboard<\/h1>/);
    expect(html).toContain('aria-current="page"'); // Dashboard in the sidebar
  });

  it("the four key figures come from the services' records", async () => {
    const t = text(await render());
    expect(t).toContain("Active products 12");
    expect(t).toContain("In your product catalog");
    expect(t.toLowerCase()).not.toContain("warehouse");
    expect(t).toContain("Open purchase orders 3");
    expect(t).toContain("125.50 USD on order");
    expect(t).toContain("50.00 EUR on order"); // a second currency on its own line
    expect(t).toContain("Invoiced this month 198.00 USD"); // only what was issued this month; drafts and voids are not revenue
    expect(t).toContain("Also in 40.00 EUR");
    expect(t).toContain("Outstanding receivables 298.00 USD"); // 198.00 + 100.00 still due
    expect(t).toContain("100.00 USD overdue");
    expect(t).toContain("3 unpaid invoices");
  });

  it("never adds different currencies together and never counts drafts, voids or cancelled orders", async () => {
    const t = text(await render());
    for (const wrong of ["238.00", "338.00", "348.00", "9999", "8888", "7777", "6666", "175.50"]) expect(t, wrong).not.toContain(wrong);
  });

  it("the charts and lists are made of those records", async () => {
    const html = await render();
    const t = text(html);
    expect(html).toContain('aria-label="Invoiced and Purchase orders placed per month in USD, last 6 months"');
    expect(t).toContain("Sales & purchasing trend");
    expect(t).toContain("Also in EUR: shown in its own currency elsewhere, never added to USD.");
    expect(html).toContain('aria-label="Stock movements per day, last 14 days"');
    expect(t).not.toContain("Stock by warehouse");
    for (const n of ["INV-000002", "INV-000001", "INV-000003", "PO-000002", "PO-000001", "PO-000003", "Steel bolt", "Flour"]) expect(t, n).toContain(n);
    expect(t).toContain("Paid so far 30.00 USD");
    expect(t).toContain("Overdue 100.00 USD");
    expect(t).toContain("Still due 198.00 USD");
    expect(html).toContain(`href="/invoices/`);
  });

  it("the chart is also a table for screen readers, with the exact values", async () => {
    const html = await render();
    expect(html).toContain('<div class="sr-only"><table><caption>Invoiced and Purchase orders placed per month in USD, last 6 months</caption>');
    expect(html).toContain("198.00 USD");
  });

  it("shows the finance snapshot only when Finance is enabled, with failures flagged", async () => {
    let t = text(await render());
    expect(t).toContain("Finance snapshot");
    expect(t).toContain("4 Posted entries");
    expect(t).toContain("Revenue 321.00 · Expenses 12.50");
    expect(t).toContain("1 automatic posting needs attention");
    orgBody["token-alpha"] = org(["inventory", "sales"]);
    t = text(await render());
    expect(t).not.toContain("Finance snapshot");
  });

  it("writes amounts and dates in the organization's own format", async () => {
    orgBody["token-alpha"] = org(ALL, { number_format: "dot_comma", date_format: "DD/MM/YYYY", default_currency: "USD" });
    worlds["token-alpha"].invWindow[0].total = "1234567.5000";
    const t = text(await render());
    expect(t).toContain("1.234.567,50 USD");
    const [y, m, d] = today.split("-");
    expect(t).toContain(`${d}/${m}/${y}`);
  });

  it("the organization's headline currency is its default when it has data in it", async () => {
    orgBody["token-alpha"] = org(ALL, { default_currency: "EUR" });
    const t = text(await render());
    expect(t).toContain("Invoiced this month 40.00 EUR");
    expect(t).toContain("Also in 198.00 USD");
  });
});

describe("an empty organization", () => {
  beforeEach(() => { jar[TENANT_SESSION_COOKIE] = "token-alpha"; worlds["token-alpha"] = emptyWorld(); });
  it("shows calm empty states, not invented numbers", async () => {
    const t = text(await render());
    expect(t).toContain("Active products 0");
    expect(t).toContain("No products yet");
    expect(t).toContain("Open purchase orders 0");
    expect(t).toContain("Nothing waiting to be received");
    expect(t).toContain("Invoiced this month 0.00 USD");
    expect(t).toContain("No invoices issued yet");
    expect(t).toContain("Outstanding receivables 0.00 USD");
    expect(t).toContain("No unpaid invoices");
    for (const empty of ["No invoices or purchase orders in the last 6 months yet.", "No open invoices.", "No stock movements in the last 14 days.", "No invoices yet.", "No purchase orders waiting to be received.", "No stock movements yet."]) expect(t, empty).toContain(empty);
  });
});

describe("modules that are not enabled", () => {
  it("are not asked for data at all, and have no card, no figure and no sidebar entry", async () => {
    orgBody["token-alpha"] = org(["inventory"]);
    const html = await render();
    const urls = businessCalls().map((c) => c.url);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.includes("/api/v1/inventory/"))).toBe(true);
    const t = text(html);
    for (const hidden of ["Open purchase orders", "Invoiced this month", "Outstanding receivables", "Recent invoices", "Collections", "Finance snapshot", "Sales & purchasing trend"]) expect(t, hidden).not.toContain(hidden);
    for (const href of ["/invoices/sales", "/invoices/suppliers", "/clients", "/suppliers", "/purchase-orders", "/finance", "/finance/expenses/new", "/invoices/new"]) expect(html, href).not.toContain(`href="${href}"`);
    for (const shown of ["Active products", "Inventory activity", "Recent stock movements"]) expect(t, shown).toContain(shown);
    expect(html).toContain('data-nav-group="inventory"');
    expect(html).not.toContain('data-nav-group="sales"');
  });

  it("Sales without Inventory is not usable, so nothing of it is asked or shown", async () => {
    orgBody["token-alpha"] = org(["sales"]);
    const html = await render();
    expect(businessCalls()).toEqual([]);
    expect(html).not.toContain("Invoiced this month");
    expect(html).toContain("No business modules are enabled");
  });

  it("with no module, only the permanent entries and an honest message remain", async () => {
    orgBody["token-alpha"] = org([]);
    const html = await render();
    expect(businessCalls()).toEqual([]);
    expect(html).toContain("No business modules are enabled");
    expect(html).not.toContain("data-module=");
    expect(html).toContain('href="/support"');
    expect(html).toContain('href="/settings"');
  });

  it("an unknown module list (an outage or an old service) is none, never all", async () => {
    orgBody["token-alpha"] = { ...alphaOrg, modules: undefined };
    const html = await render();
    expect(businessCalls()).toEqual([]);
    expect(html).not.toContain("data-module=");
  });

  it("the sidebar lists every page of each enabled module and the permanent ones", async () => {
    const html = await render();
    for (const href of ["/", "/stock", "/movements", "/suppliers", "/purchase-orders", "/invoices/suppliers", "/clients", "/delivery-lists", "/invoices/sales",
      "/finance", "/support", "/settings"]) expect(html, href).toContain(`href="${href}"`);
    for (const gone of ["/finance/accounts", "/finance/expenses", "/finance/journal"]) expect(html, gone).not.toContain(`href="${gone}"`); // Finance is ONE entry; the accounting pages are linked from its page
    for (const group of ["main", "inventory", "purchasing", "sales", "invoices", "finance", "workspace"]) expect(html).toContain(`data-nav-group="${group}"`);
  });

  it("Scan Product is not a menu entry or a dashboard shortcut: scanning happens inside the workflows", async () => {
    const html = await render();
    expect(html).not.toContain('href="/scan"');
    expect(html).not.toContain("Scan Product");
    expect(html).not.toContain("Scan a product");
    expect(html).toContain('href="/stock"'); // Stock is still there, and so is its shortcut
  });
});

describe("tenant isolation", () => {
  it("each organization sees only its own figures", async () => {
    worlds["token-beta"] = { ...emptyWorld(), products: 3, invWindow: [invoice("INV-BETA-1", "issued", "55.0000", { currency_code: "EUR" })], issued: [invoice("INV-BETA-1", "issued", "55.0000", { currency_code: "EUR" })] };
    const alpha = text(await render());
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const beta = text(await render());
    expect(alpha).toContain("Alpha Trading GmbH");
    expect(alpha).not.toContain("INV-BETA-1");
    expect(alpha).not.toContain("Beta Logistics");
    expect(beta).toContain("Beta Logistics SARL");
    expect(beta).toContain("INV-BETA-1");
    expect(beta).not.toContain("INV-000002");
    expect(beta).not.toContain("Alpha Trading");
    expect(beta).toContain("Active products 3");
    expect(beta).not.toContain("Open purchase orders"); // Beta has no Purchasing
  });

  it("sends only the session token: no organization in any URL, header or body", async () => {
    await render();
    const sent = businessCalls();
    expect(sent.length).toBeGreaterThan(5);
    for (const call of sent) {
      expect(call.headers.Authorization).toBe("Bearer token-alpha");
      expect(call.url).not.toMatch(/organization|org_id|tenant/i);
      expect(call.url).not.toContain(orgAdmin.organization_id);
      expect(Object.keys(call.headers).filter((h) => /organization|tenant|module/i.test(h))).toEqual([]);
    }
  });

  it("a Super Admin session, a missing session and an expired one open nothing", async () => {
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(render()).rejects.toThrow("REDIRECT:/login");
    delete jar[TENANT_SESSION_COOKIE];
    await expect(render()).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "expired";
    await expect(render()).rejects.toThrow("REDIRECT:/login");
    expect(businessCalls()).toEqual([]);
  });
});

describe("when something is wrong", () => {
  it("a failing service says so in its own cards only; the rest still renders", async () => {
    down.add("sales");
    const html = await render();
    const t = text(html);
    expect(t.match(/Could not be loaded just now/g)!.length).toBeGreaterThanOrEqual(4); // invoiced, receivables, collections, recent invoices
    expect(t).toContain("Active products 12"); // Inventory is fine
    expect(t).toContain("Open purchase orders 3");
    expect(t).toContain("Purchase orders placed"); // the trend keeps its purchasing line
    expect(t).toContain("Sales data could not be loaded, so its line is missing.");
    expect(html).toContain('role="alert"');
  });

  it("when every service is down the frame and the welcome still render", async () => {
    for (const s of ["inventory", "sales", "purchasing", "finance"]) down.add(s);
    const html = await render();
    expect(html).toContain("Welcome, Olivia Owner");
    expect(html).toContain('aria-label="Primary"');
    expect(text(html)).toContain("Could not be loaded just now");
  });

  it("an inactive organization is explained, with no business call and no organization data", async () => {
    orgBody["token-alpha"] = { status: 403 };
    const html = await render();
    expect(html).toContain("currently inactive or unavailable");
    expect(html).not.toContain("Alpha Trading");
    expect(businessCalls()).toEqual([]);
  });

  it("an unreachable Organization Service is a recoverable message and never 'setup complete'", async () => {
    orgBody["token-alpha"] = { status: 503 };
    const html = await render();
    expect(html).toContain("temporarily unavailable");
    expect(businessCalls()).toEqual([]);
  });

  it("an unfinished setup is a true redirect to /setup, before anything is shown", async () => {
    orgBody["token-alpha"] = org(ALL, { setup_status: "pending" });
    await expect(render()).rejects.toThrow("REDIRECT:/setup");
    orgBody["token-alpha"] = org(ALL);
    const { profile_setup_completed_at: _drop, ...bare } = orgAdmin; // the administrator never confirmed their own profile
    users["token-alpha"] = bare;
    await expect(render()).rejects.toThrow("REDIRECT:/setup");
  });

  it("says plainly when a list was longer than what could be read", async () => {
    worlds["token-alpha"].totals = { invWindow: 5000, poWindow: 5000, movements: 5000 };
    const t = text(await render());
    expect(t).toContain("Based on the latest records in this period (the list limit was reached).");
    expect(t).toContain("Based on the latest 3 movements.");
  });
});

describe("loading and chrome", () => {
  it("the loading state is a glass skeleton with a polite label", () => {
    const html = renderToStaticMarkup(<Loading />);
    expect(html).toContain('role="status"');
    expect(html).toContain("ix-glass");
    expect(html).toContain("ix-skeleton");
    expect(html).toContain("Loading your dashboard");
  });

  it("the page asks for nothing from the address bar", () => {
    expect(DashboardPage.length).toBe(0);
  });

  it("shows the company logo when it has one and a monogram when not", async () => {
    orgBody["token-alpha"] = org(ALL, { has_logo: true, logo_version: "17" });
    let html = await render();
    expect(html).toContain('src="/api/organization/logo?v=17"');
    expect(html).toContain("Alpha Trading GmbH logo");
    orgBody["token-alpha"] = org(ALL);
    html = await render();
    expect(html).not.toContain("/api/organization/logo");
    expect(html).toContain(">AT<");
  });
});
