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

import ClientsLayout from "@/app/clients/layout";
import ClientsPage from "@/app/clients/page";
import DeliveryListsLayout from "@/app/delivery-lists/layout";
import DeliveryListsPage from "@/app/delivery-lists/page";
import DeliveryListPage from "@/app/delivery-lists/[id]/page";
import ScanPage from "@/app/scan/page";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-05T10:00:00+00:00";
const ALPHA_LIST = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718";
const BETA_LIST = "9d4f3b3d-4e5f-4a6b-9bc3-d4e5f6071829";
const ALPHA_CLIENT = "a1111111-1111-4111-8111-111111111111";
const BETA_CLIENT = "b2222222-2222-4222-8222-222222222222";

const client = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, contact_person: `${name} contact`, email: null, phone: null, address: null, is_active: true, created_at: now, updated_at: now, ...extra,
});
const summary = (id: string, number: string, c: ReturnType<typeof client>, extra: Record<string, unknown> = {}) => ({
  id, number, client: { id: c.id, name: c.name, is_active: c.is_active }, external_reference: `${c.name}-PO`, status: "draft", notes: null, item_count: 1,
  created_by_email: "a@b.c", created_at: now, updated_at: now, ...extra,
});
const detail = (s: ReturnType<typeof summary>, productName: string, exceeds = false) => ({
  ...s,
  items: [{
    id: crypto.randomUUID(), product_id: crypto.randomUUID(), product_sku: "SKU-1", product_name: productName, quantity: "12.0000", unit: "pcs",
    created_at: now, updated_at: now,
    stock: { total_quantity: exceeds ? "5.0000" : "40.0000", product_active: true, unit_allows_fractions: false, exceeds_available: exceeds, shortfall: exceeds ? "7.0000" : "0" },
  }],
  stock_status: "ok", items_exceeding_stock: exceeds ? 1 : 0,
  stock_notice: "Stock is not reserved by a delivery list. Saving it, marking it Ready or cancelling it never changes inventory, and the quantities on hand may change before dispatch.",
});

const alphaClient = client(ALPHA_CLIENT, "Alpha Acme");
const betaClient = client(BETA_CLIENT, "Beta Globex");
const orgs: Record<string, { clients: any[]; lists: any[]; details: Record<string, any> }> = {
  "token-alpha": { clients: [alphaClient], lists: [summary(ALPHA_LIST, "DL-000001", alphaClient)], details: { [ALPHA_LIST]: detail(summary(ALPHA_LIST, "DL-000001", alphaClient), "Alpha steel bolt", true) } },
  "token-beta": { clients: [betaClient], lists: [summary(BETA_LIST, "DL-000001", betaClient)], details: { [BETA_LIST]: detail(summary(BETA_LIST, "DL-000001", betaClient), "Beta silk scarf") } },
};

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
      if (url.includes("/api/v1/inventory/")) return json(200, { items: [], total: 0, limit: 200, offset: 0 });
      if (!url.includes("/api/v1/sales/")) return json(404, {});
      if (options.status) return json(options.status, { detail: "x" });
      const org = orgs[token];
      if (!org) return json(401, {});
      const path = new URL(url).pathname.replace("/api/v1/sales", "");
      const params = new URL(url).searchParams;
      const page = (items: any[]) => json(200, { items, total: items.length, limit: Number(params.get("limit")), offset: Number(params.get("offset")) });
      if (path === "/clients") return page(org.clients);
      if (path === "/delivery-lists") return page(org.lists.filter((l) => !params.get("client_id") || l.client.id === params.get("client_id")));
      const match = path.match(/^\/delivery-lists\/([^/]+)$/);
      if (match) return org.details[match[1]] ? json(200, org.details[match[1]]) : json(404, { detail: "Delivery list not found." });
      return json(404, {});
    })
  );
}
const salesCalls = () => calls.filter((c) => c.url.includes("/api/v1/sales/"));

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.INVENTORY_SERVICE_URL = "http://inventory-service:8002";
  process.env.SALES_SERVICE_URL = "http://sales-service:8003";
  for (const key of Object.keys(jar)) delete jar[key];
});
afterEach(() => vi.unstubAllGlobals());

const render = async (element: Promise<any>) => renderToStaticMarkup(await element);

describe("Delivery Lists page", () => {
  it("lists the lists with number, client, reference, item count and status, plus the create and scan buttons", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(DeliveryListsPage({ searchParams: {} }));
    for (const expected of ["Delivery Lists", "DL-000001", "Alpha Acme", "Alpha Acme-PO", "Draft", "New Delivery List", "Scan products", "All clients", "All statuses", "Showing 1–1 of 1"]) {
      expect(html, expected).toContain(expected);
    }
  });

  it("passes only whitelisted filters (valid client id, known status, text, page) to the service", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await DeliveryListsPage({ searchParams: { q: "po", client: ALPHA_CLIENT, status: "ready", page: "2", organization_id: BETA_CLIENT, sort: "x" } });
    const call = salesCalls().find((c) => new URL(c.url).pathname === "/api/v1/sales/delivery-lists")!;
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({ q: "po", client_id: ALPHA_CLIENT, status: "ready", limit: "25", offset: "25" });
    calls = [];
    await DeliveryListsPage({ searchParams: { client: "' OR 1=1", status: "dispatched", page: "banana" } });
    const clean = salesCalls().find((c) => new URL(c.url).pathname === "/api/v1/sales/delivery-lists")!;
    expect([...new URL(clean.url).searchParams.keys()].sort()).toEqual(["limit", "offset"]);
  });

  it("two organizations: each administrator's page contains only their own lists and clients", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const alpha = await render(DeliveryListsPage({ searchParams: {} }));
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const beta = await render(DeliveryListsPage({ searchParams: {} }));
    expect(alpha).toContain("Alpha Acme");
    expect(beta).toContain("Beta Globex");
    for (const leak of ["Beta Globex", "Beta Globex-PO"]) expect(alpha, `alpha saw ${leak}`).not.toContain(leak);
    for (const leak of ["Alpha Acme", "Alpha Acme-PO"]) expect(beta, `beta saw ${leak}`).not.toContain(leak);
  });

  it("uses the session token, never names an organization, and only reads", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await DeliveryListsPage({ searchParams: { organization_id: BETA_CLIENT, org: BETA_CLIENT } });
    expect(salesCalls().length).toBeGreaterThan(0);
    for (const c of salesCalls()) {
      expect(c.headers.Authorization).toBe("Bearer token-alpha");
      expect(c.url).not.toMatch(/organization|tenant|org=/i);
      expect(c.method).toBe("GET");
    }
  });

  it("redirects without a session / for a Super Admin / the wrong cookie, calling no sales endpoint", async () => {
    stubWorld();
    await expect(DeliveryListsPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(DeliveryListsPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    delete jar[TENANT_SESSION_COOKIE];
    jar["impex_session"] = "token-alpha";
    await expect(DeliveryListsPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    expect(salesCalls()).toHaveLength(0);
  });

  it("explains an inactive organization, an outage, and an expired session", async () => {
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 403 });
    const inactive = await render(DeliveryListsPage({ searchParams: {} }));
    expect(inactive).toContain("currently inactive or unavailable");
    expect(inactive).not.toContain("Alpha Acme-PO");
    stubWorld({ status: 503 });
    expect(await render(DeliveryListsPage({ searchParams: {} }))).toContain("temporarily unavailable");
    stubWorld({ status: 401 });
    await expect(DeliveryListsPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
  });

  it("shows an empty-state message, and a different one when filters match nothing", async () => {
    stubWorld();
    orgs["token-alpha"].lists = [];
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    try {
      expect(await render(DeliveryListsPage({ searchParams: {} }))).toContain("No delivery lists yet");
      expect(await render(DeliveryListsPage({ searchParams: { q: "zzz" } }))).toContain("No delivery lists match these filters");
    } finally {
      orgs["token-alpha"].lists = [summary(ALPHA_LIST, "DL-000001", alphaClient)];
    }
  });
});

describe("Delivery list detail page", () => {
  const page = (id: string) => render(DeliveryListPage({ params: { id } }));

  it("shows the items, live availability, the warning and the 'stock is not reserved' notice", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(ALPHA_LIST);
    for (const expected of ["DL-000001", "Alpha Acme", "Alpha steel bolt", "SKU-1", "12", "pcs", "In stock now", "short by 7", "Mark Ready", "Cancel list", "Scan products for this list",
      "Stock is not reserved", "never changes inventory", "may change before dispatch", "asks for more than is available"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).toContain(`href="/scan?list=${ALPHA_LIST}"`);
  });

  it("two organizations: another organization's list id is simply 'not found'", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const ownAlpha = await page(ALPHA_LIST);
    const alphaTriesBeta = await page(BETA_LIST);
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const ownBeta = await page(BETA_LIST);
    const betaTriesAlpha = await page(ALPHA_LIST);
    expect(ownAlpha).toContain("Alpha steel bolt");
    expect(ownBeta).toContain("Beta silk scarf");
    expect(alphaTriesBeta).toContain("Delivery list not found.");
    expect(betaTriesAlpha).toContain("Delivery list not found.");
    for (const leak of ["Beta", "Globex", "scarf"]) expect(ownAlpha + alphaTriesBeta, `alpha saw ${leak}`).not.toContain(leak);
    for (const leak of ["Alpha", "Acme", "bolt"]) expect(ownBeta + betaTriesAlpha, `beta saw ${leak}`).not.toContain(leak);
  });

  it("does not call the service for something that is not an id", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await page("../../etc/passwd")).toContain("Delivery list not found.");
    expect(salesCalls()).toHaveLength(0);
  });

  it("redirects invalid sessions and explains outages", async () => {
    stubWorld();
    await expect(page(ALPHA_LIST)).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(page(ALPHA_LIST)).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 503 });
    expect(await page(ALPHA_LIST)).toContain("temporarily unavailable");
    stubWorld({ status: 403 });
    expect(await page(ALPHA_LIST)).toContain("currently inactive or unavailable");
  });

  it("a Ready list is read-only: no editing controls, but it can be reopened", async () => {
    const ready = { ...orgs["token-alpha"].details[ALPHA_LIST], status: "ready" };
    orgs["token-alpha"].details[ALPHA_LIST] = ready;
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    try {
      const html = await page(ALPHA_LIST);
      expect(html).toContain("Reopen as draft");
      expect(html).not.toContain("Mark Ready");
      expect(html).not.toContain("Add a product");
      expect(html).not.toMatch(/aria-label="Remove /);
    } finally {
      orgs["token-alpha"].details[ALPHA_LIST] = detail(summary(ALPHA_LIST, "DL-000001", alphaClient), "Alpha steel bolt", true);
    }
  });

  it("a cancelled list has no actions at all", async () => {
    orgs["token-alpha"].details[ALPHA_LIST] = { ...orgs["token-alpha"].details[ALPHA_LIST], status: "cancelled" };
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    try {
      const html = await page(ALPHA_LIST);
      expect(html).toContain("Cancelled");
      for (const absent of ["Mark Ready", "Reopen as draft", "Cancel list", "Add a product"]) expect(html, absent).not.toContain(absent);
    } finally {
      orgs["token-alpha"].details[ALPHA_LIST] = detail(summary(ALPHA_LIST, "DL-000001", alphaClient), "Alpha steel bolt", true);
    }
  });
});

describe("Clients page", () => {
  it("lists only the signed-in administrator's clients", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const alpha = await render(ClientsPage({ searchParams: {} }));
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const beta = await render(ClientsPage({ searchParams: {} }));
    for (const expected of ["Clients", "Add Client", "Alpha Acme", "Edit", "Deactivate", "Delivery lists"]) expect(alpha, expected).toContain(expected);
    expect(alpha).not.toContain("Beta Globex");
    expect(beta).toContain("Beta Globex");
    expect(beta).not.toContain("Alpha Acme");
  });

  it("redirects without a session", async () => {
    stubWorld();
    await expect(ClientsPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
  });
});

describe("navigation and layouts", () => {
  it.each([["Delivery Lists", DeliveryListsLayout], ["Clients", ClientsLayout]])("%s: redirects invalid sessions before streaming, marks itself current and links everywhere", async (label, layout) => {
    stubWorld();
    await expect((layout as any)({ children: null })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = renderToStaticMarkup(await (layout as any)({ children: "PAGE" }));
    expect((html.match(/<a[^>]*aria-current="page"[^>]*>(.*?)<\/a>/)?.[1] ?? "").replace(/<[^>]+>/g, "")).toBe(label);
    for (const href of ["/", "/products", "/stock", "/scan", "/movements", "/delivery-lists", "/clients"]) expect(html).toContain(`href="${href}"`);
  });
});

describe("Scan page and delivery lists", () => {
  it("pre-selects a list from ?list= only if it looks like an id", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const ok = await render(ScanPage({ searchParams: { list: ALPHA_LIST } }));
    const bad = await render(ScanPage({ searchParams: { list: "<script>" } }));
    expect(ok).toContain("Scan Product");
    expect(bad).not.toContain("<script>");
    expect(salesCalls()).toHaveLength(0); // the Sales Service is only asked later, from the browser
  });
});
