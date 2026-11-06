import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { alphaOrg, orgAdmin, orgAdminB, superAdmin } from "./helpers";

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

import PurchaseOrdersLayout from "@/app/purchase-orders/layout";
import PurchaseOrdersPage from "@/app/purchase-orders/page";
import PurchaseOrderPage from "@/app/purchase-orders/[id]/page";
import SuppliersLayout from "@/app/suppliers/layout";
import SuppliersPage from "@/app/suppliers/page";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-06T10:00:00+00:00";
const ALPHA_ORDER = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718";
const BETA_ORDER = "9d4f3b3d-4e5f-4a6b-9bc3-d4e5f6071829";
const ALPHA_SUPPLIER = "a1111111-1111-4111-8111-111111111111";
const BETA_SUPPLIER = "b2222222-2222-4222-8222-222222222222";

const supplier = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, code: null, contact_person: `${name} contact`, email: null, phone: null, address: null, country_code: "DE", tax_identifier: null, is_active: true, created_at: now, updated_at: now, ...extra,
});
const summary = (id: string, number: string, s: ReturnType<typeof supplier>, extra: Record<string, unknown> = {}) => ({
  id, number, supplier: { id: s.id, name: s.name, code: s.code, is_active: s.is_active }, supplier_reference: `${s.name}-REF`, order_date: "2026-11-06", expected_delivery_date: null,
  currency_code: "USD", notes: null, status: "draft", line_count: 1, total_amount: "62.5000", created_by_email: "a@b.c", ordered_at: null, ordered_by_email: null,
  cancelled_at: null, cancelled_by_email: null, created_at: now, updated_at: now, ...extra,
});
const detail = (s: ReturnType<typeof summary>, productName: string, extra: Record<string, unknown> = {}) => ({
  ...s,
  lines: [{
    id: crypto.randomUUID(), product_id: crypto.randomUUID(), product_sku: "SKU-1", product_name: productName, unit: "pcs", quantity: "50.0000", unit_price: "1.2500", line_total: "62.5000",
    planned_warehouse_id: null, planned_warehouse_code: "MAIN", notes: null, created_at: now, updated_at: now,
  }],
  frozen: s.status !== "draft",
  stock_notice: "A purchase order does not change your stock. Placing an order does not add the goods to inventory; they are added only when they are received (a later step).",
  ...extra,
});

const alphaSupplier = supplier(ALPHA_SUPPLIER, "Alpha Metals");
const betaSupplier = supplier(BETA_SUPPLIER, "Beta Textiles");
const freshOrgs = () => ({
  "token-alpha": { suppliers: [alphaSupplier], orders: [summary(ALPHA_ORDER, "PO-000001", alphaSupplier)], details: { [ALPHA_ORDER]: detail(summary(ALPHA_ORDER, "PO-000001", alphaSupplier), "Alpha steel bolt") } as Record<string, any> },
  "token-beta": { suppliers: [betaSupplier], orders: [summary(BETA_ORDER, "PO-000001", betaSupplier)], details: { [BETA_ORDER]: detail(summary(BETA_ORDER, "PO-000001", betaSupplier), "Beta silk scarf") } as Record<string, any> },
});
let orgs = freshOrgs();

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
      if (url.includes("/api/v1/inventory/")) return json(200, { items: [{ id: "w1", code: "MAIN", name: "Main", is_active: true }], total: 1, limit: 200, offset: 0 });
      if (!url.includes("/api/v1/purchasing/")) return json(404, {});
      if (options.status) return json(options.status, { detail: "x" });
      const org = (orgs as any)[token];
      if (!org) return json(401, {});
      const path = new URL(url).pathname.replace("/api/v1/purchasing", "");
      const params = new URL(url).searchParams;
      const page = (items: any[]) => json(200, { items, total: items.length, limit: Number(params.get("limit")), offset: Number(params.get("offset")) });
      if (path === "/suppliers") return page(org.suppliers);
      if (path === "/purchase-orders") return page(org.orders.filter((o: any) => !params.get("supplier_id") || o.supplier.id === params.get("supplier_id")));
      const match = path.match(/^\/purchase-orders\/([^/]+)$/);
      if (match) return org.details[match[1]] ? json(200, org.details[match[1]]) : json(404, { detail: "Purchase order not found." });
      return json(404, {});
    })
  );
}
const purchasingCalls = () => calls.filter((c) => c.url.includes("/api/v1/purchasing/"));
const render = async (element: Promise<any>) => renderToStaticMarkup(await element);

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.INVENTORY_SERVICE_URL = "http://inventory-service:8002";
  process.env.PURCHASING_SERVICE_URL = "http://purchasing-service:8004";
  for (const key of Object.keys(jar)) delete jar[key];
  orgs = freshOrgs();
});
afterEach(() => vi.unstubAllGlobals());

describe("Suppliers page", () => {
  it("lists the suppliers with the add button, search and status filter", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(SuppliersPage({ searchParams: {} }));
    for (const expected of ["Suppliers", "Add Supplier", "Alpha Metals", "Alpha Metals contact", "Active", "Edit", "Deactivate", "Showing 1–1 of 1", "Search", "Status"]) expect(html, expected).toContain(expected);
  });

  it("two organizations: each administrator sees only their own suppliers", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const alpha = await render(SuppliersPage({ searchParams: {} }));
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const beta = await render(SuppliersPage({ searchParams: {} }));
    expect(alpha).toContain("Alpha Metals");
    expect(alpha).not.toContain("Beta Textiles");
    expect(beta).toContain("Beta Textiles");
    expect(beta).not.toContain("Alpha Metals");
  });

  it("passes only whitelisted filters to the service", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await SuppliersPage({ searchParams: { q: "acme", status: "inactive", page: "3", organization_id: BETA_SUPPLIER, sort: "x" } });
    expect(Object.fromEntries(new URL(purchasingCalls()[0].url).searchParams)).toEqual({ q: "acme", status: "inactive", limit: "25", offset: "50" });
    calls = [];
    await SuppliersPage({ searchParams: { status: "bogus", page: "banana" } });
    expect(Object.fromEntries(new URL(purchasingCalls()[0].url).searchParams)).toEqual({ status: "active", limit: "25", offset: "0" });
  });

  it("redirects without a session / for a Super Admin / the wrong cookie, calling no purchasing endpoint", async () => {
    stubWorld();
    await expect(SuppliersPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(SuppliersPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    delete jar[TENANT_SESSION_COOKIE];
    jar["impex_session"] = "token-alpha";
    await expect(SuppliersPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    expect(purchasingCalls()).toHaveLength(0);
  });

  it("explains an inactive organization, an outage, and an expired session", async () => {
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 403 });
    expect(await render(SuppliersPage({ searchParams: {} }))).toContain("currently inactive or unavailable");
    stubWorld({ status: 503 });
    expect(await render(SuppliersPage({ searchParams: {} }))).toContain("temporarily unavailable");
    stubWorld({ status: 401 });
    await expect(SuppliersPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
  });

  it("shows different empty states for 'nothing yet' and 'no match'", async () => {
    orgs["token-alpha"].suppliers = [];
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render(SuppliersPage({ searchParams: {} }))).toContain("No suppliers yet");
    expect(await render(SuppliersPage({ searchParams: { q: "zzz" } }))).toContain("No suppliers match these filters");
  });
});

describe("Purchase Orders page", () => {
  it("lists the orders with number, supplier, date, lines, total and status, plus the create button", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(PurchaseOrdersPage({ searchParams: {} }));
    for (const expected of ["Purchase Orders", "PO-000001", "Alpha Metals", "2026-11-06", "62.50 USD", "Draft", "New Purchase Order", "All suppliers", "All statuses", "does not change your stock"]) expect(html, expected).toContain(expected);
  });

  it("passes only whitelisted filters (valid supplier id, known status, text, page)", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await PurchaseOrdersPage({ searchParams: { q: "po", supplier: ALPHA_SUPPLIER, status: "ordered", page: "2", organization_id: BETA_SUPPLIER } });
    const call = purchasingCalls().find((c) => new URL(c.url).pathname === "/api/v1/purchasing/purchase-orders")!;
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({ q: "po", supplier_id: ALPHA_SUPPLIER, status: "ordered", limit: "25", offset: "25" });
    calls = [];
    await PurchaseOrdersPage({ searchParams: { supplier: "' OR 1=1", status: "shipped", page: "banana" } });
    const clean = purchasingCalls().find((c) => new URL(c.url).pathname === "/api/v1/purchasing/purchase-orders")!;
    expect([...new URL(clean.url).searchParams.keys()].sort()).toEqual(["limit", "offset"]);
  });

  it("two organizations: each sees only their own orders", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const alpha = await render(PurchaseOrdersPage({ searchParams: {} }));
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const beta = await render(PurchaseOrdersPage({ searchParams: {} }));
    expect(alpha).toContain("Alpha Metals");
    expect(beta).toContain("Beta Textiles");
    for (const leak of ["Beta Textiles", "Beta Textiles-REF"]) expect(alpha, leak).not.toContain(leak);
    for (const leak of ["Alpha Metals", "Alpha Metals-REF"]) expect(beta, leak).not.toContain(leak);
  });

  it("uses the session token, never names an organization, and only reads", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await PurchaseOrdersPage({ searchParams: { organization_id: BETA_SUPPLIER, org: BETA_SUPPLIER } });
    for (const c of purchasingCalls()) {
      expect(c.headers.Authorization).toBe("Bearer token-alpha");
      expect(c.url).not.toMatch(/organization|tenant|org=/i);
      expect(c.method).toBe("GET");
    }
  });

  it("redirects invalid sessions and explains outages", async () => {
    stubWorld();
    await expect(PurchaseOrdersPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(PurchaseOrdersPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 503 });
    expect(await render(PurchaseOrdersPage({ searchParams: {} }))).toContain("temporarily unavailable");
    stubWorld({ status: 403 });
    expect(await render(PurchaseOrdersPage({ searchParams: {} }))).toContain("currently inactive or unavailable");
  });
});

describe("Purchase order detail page", () => {
  const page = (id: string) => render(PurchaseOrderPage({ params: { id } }));

  it("shows the lines, the calculated total, the actions and the 'no stock' notice", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(ALPHA_ORDER);
    for (const expected of ["PO-000001", "Alpha Metals", "Alpha steel bolt", "SKU-1", "50", "pcs", "1.25 USD", "62.50 USD", "Order total", "Mark as Ordered", "Cancel order", "Find a product", "Edit order details", "does not change your stock"]) {
      expect(html, expected).toContain(expected);
    }
  });

  it("two organizations: another organization's order id is simply 'not found'", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const ownAlpha = await page(ALPHA_ORDER);
    const alphaTriesBeta = await page(BETA_ORDER);
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const ownBeta = await page(BETA_ORDER);
    const betaTriesAlpha = await page(ALPHA_ORDER);
    expect(ownAlpha).toContain("Alpha steel bolt");
    expect(ownBeta).toContain("Beta silk scarf");
    expect(alphaTriesBeta).toContain("Purchase order not found.");
    expect(betaTriesAlpha).toContain("Purchase order not found.");
    for (const leak of ["Beta", "scarf", "Textiles"]) expect(ownAlpha + alphaTriesBeta, `alpha saw ${leak}`).not.toContain(leak);
    for (const leak of ["Alpha", "bolt", "Metals"]) expect(ownBeta + betaTriesAlpha, `beta saw ${leak}`).not.toContain(leak);
  });

  it("does not call the service for something that is not an id", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await page("../../etc/passwd")).toContain("Purchase order not found.");
    expect(purchasingCalls()).toHaveLength(0);
  });

  it("an Ordered order is frozen in the UI: no editing controls, but it can still be cancelled", async () => {
    orgs["token-alpha"].details[ALPHA_ORDER] = detail(summary(ALPHA_ORDER, "PO-000001", alphaSupplier, { status: "ordered", ordered_at: now, ordered_by_email: "a@b.c" }), "Alpha steel bolt");
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(ALPHA_ORDER);
    expect(html).toContain("This order has been placed");
    expect(html).toContain("frozen");
    expect(html).toContain("Cancel order");
    for (const absent of ["Mark as Ordered", "Find a product", "Edit order details"]) expect(html, absent).not.toContain(absent);
    expect(html).not.toMatch(/aria-label="Remove /);
    expect(html).not.toMatch(/aria-label="Edit Alpha/);
    // pickers are only needed while editing: no warehouse / supplier requests
    expect(calls.filter((c) => c.url.includes("/api/v1/inventory/"))).toHaveLength(0);
  });

  it("a Cancelled order has no actions at all", async () => {
    orgs["token-alpha"].details[ALPHA_ORDER] = detail(summary(ALPHA_ORDER, "PO-000001", alphaSupplier, { status: "cancelled", cancelled_at: now, cancelled_by_email: "a@b.c" }), "Alpha steel bolt");
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(ALPHA_ORDER);
    expect(html).toContain("kept for history");
    for (const absent of ["Mark as Ordered", "Cancel order", "Find a product", "Edit order details"]) expect(html, absent).not.toContain(absent);
  });

  it("redirects invalid sessions and explains outages", async () => {
    stubWorld();
    await expect(page(ALPHA_ORDER)).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(page(ALPHA_ORDER)).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 503 });
    expect(await page(ALPHA_ORDER)).toContain("temporarily unavailable");
    stubWorld({ status: 403 });
    expect(await page(ALPHA_ORDER)).toContain("currently inactive or unavailable");
    stubWorld({ status: 401 });
    await expect(page(ALPHA_ORDER)).rejects.toThrow("REDIRECT:/login");
  });
});

describe("navigation and layouts", () => {
  it.each([["Suppliers", SuppliersLayout], ["Purchase Orders", PurchaseOrdersLayout]])("%s: redirects invalid sessions before streaming, marks itself current and links everywhere", async (label, layout) => {
    stubWorld();
    await expect((layout as any)({ children: null })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = renderToStaticMarkup(await (layout as any)({ children: "PAGE" }));
    expect(html.match(/<a[^>]*aria-current="page"[^>]*>([^<]*)</)?.[1]).toBe(label);
    for (const href of ["/", "/products", "/warehouses", "/stock", "/scan", "/movements", "/delivery-lists", "/clients", "/suppliers", "/purchase-orders"]) expect(html).toContain(`href="${href}"`);
  });
});
