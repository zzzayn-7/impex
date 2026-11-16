import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { alphaOrg, orgAdmin, orgAdminB, superAdmin } from "./helpers";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => null,
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import PnlCalculatorPage from "@/app/pnl-calculator/page";
import PnlOrderPage from "@/app/pnl-calculator/[orderId]/page";
import PnlLayout from "@/app/pnl-calculator/layout";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

// Finance > PNL Calculator. The list reads the organization's orders from the Sales Service and their saved expenses from the Finance Service; the order page adds the products' cost
// prices from the Inventory Service. Whose data it is comes from the session only.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-07T10:00:00+00:00";
const A_ORDER1 = "a1111111-1111-4111-8111-0000000000a1";
const A_ORDER2 = "a1111111-1111-4111-8111-0000000000a2";
const A_OLD = "a1111111-1111-4111-8111-0000000000a3";
const B_ORDER = "b2222222-2222-4222-8222-0000000000b1";
const A_PRODUCT = "a1111111-1111-4111-8111-00000000000a";
const alpha = { id: "a1111111-1111-4111-8111-111111111111", name: "Alpha Metals", is_active: true };
const beta = { id: "b2222222-2222-4222-8222-222222222222", name: "Beta Textiles", is_active: true };

const order = (id: string, number: string, c: typeof alpha, extra: Record<string, unknown> = {}) => ({
  id, number, client: c, delivery_list: { id: "l1", number: "DL-000001", status: "ready" }, status: "active", reservation_status: "reserved", origin: "order", version: 1, product_count: 1,
  total_amount: "500000.0000", currency_code: "USD", prices_recorded: true, created_by_email: "a@b.c", created_at: now, updated_at: now, ...extra,
});
const detail = (id: string, number: string, c: typeof alpha, extra: Record<string, unknown> = {}) => ({
  ...order(id, number, c), stock_status: "ok", dispatches: [], can_edit: true, edit_blocked_reason: null, can_cancel: true, can_cancel_remaining: false, cancel_blocked_reason: null, can_dispatch: true, message: null,
  lines: [{ id: "line-1", product_id: A_PRODUCT, product_sku: "BOLT-1", product_name: "Steel bolt", unit: "pcs", unit_allows_fractions: false, ordered_quantity: "5000.0000", dispatched_quantity: "0.0000",
    pending_quantity: "0.0000", remaining_quantity: "5000.0000", unit_price: "100.0000", line_total: "500000.0000", stock: null }], ...extra,
});

const fresh = () => ({
  "token-alpha": {
    orders: [order(A_ORDER2, "SO-000002", alpha, { total_amount: "1000.0000" }), order(A_ORDER1, "SO-000001", alpha), order(A_OLD, "SO-000000", alpha, { prices_recorded: false, total_amount: null, currency_code: null })],
    details: { [A_ORDER1]: detail(A_ORDER1, "SO-000001", alpha), [A_ORDER2]: detail(A_ORDER2, "SO-000002", alpha, { total_amount: "1000.0000" }), [A_OLD]: detail(A_OLD, "SO-000000", alpha, { prices_recorded: false, total_amount: null, currency_code: null }) } as Record<string, any>,
    expenses: [
      { order_id: A_ORDER1, currency_code: "USD", goods_cost: "300000.0000", delivery_charges: "20000.0000", other_expenses: [{ label: "Packing", amount: "5000.0000" }], updated_by_email: "a@b.c", updated_at: now },
      { order_id: A_ORDER2, currency_code: "USD", goods_cost: "900.0000", delivery_charges: "150.0000", other_expenses: [], updated_by_email: "a@b.c", updated_at: now },
    ],
    products: [{ id: A_PRODUCT, sku: "BOLT-1", name: "Steel bolt", cost_price: "60.0000", currency_code: "USD" }],
  },
  "token-beta": { orders: [order(B_ORDER, "SO-000001", beta)], details: { [B_ORDER]: detail(B_ORDER, "SO-000001", beta) } as Record<string, any>, expenses: [], products: [] as any[] },
});
let orgs: any = fresh();

let calls: { url: string; headers: Record<string, string>; method: string }[] = [];
function stubWorld(options: { sales?: number; finance?: number; inventory?: number; modules?: string[] } = {}) {
  calls = [];
  const users: Record<string, any> = { "token-alpha": orgAdmin, "token-beta": orgAdminB, "token-super": superAdmin };
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers, method: init.method ?? "GET" });
    const token = (headers.Authorization ?? "").replace("Bearer ", "");
    if (url.endsWith("/api/v1/auth/me")) return users[token] ? json(200, users[token]) : json(401, {});
    if (url.endsWith("/api/v1/tenant/organization")) return users[token] ? json(200, { ...alphaOrg, modules: options.modules ?? ["inventory", "sales", "finance"] }) : json(401, {});
    const org = orgs[token];
    const path = new URL(url).pathname;
    const params = new URL(url).searchParams;
    const page = (items: any[]) => json(200, { items, total: items.length, limit: Number(params.get("limit")), offset: Number(params.get("offset")) });
    if (path.startsWith("/api/v1/sales/")) {
      if (options.sales) return json(options.sales, { detail: "x" });
      if (!org) return json(401, {});
      if (path === "/api/v1/sales/orders") return page(org.orders.filter((o: any) => !params.get("q") || (o.number + o.client.name).toLowerCase().includes(params.get("q")!.toLowerCase())));
      const match = path.match(/^\/api\/v1\/sales\/orders\/([^/]+)$/);
      if (match) return org.details[match[1]] ? json(200, org.details[match[1]]) : json(404, { detail: "Order not found." });
    }
    if (path.startsWith("/api/v1/finance/order-expenses")) {
      if (options.finance) return json(options.finance, { detail: "x" });
      if (!org) return json(401, {});
      if (path === "/api/v1/finance/order-expenses") return json(200, { items: org.expenses.filter((e: any) => (params.get("order_ids") ?? "").split(",").includes(e.order_id)) });
      const found = org.expenses.find((e: any) => path.endsWith(e.order_id));
      return found ? json(200, found) : json(404, { detail: "No expenses saved for this order." });
    }
    if (path === "/api/v1/inventory/products") {
      if (options.inventory) return json(options.inventory, { detail: "x" });
      return page(org?.products ?? []);
    }
    return json(404, {});
  }));
}
const financeCalls = () => calls.filter((c) => c.url.includes("/api/v1/finance/"));
const salesCalls = () => calls.filter((c) => c.url.includes("/api/v1/sales/"));
const render = async (element: Promise<any>) => renderToStaticMarkup(await element);

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  process.env.SALES_SERVICE_URL = "http://sales-service:8003";
  process.env.FINANCE_SERVICE_URL = "http://finance-service:8006";
  process.env.INVENTORY_SERVICE_URL = "http://inventory-service:8002";
  for (const key of Object.keys(jar)) delete jar[key];
  orgs = fresh();
});
afterEach(() => vi.unstubAllGlobals());

describe("the PNL Calculator's layout", () => {
  it("is inside the protected frame as a page of the Finance module: no session goes to login, and an organization without Finance is told so", async () => {
    stubWorld();
    await expect((PnlLayout as any)({ children: null })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = renderToStaticMarkup(await (PnlLayout as any)({ children: "PAGE" }));
    expect(html).toContain("PAGE");
    expect(html).toContain('href="/pnl-calculator"'); // in the Finance group of the menu
    expect(html).toContain("PNL Calculator");
    stubWorld({ modules: ["inventory", "sales"] }); // Finance is not enabled for this organization
    const denied = renderToStaticMarkup(await (PnlLayout as any)({ children: "PAGE" }));
    expect(denied).not.toContain("PAGE");
    expect(denied).toContain("data-module-denied");
  });
});

describe("Finance > PNL Calculator: the orders", () => {
  it("lists every order, newest first, with its selling price and its result: Profit, Loss, Not calculated or No prices", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(PnlCalculatorPage({ searchParams: {} }));
    for (const expected of ["SO-000002", "SO-000001", "SO-000000", "Alpha Metals", "500,000.00 USD", "Open SO-000001"]) expect(html, expected).toContain(expected);
    expect(html).toContain(`href="/pnl-calculator/${A_ORDER1}"`);
  });

  it("works each result out from the order's own selling price and the saved expenses", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(PnlCalculatorPage({ searchParams: {} }));
    expect(html).toContain("Profit 175,000.00 USD"); // 500,000 - 300,000 - 20,000 - 5,000
    expect(html).toContain("Loss 50.00 USD"); // 1,000 - 900 - 150
    expect(html).toContain("No prices"); // an order made before prices were recorded
    expect(html.indexOf("SO-000002")).toBeLessThan(html.indexOf("SO-000001")); // the order service's order (newest first) is kept
  });

  it("says Not calculated until the expenses of an order are saved", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    orgs["token-alpha"].expenses = [];
    expect(await render(PnlCalculatorPage({ searchParams: {} }))).toContain("Not calculated");
  });

  it("asks the Sales Service for the trade orders with only the whitelisted filters, and the Finance Service only for these orders", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await PnlCalculatorPage({ searchParams: { q: "so-1", page: "2", organization_id: "x", sort: "y", client: "z" } });
    const ask = salesCalls().find((c) => new URL(c.url).pathname === "/api/v1/sales/orders")!;
    expect(Object.fromEntries(new URL(ask.url).searchParams)).toEqual({ view: "trade", limit: "25", offset: "25", q: "so-1" });
    calls = [];
    await PnlCalculatorPage({ searchParams: { page: "banana" } });
    expect(Object.fromEntries(new URL(salesCalls()[0].url).searchParams)).toEqual({ view: "trade", limit: "25", offset: "0" });
    expect(new URL(financeCalls()[0].url).searchParams.get("order_ids")).toBe(`${A_ORDER2},${A_ORDER1},${A_OLD}`);
  });

  it("two organizations: each sees only their own orders", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const a = await render(PnlCalculatorPage({ searchParams: {} }));
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const b = await render(PnlCalculatorPage({ searchParams: {} }));
    expect(a).toContain("Alpha Metals");
    expect(a).not.toContain("Beta Textiles");
    expect(b).toContain("Beta Textiles");
    expect(b).not.toContain("Alpha Metals");
  });

  it("redirects without a session / for a Super Admin, and explains an outage, a missing Sales module and an empty list", async () => {
    stubWorld();
    await expect(PnlCalculatorPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(PnlCalculatorPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ sales: 503 });
    expect(await render(PnlCalculatorPage({ searchParams: {} }))).toContain("temporarily unavailable");
    stubWorld({ sales: 403 });
    expect(await render(PnlCalculatorPage({ searchParams: {} }))).toContain("Sales module");
    stubWorld({ sales: 401 });
    await expect(PnlCalculatorPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    orgs["token-alpha"].orders = [];
    stubWorld();
    expect(await render(PnlCalculatorPage({ searchParams: {} }))).toContain("No orders yet");
    expect(await render(PnlCalculatorPage({ searchParams: { q: "zzz" } }))).toContain("No orders found");
  });

  it("still lists the orders when the Finance Service is down (they just show Not calculated)", async () => {
    stubWorld({ finance: 503 });
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(PnlCalculatorPage({ searchParams: {} }));
    expect(html).toContain("SO-000001");
    expect(html).toContain("Not calculated");
  });
});

describe("Finance > PNL Calculator: one order", () => {
  const open = (orderId: string) => render(PnlOrderPage({ params: { orderId } }));

  it("shows the order's selling price and, with nothing saved, the cost of the goods taken from the products' cost prices", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    orgs["token-alpha"].expenses = [];
    const html = await open(A_ORDER1);
    for (const expected of ["SO-000001", "Alpha Metals", "500,000.00 USD", "Cost of goods", "Delivery charges", "Add expense", "Save", "Profit", "Selling price"]) expect(html, expected).toContain(expected);
    expect(html).toContain('value="300000"'); // 5,000 pcs x 60.00
    expect(html).toContain("From your products");
  });

  it("opens with what was saved, in the boxes, with the result worked out", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await open(A_ORDER1);
    expect(html).toContain('value="300000"');
    expect(html).toContain('value="20000"');
    expect(html).toContain('value="Packing"');
    expect(html).toContain('value="5000"');
    expect(html).toMatch(/data-verdict[^>]*>Profit</);
    expect(html).toContain("175,000.00 USD");
    expect(html).not.toContain("From your products"); // what was saved is not replaced by a suggestion
  });

  it("asks the person to enter the cost when a product has no cost price in the order's currency", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    orgs["token-alpha"].expenses = [];
    orgs["token-alpha"].products = [{ id: A_PRODUCT, sku: "BOLT-1", name: "Steel bolt", cost_price: "60.0000", currency_code: "EUR" }];
    const html = await open(A_ORDER1);
    expect(html).toContain("no cost price in USD");
    expect(html).not.toContain('value="300000"');
  });

  it("another organization's order is shown exactly like one that does not exist, a malformed id too, and an order without prices cannot be worked out", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await open(B_ORDER)).toContain("Order not found.");
    expect(await open("not-a-uuid")).toContain("Order not found.");
    expect(await open(A_OLD)).toContain("has no prices");
  });

  it("redirects an expired session and explains an outage", async () => {
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ sales: 401 });
    await expect(open(A_ORDER1)).rejects.toThrow("REDIRECT:/login");
    stubWorld({ sales: 503 });
    expect(await open(A_ORDER1)).toContain("temporarily unavailable");
    delete jar[TENANT_SESSION_COOKIE];
    stubWorld();
    await expect(open(A_ORDER1)).rejects.toThrow("REDIRECT:/login");
  });
});
