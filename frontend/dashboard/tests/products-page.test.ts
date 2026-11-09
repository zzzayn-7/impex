import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ORG_B_ID, ORG_ID, orgAdmin, orgAdminB, superAdmin, alphaOrg } from "./helpers";

// A mutable cookie jar standing in for the incoming request's cookies.
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

import ProductsLayout from "@/app/products/layout";
import ProductsPage from "@/app/products/page";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const product = (sku: string, name: string, extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), sku, name, description: null, unit: "pcs", hs_code: null, cost_price: "10.5000",
  selling_price: "15.9900", currency_code: "USD", is_active: true, created_at: "2026-11-04T10:00:00+00:00", updated_at: "2026-11-04T10:00:00+00:00", ...extra,
});
const alphaProducts = [product("ALPHA-1", "Alpha steel bolt", { hs_code: "7318.15" }), product("ALPHA-2", "Alpha nut")];
const betaProducts = [product("BETA-1", "Beta silk scarf", { cost_price: "0.1000", selling_price: "1234567.8912", currency_code: "EUR" })];

type World = {
  catalogs: Record<string, unknown[]>; // token -> that organization's products
  users: Record<string, Record<string, unknown>>;
  inventoryStatus?: number; // force an answer from the Inventory Service
};
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
        const own = world.catalogs[token];
        if (!own) return json(401, {});
        const params = new URL(url).searchParams;
        const q = (params.get("q") ?? "").toLowerCase();
        const items = (own as any[]).filter((p) => !q || `${p.sku} ${p.name}`.toLowerCase().includes(q));
        return json(200, { items, total: items.length, limit: 25, offset: Number(params.get("offset")) });
      }
      return json(404, {});
    })
  );
}

const normalWorld = (): World => ({
  catalogs: { "token-alpha": alphaProducts, "token-beta": betaProducts },
  users: { "token-alpha": orgAdmin, "token-beta": orgAdminB, "token-super": superAdmin },
});
const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await ProductsPage({ searchParams }));
const productCalls = () => calls.filter((c) => c.url.includes("/inventory/products"));

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.INVENTORY_SERVICE_URL = "http://inventory-service:8002";
  for (const key of Object.keys(jar)) delete jar[key];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Products page", () => {
  it("shows the product table with exact, formatted prices", async () => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render();
    for (const expected of ["Products", "Add Product", "Alpha steel bolt", "ALPHA-1", "7318.15", "10.50 USD", "15.99 USD", "Active", "Showing 1–2 of 2", "Edit", "Archive"]) {
      expect(html, expected).toContain(expected);
    }
  });

  it("never displays rounded or floating-point prices", async () => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const html = await render();
    expect(html).toContain("0.10 EUR"); // cost "0.1000"
    expect(html).toContain("1,234,567.8912 EUR");
  });

  it("two organizations: each administrator's page contains only their own catalog", async () => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const alphaHtml = await render();
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const betaHtml = await render();

    expect(alphaHtml).toContain("Alpha steel bolt");
    expect(betaHtml).toContain("Beta silk scarf");
    for (const leak of ["Beta silk scarf", "BETA-1"]) expect(alphaHtml, `alpha page leaked ${leak}`).not.toContain(leak);
    for (const leak of ["Alpha steel bolt", "ALPHA-1", "ALPHA-2", "7318.15"]) expect(betaHtml, `beta page leaked ${leak}`).not.toContain(leak);
  });

  it("asks the Inventory Service with the session token and only whitelisted query parameters", async () => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await render({ q: "bolt", category: "Hardware", status: "all", page: "2" }); // a leftover category in an old bookmark is simply ignored
    const [call] = productCalls();
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe("http://inventory-service:8002/api/v1/inventory/products");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "bolt", status: "all", limit: "25", offset: "25" });
    expect(call.headers.Authorization).toBe("Bearer token-alpha");
    expect(Object.keys(call.headers)).toEqual(["Authorization"]);
  });

  it("ignores organization parameters in the URL and sanitizes the filters", async () => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await render({ organization_id: ORG_B_ID, org_id: ORG_B_ID, tenant: ORG_B_ID, status: "deleted", page: "banana", q: "x".repeat(300) });
    const url = new URL(productCalls()[0].url);
    expect([...url.searchParams.keys()].sort()).toEqual(["limit", "offset", "q", "status"]);
    expect(url.searchParams.get("status")).toBe("active");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("q")).toHaveLength(100);
    expect(productCalls()[0].url).not.toContain(ORG_B_ID);
    expect(productCalls()[0].url).not.toContain(ORG_ID);
  });

  it("shows an empty-state message, and a different one when filters match nothing", async () => {
    stubWorld({ ...normalWorld(), catalogs: { "token-alpha": [] } });
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render()).toContain("No products yet");
    expect(await render({ q: "zzz" })).toContain("No products match these filters");
  });

  it("explains an inactive organization (403) without showing any products", async () => {
    stubWorld({ ...normalWorld(), inventoryStatus: 403 });
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render();
    expect(html).toContain("currently inactive or unavailable");
    expect(html).not.toContain("Alpha steel bolt");
  });

  it("shows a temporary-unavailable notice when the Inventory Service is down", async () => {
    stubWorld({ ...normalWorld(), inventoryStatus: 503 });
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render()).toContain("temporarily unavailable");
  });

  it("sends the user to /login when the Inventory Service says the session is no longer valid (401)", async () => {
    stubWorld({ ...normalWorld(), inventoryStatus: 401 });
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await expect(ProductsPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
  });

  it("redirects without a session, and never calls the Inventory Service for a Super Admin or the wrong cookie", async () => {
    stubWorld(normalWorld());
    await expect(ProductsPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(ProductsPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    delete jar[TENANT_SESSION_COOKIE];
    jar["impex_session"] = "token-alpha";
    await expect(ProductsPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    expect(productCalls()).toHaveLength(0);
  });

  it("never renders the session token", async () => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render()).not.toContain("token-alpha");
  });
});


describe("Products layout (runs before the page streams)", () => {
  const renderLayout = async () => renderToStaticMarkup(await ProductsLayout({ children: "PAGE-CONTENT" }));

  it("redirects invalid sessions before anything is streamed", async () => {
    stubWorld(normalWorld());
    await expect(ProductsLayout({ children: null })).rejects.toThrow("REDIRECT:/login"); // no cookie
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(ProductsLayout({ children: null })).rejects.toThrow("REDIRECT:/login"); // a Super Admin
    jar[TENANT_SESSION_COOKIE] = "expired-or-unknown";
    await expect(ProductsLayout({ children: null })).rejects.toThrow("REDIRECT:/login");
    delete jar[TENANT_SESSION_COOKIE];
    jar["impex_session"] = "token-alpha"; // the Super Admin portal's cookie
    await expect(ProductsLayout({ children: null })).rejects.toThrow("REDIRECT:/login");
    expect(productCalls()).toHaveLength(0);
  });

  it("wraps the page in the header with navigation and sign-out for an organization administrator", async () => {
    stubWorld(normalWorld());
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await renderLayout();
    for (const expected of ["PAGE-CONTENT", "Alpha Trading GmbH", "Dashboard", "Products", "Sign out"]) {
      expect(html, expected).toContain(expected);
    }
  });
});
