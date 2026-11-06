import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { middleware } from "@/middleware";
import { MODULE_KEYS, MODULE_PAGES, NAV_MODULE, canUse, moduleForApi, moduleRequestDraft, usableModules } from "@/lib/modules";

const TOKEN = "session-token-abc";
const DONE = "2026-11-03T00:05:00+00:00";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let calls: { url: string; headers: Record<string, string> }[] = [];
function world(opts: { modules?: unknown; setup?: string; profile?: string | null; org?: number } = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({ url, headers: init.headers ?? {} });
    if (url.endsWith("/api/v1/auth/me")) return json(200, { role: "organization-admin", is_active: true, profile_setup_completed_at: opts.profile === undefined ? DONE : opts.profile });
    if (url.endsWith("/api/v1/tenant/organization")) {
      if (opts.org) return json(opts.org, { detail: "x" });
      const body: Record<string, unknown> = { setup_status: opts.setup ?? "completed" };
      if ("modules" in opts) {
        if (opts.modules !== undefined) body.modules = opts.modules;
      } else body.modules = ["inventory", "purchasing", "sales"];
      return json(200, body);
    }
    return json(404, {});
  }));
}
afterEach(() => vi.unstubAllGlobals());

const api = (path: string, extra: Record<string, string> = {}) =>
  new NextRequest(`http://localhost:3001${path}`, { method: "POST", headers: { cookie: `impex_tenant_session=${TOKEN}`, ...extra } });
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

const INVENTORY = ["/api/products", "/api/products/abc/archive", "/api/warehouses", "/api/warehouses/x", "/api/stock/in", "/api/stock/transfer", "/api/scan/resolve"];
const PURCHASING = ["/api/purchasing/suppliers", "/api/purchasing/purchase-orders/x/lines", "/api/purchasing/goods-receipts/x/confirm"];
const SALES = ["/api/sales/clients", "/api/sales/delivery-lists/x/items", "/api/sales/dispatches/x/confirm", "/api/sales/invoices", "/api/sales/invoices/x/payments"];

describe("the module registry of the portal", () => {
  it("knows which routes and pages belong to which module", () => {
    for (const path of INVENTORY) expect(moduleForApi(path), path).toBe("inventory");
    for (const path of PURCHASING) expect(moduleForApi(path), path).toBe("purchasing");
    for (const path of SALES) expect(moduleForApi(path), path).toBe("sales");
    for (const path of ["/api/support/tickets", "/api/auth/login", "/api/auth/logout", "/api/setup/company", "/api/organization/logo", "/api/productsX", "/api/salesforce"]) expect(moduleForApi(path), path).toBeNull();
    expect(Object.keys(MODULE_PAGES)).toEqual(MODULE_KEYS);
    expect(MODULE_PAGES.inventory.map((p) => p.label)).toEqual(["Products", "Warehouses", "Stock", "Scan Product", "Movements"]);
    expect(MODULE_PAGES.purchasing.map((p) => p.label)).toEqual(["Suppliers", "Purchase Orders", "Goods Receipts"]);
    expect(MODULE_PAGES.sales.map((p) => p.label)).toEqual(["Clients", "Delivery Lists", "Dispatches", "Invoices"]);
  });

  it("Dashboard and Help & Support belong to no module", () => {
    expect(NAV_MODULE.dashboard).toBeUndefined();
    expect(NAV_MODULE.support).toBeUndefined();
  });

  it("a module is usable only when it and everything it requires are listed; anything odd means none", () => {
    expect(usableModules(["inventory", "purchasing", "sales"])).toEqual(["inventory", "purchasing", "sales"]);
    expect(usableModules(["sales"])).toEqual([]); // Sales needs Inventory
    expect(usableModules(["inventory", "sales"])).toEqual(["inventory", "sales"]);
    for (const odd of [undefined, null, "inventory", 5, {}, [1, 2], ["finance", "support", "banana"]]) expect(usableModules(odd), String(odd)).toEqual([]);
    expect(canUse(["inventory"], "sales")).toBe(false);
  });

  it("a module request is opened with fixed wording only", () => {
    expect(moduleRequestDraft("sales").subject).toBe("Request to activate the Sales module");
    expect(moduleRequestDraft(null).subject).toBe("Request to activate a module");
  });
});

describe("the business APIs wait for the module (middleware)", () => {
  it.each([...INVENTORY])("%s is refused 403 module_disabled when Inventory is off", async (path) => {
    world({ modules: [] });
    const res = await middleware(api(path));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "This part of Impex is not enabled for your organization.", code: "module_disabled", module: "inventory" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it.each([...PURCHASING])("%s is refused when Purchasing is off, and allowed when it is on", async (path) => {
    world({ modules: ["inventory", "sales"] });
    expect(await (await middleware(api(path))).json()).toMatchObject({ code: "module_disabled", module: "purchasing" });
    world({ modules: ["inventory", "purchasing"] });
    expect(passes(await middleware(api(path)))).toBe(true);
  });
  it.each([...SALES])("%s is refused when Sales is off, and allowed when it is on", async (path) => {
    world({ modules: ["inventory", "purchasing"] });
    expect(await (await middleware(api(path))).json()).toMatchObject({ code: "module_disabled", module: "sales" });
    world({ modules: ["inventory", "sales"] });
    expect(passes(await middleware(api(path)))).toBe(true);
  });

  it("Purchasing and Sales also need Inventory, even if the list says otherwise", async () => {
    world({ modules: ["purchasing", "sales"] });
    for (const path of [...INVENTORY, ...PURCHASING, ...SALES]) expect((await middleware(api(path))).status, path).toBe(403);
  });

  it("everything is allowed when everything is enabled", async () => {
    world();
    for (const path of [...INVENTORY, ...PURCHASING, ...SALES]) expect(passes(await middleware(api(path))), path).toBe(true);
  });

  it("fails closed: a missing or malformed module list is an outage (503), never 'all'", async () => {
    for (const modules of [undefined, "all", { inventory: true }, 7, null]) {
      world({ modules });
      const res = await middleware(api("/api/sales/clients"));
      expect(res.status, JSON.stringify(modules)).toBe(503);
      expect(await res.json()).toMatchObject({ code: "module_check_unavailable" });
    }
    world({ org: 503 });
    expect((await middleware(api("/api/sales/clients"))).status).toBe(503);
  });

  it("setup comes first: an organization that is not set up gets setup_required, whatever its modules", async () => {
    world({ modules: [], setup: "pending" });
    expect(await (await middleware(api("/api/products"))).json()).toMatchObject({ code: "setup_required" });
  });

  it("never reads a module from the request: headers, query strings and bodies change nothing", async () => {
    world({ modules: [] });
    const res = await middleware(api("/api/sales/clients?modules=sales&module=sales", { "x-modules": "inventory,sales", "x-module": "sales", "x-organization-id": "x", "x-enabled-modules": "sales" }));
    expect(res.status).toBe(403);
    expect(calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true); // only the session token is ever sent on
  });

  it("each request is judged anew by the services' current answer (nothing is remembered)", async () => {
    world({ modules: [] });
    expect((await middleware(api("/api/sales/clients"))).status).toBe(403);
    world({ modules: ["inventory", "sales"] });
    expect(passes(await middleware(api("/api/sales/clients")))).toBe(true);
    world({ modules: [] });
    expect((await middleware(api("/api/sales/clients"))).status).toBe(403);
  });

  it("Help & Support, sign-in, setup and the logo are never module-gated", async () => {
    world({ modules: [] });
    for (const path of ["/api/support/tickets", "/api/support/tickets/x/messages", "/api/auth/logout", "/api/setup/company", "/api/organization/logo"]) {
      const res = await middleware(api(path));
      expect(passes(res), path).toBe(true);
    }
    // ...and they do not even ask the services: they are not matched by the gate
    expect(calls.filter((c) => c.url.includes("/tenant/organization"))).toHaveLength(0);
  });

  it("an inactive organization and other roles are left to the services that refuse them", async () => {
    world({ org: 403 });
    expect(passes(await middleware(api("/api/sales/clients")))).toBe(true);
    world();
    expect(passes(await middleware(api("/api/sales/clients", {})))).toBe(true);
  });
});
