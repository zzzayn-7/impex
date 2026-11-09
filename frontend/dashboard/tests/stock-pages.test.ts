import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ORG_B_ID, ORG_ID, orgAdmin, orgAdminB, superAdmin, alphaOrg } from "./helpers";

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

import MovementsLayout from "@/app/movements/layout";
import MovementsPage from "@/app/movements/page";
import StockLayout from "@/app/stock/layout";
import StockPage from "@/app/stock/page";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const id = () => crypto.randomUUID();
const now = "2026-11-04T10:00:00+00:00";

const product = (sku: string, name: string, unit = "pcs", extra: Record<string, unknown> = {}) => ({
  id: id(), sku, name, description: null, unit, unit_allows_fractions: unit === "kg", hs_code: null, cost_price: "1.0000",
  selling_price: "2.0000", currency_code: "USD", is_active: true, created_at: now, updated_at: now, ...extra,
});

type Org = { products: any[]; stock: any[]; movements: any[] };

function makeOrg(prefix: "alpha" | "beta"): Org {
  const bolt = product(`${prefix.toUpperCase()}-BOLT`, `${prefix} steel bolt`);
  const flour = product(`${prefix.toUpperCase()}-FLOUR`, `${prefix} flour`, "kg");
  return {
    products: [bolt, flour],
    stock: [
      {
        product_id: bolt.id, sku: bolt.sku, name: bolt.name, unit: "pcs", unit_allows_fractions: false, is_active: true,
        total_quantity: "1234.0000",
      },
      {
        product_id: flour.id, sku: flour.sku, name: flour.name, unit: "kg", unit_allows_fractions: true, is_active: true,
        total_quantity: "0.1000",
      },
    ],
    movements: [
      {
        id: id(), operation_id: id(), product_id: bolt.id, product_sku: bolt.sku, product_name: bolt.name, product_unit: "pcs", unit_allows_fractions: false,
        movement_type: "in", quantity: "1234.0000", balance_after: "1234.0000",
        reason: `${prefix} supplier delivery`, created_by_email: `${prefix}@example.org`, created_at: "2026-11-04T10:15:00+00:00",
      },
      {
        id: id(), operation_id: id(), product_id: bolt.id, product_sku: bolt.sku, product_name: bolt.name, product_unit: "pcs", unit_allows_fractions: false,
        movement_type: "out", quantity: "34.0000", balance_after: "1200.0000",
        reason: `${prefix} damaged`, created_by_email: `${prefix}@example.org`, created_at: "2026-11-04T11:00:00+00:00",
      },
    ],
  };
}

type World = { orgs: Record<string, Org>; users: Record<string, Record<string, unknown>>; inventoryStatus?: number };
let calls: { url: string; headers: Record<string, string> }[] = [];

function stubWorld(world: World) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers });
      const token = (headers.Authorization ?? "").replace("Bearer ", "");
      if (url.endsWith("/api/v1/auth/me")) return world.users[token] ? json(200, world.users[token]) : json(401, {});
      if (url.endsWith("/api/v1/tenant/organization")) return world.users[token] ? json(200, alphaOrg) : json(401, {}); // the layout checks first-time setup
      if (url.includes("/api/v1/inventory/")) {
        if (world.inventoryStatus) return json(world.inventoryStatus, { detail: "x" });
        const org = world.orgs[token];
        if (!org) return json(401, {});
        const params = new URL(url).searchParams;
        const page = (items: any[]) => json(200, { items, total: items.length, limit: Number(params.get("limit")), offset: Number(params.get("offset")) });
        const path = new URL(url).pathname;
        if (path.endsWith("/products")) return page(org.products);
        if (path.endsWith("/stock/movements")) return page(org.movements);
        if (path.endsWith("/stock")) return page(org.stock);
      }
      return json(404, {});
    })
  );
}

const normalWorld = (): World => ({
  orgs: { "token-alpha": makeOrg("alpha"), "token-beta": makeOrg("beta") },
  users: { "token-alpha": orgAdmin, "token-beta": orgAdminB, "token-super": superAdmin },
});
const inventoryCalls = () => calls.filter((c) => c.url.includes("/api/v1/inventory/"));

type Page = (props: { searchParams: Record<string, string | string[] | undefined> }) => Promise<any>;
const render = async (page: Page, searchParams: Record<string, string | string[] | undefined> = {}) => renderToStaticMarkup(await page({ searchParams }));

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.INVENTORY_SERVICE_URL = "http://inventory-service:8002";
  for (const key of Object.keys(jar)) delete jar[key];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const PAGES: [string, Page][] = [
  ["Stock", StockPage as Page],
  ["Movements", MovementsPage as Page],
];

describe("Stock page", () => {
  it("shows the exact quantity of each product, plus the add / remove actions", async () => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(StockPage as Page);
    for (const expected of ["Stock", "alpha steel bolt", "ALPHA-BOLT", "1,234", "pcs", "0.1", "kg", "Add Stock", "Remove Stock", "Opening Balance"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html.toLowerCase()).not.toContain("warehouse");
    expect(html).not.toContain("Transfer");
    expect(html).not.toContain("0.1000"); // trailing zeros are not shown, and nothing is rounded to 0
  });

  it("only offers the form's actions when there is a product", async () => {
    stubWorld({ ...normalWorld(), orgs: { "token-alpha": { ...makeOrg("alpha"), products: [] } } });
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(StockPage as Page);
    expect(html).toContain("No products yet");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Add Stock/); // registering the first product is always possible
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Remove Stock/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Opening Balance/);
  });

  it("passes only whitelisted filters; a warehouse in the URL is ignored", async () => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const wid = "11111111-1111-4111-8111-111111111111";
    await render(StockPage as Page, { q: "bolt", warehouse: wid, inStock: "1", status: "all", page: "2", organization_id: ORG_B_ID });
    const stockCall = inventoryCalls().find((c) => new URL(c.url).pathname.endsWith("/stock"))!;
    expect(Object.fromEntries(new URL(stockCall.url).searchParams)).toEqual({ q: "bolt", in_stock_only: "true", status: "all", limit: "25", offset: "25" });
  });
});

describe("Movements page", () => {
  it("shows the history newest data with who, what, where and the balance afterwards", async () => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(MovementsPage as Page);
    for (const expected of ["Stock Movements", "Stock in", "Stock out", "+1,234", "−34", "1,200", "alpha supplier delivery", "alpha damaged", "alpha@example.org", "2026-11-04 10:15 UTC", "can never be edited or deleted"]) {
      expect(html, expected).toContain(expected);
    }
  });

  it("offers filters for product and type, and sends them (validated) to the service", async () => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const pid = "11111111-1111-4111-8111-111111111111";
    const wid = "22222222-2222-4222-8222-222222222222";
    const html = await render(MovementsPage as Page, { product: pid, warehouse: wid, type: "out", page: "3" });
    for (const label of ["All products", "All types", "Stock out", "Opening balance"]) expect(html, label).toContain(label);
    expect(html.toLowerCase()).not.toContain("warehouse");
    expect(html).not.toContain("Transfer");
    const call = inventoryCalls().find((c) => new URL(c.url).pathname.endsWith("/stock/movements"))!;
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({ product_id: pid, type: "out", limit: "25", offset: "50" });

    await render(MovementsPage as Page, { product: "x", warehouse: "y", type: "transfer_out" });
    const clean = inventoryCalls().filter((c) => new URL(c.url).pathname.endsWith("/stock/movements")).pop()!;
    expect([...new URL(clean.url).searchParams.keys()].sort()).toEqual(["limit", "offset"]);
  });

  it("explains an empty history", async () => {
    stubWorld({ ...normalWorld(), orgs: { "token-alpha": { ...makeOrg("alpha"), movements: [] } } });
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render(MovementsPage as Page)).toContain("No stock movements yet");
  });
});

describe("two organizations: each administrator's pages contain only their own data", () => {
  it.each(PAGES)("%s", async (_name, page) => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const alphaHtml = await render(page, { status: "all" });
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const betaHtml = await render(page, { status: "all" });

    expect(alphaHtml).toContain("alpha");
    expect(betaHtml).toContain("beta");
    expect(alphaHtml.toLowerCase()).not.toContain("beta");
    expect(betaHtml.toLowerCase()).not.toContain("alpha");
  });

  it("an organization id in the URL changes nothing and is never forwarded", async () => {
    for (const [, page] of PAGES) {
      stubWorld(normalWorld());
      jar[TENANT_SESSION_COOKIE] = "token-alpha";
      const html = await render(page, { organization_id: ORG_B_ID, org_id: ORG_B_ID, tenant: ORG_B_ID });
      expect(html.toLowerCase()).not.toContain("beta");
      for (const call of inventoryCalls()) {
        expect(call.url).not.toContain(ORG_B_ID);
        expect(call.url).not.toContain(ORG_ID);
        expect(call.url).not.toMatch(/organization|tenant|org_id/i);
      }
    }
  });
});

describe("access and failure handling", () => {
  it.each(PAGES)("%s: sends the session token, never renders it, and calls only the Inventory Service for data", async (_name, page) => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(page);
    expect(html).not.toContain("token-alpha");
    expect(inventoryCalls().length).toBeGreaterThan(0);
    for (const call of inventoryCalls()) expect(call.headers.Authorization).toBe("Bearer token-alpha");
  });

  it.each(PAGES)("%s: redirects without a session, for a Super Admin and for the wrong cookie, calling nothing", async (_name, page) => {
    stubWorld(normalWorld());
    await expect(page({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(page({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    delete jar[TENANT_SESSION_COOKIE];
    jar["impex_session"] = "token-alpha";
    await expect(page({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    expect(inventoryCalls()).toHaveLength(0);
  });

  it.each(PAGES)("%s: explains an inactive organization (403) without showing data", async (_name, page) => {
    stubWorld({ ...normalWorld(), inventoryStatus: 403 });
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(page);
    expect(html).toContain("currently inactive or unavailable");
    expect(html.toLowerCase()).not.toContain("alpha steel");
  });

  it.each(PAGES)("%s: shows a notice when the Inventory Service is down", async (_name, page) => {
    stubWorld({ ...normalWorld(), inventoryStatus: 503 });
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render(page)).toContain("temporarily unavailable");
  });

  it.each(PAGES)("%s: sends the user to /login when the service says the session is no longer valid", async (_name, page) => {
    stubWorld({ ...normalWorld(), inventoryStatus: 401 });
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await expect(page({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
  });
});

describe("layouts (run before the page streams)", () => {
  const LAYOUTS: [string, (p: { children: any }) => Promise<any>, string][] = [
    ["stock", StockLayout as any, "Stock"],
    ["movements", MovementsLayout as any, "Movements"],
  ];

  it.each(LAYOUTS)("%s: invalid sessions are redirected before anything is streamed", async (_name, layout) => {
    stubWorld(normalWorld());
    await expect(layout({ children: null })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(layout({ children: null })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "expired";
    await expect(layout({ children: null })).rejects.toThrow("REDIRECT:/login");
    expect(inventoryCalls()).toHaveLength(0);
  });

  it.each(LAYOUTS)("%s: wraps the page in the header, with the inventory links and the current one marked", async (_name, layout, label) => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = renderToStaticMarkup(await layout({ children: "PAGE-CONTENT" }));
    for (const expected of ["PAGE-CONTENT", "Alpha Trading GmbH", "Dashboard", "Stock", "Movements", "Sign out"]) {
      expect(html, expected).toContain(expected);
    }
    const current = (html.match(/<a[^>]*aria-current="page"[^>]*>(.*?)<\/a>/)?.[1] ?? "").replace(/<[^>]+>/g, "");
    expect(current).toBe(label);
    for (const href of ["/", "/stock", "/movements"]) expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain('href="/products"'); // no standalone Products entry
    expect(html).not.toContain("/warehouses");
  });
});
