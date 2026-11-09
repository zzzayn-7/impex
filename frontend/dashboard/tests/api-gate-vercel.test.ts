import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as gateRoute } from "@/app/api/gate/route";
import { middleware } from "@/middleware";

// On Vercel the Auth and Organization services are reached through service bindings, which resolve only in functions and never in middleware. So there the
// middleware asks the /api/gate route handler (same deployment) instead of calling the services itself. These tests pin that the two paths give the SAME answers
// and that the Vercel path fails closed.

const TOKEN = "session-token-abc";
const DONE = "2026-11-03T00:05:00+00:00";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type World = { modules?: unknown; setup?: string; profile?: string | null; org?: number; role?: string; me?: number };
let serviceCalls: string[];
let gateCalls: { url: string; init: any }[];

/** What the Auth and Organization services answer. `viaRoute` also wires /api/gate to the REAL route handler, as the deployment would. */
function world(opts: World = {}, viaRoute = false) {
  serviceCalls = [];
  gateCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.endsWith("/api/gate")) {
      gateCalls.push({ url, init });
      return viaRoute ? gateRoute(new NextRequest(url, { method: init.method, headers: init.headers, body: init.body })) : json(500, {});
    }
    serviceCalls.push(url);
    if (url.endsWith("/api/v1/auth/me")) {
      if (opts.me) return json(opts.me, {});
      return json(200, { role: opts.role ?? "organization-admin", is_active: true, profile_setup_completed_at: opts.profile === undefined ? DONE : opts.profile });
    }
    if (url.endsWith("/api/v1/tenant/organization")) {
      if (opts.org) return json(opts.org, { detail: "x" });
      const body: Record<string, unknown> = { setup_status: opts.setup ?? "completed" };
      if ("modules" in opts) { if (opts.modules !== undefined) body.modules = opts.modules; } else body.modules = ["inventory", "purchasing", "sales"];
      return json(200, body);
    }
    return json(404, {});
  }));
}

const api = (path: string, cookie: string | null = `impex_tenant_session=${TOKEN}`) =>
  new NextRequest(`https://impex.example.com${path}`, { method: "POST", headers: cookie ? { cookie } : {} });
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";
const verdict = async (res: Response) => (passes(res) ? "pass" : { status: res.status, body: await res.json() });

beforeEach(() => { vi.stubEnv("VERCEL", "1"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("on Vercel the middleware asks the /api/gate route, not the services", () => {
  it("makes ONE request to /api/gate on the deployment's own origin, carrying the session cookie and the path, and none to the services", async () => {
    world({}, true);
    const res = await middleware(api("/api/sales/clients"));
    expect(passes(res)).toBe(true);
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0].url).toBe("https://impex.example.com/api/gate");
    expect(gateCalls[0].init.method).toBe("POST");
    expect(gateCalls[0].init.headers.cookie).toBe(`impex_tenant_session=${TOKEN}`);
    expect(JSON.parse(gateCalls[0].init.body)).toEqual({ path: "/api/sales/clients" });
    // the two service calls were made by the ROUTE (a function, where bindings resolve), and only the caller's token is forwarded to them
    expect(serviceCalls.map((u) => new URL(u).pathname)).toEqual(["/api/v1/auth/me", "/api/v1/tenant/organization"]);
  });

  it("relays the route's refusals unchanged: module disabled, setup required, outage", async () => {
    world({ modules: ["inventory", "purchasing"] }, true);
    const refused = await middleware(api("/api/sales/clients"));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.json()).toEqual({ error: "This part of Impex is not enabled for your organization.", code: "module_disabled", module: "sales" });
    world({ setup: "pending" }, true);
    expect(await (await middleware(api("/api/stock/in"))).json()).toMatchObject({ code: "setup_required" });
    world({ org: 500 }, true);
    const outage = await middleware(api("/api/finance/accounts"));
    expect(outage.status).toBe(503);
    expect(await outage.json()).toMatchObject({ code: "setup_check_unavailable" });
  });

  it("FAILS CLOSED when the route cannot be reached, errors, or answers something that is not a decision", async () => {
    for (const broken of [
      async () => { throw new Error("network down"); },
      async () => json(500, {}),
      async () => json(200, { unexpected: true }),
      async () => new Response("not json", { status: 200 }),
    ]) {
      vi.stubGlobal("fetch", vi.fn(broken));
      const res = await middleware(api("/api/sales/clients"));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "setup_check_unavailable" });
    }
  });

  it("a request without a session cookie never calls the route (the business route answers 401 itself); pages and other APIs are not gated", async () => {
    world({}, true);
    expect(passes(await middleware(api("/api/sales/clients", null)))).toBe(true);
    expect(gateCalls).toHaveLength(0);
    expect(passes(await middleware(api("/api/support/tickets")))).toBe(true); // not a business route
    expect(gateCalls).toHaveLength(0);
    const page = await middleware(new NextRequest("https://impex.example.com/stock", { headers: {} }));
    expect(page.status).toBe(307); // a page without a session still goes to /login
    expect(gateCalls).toHaveLength(0);
  });

  it("IMPEX_GATE_VIA_ROUTE=1 selects the same path outside Vercel; without either variable the middleware decides by itself (local development, Docker)", async () => {
    vi.unstubAllEnvs();
    world({ modules: ["inventory"] });
    expect(await verdict(await middleware(api("/api/sales/clients")))).toMatchObject({ status: 403 });
    expect(gateCalls).toHaveLength(0); // decided in the middleware: the services were asked directly
    expect(serviceCalls).toHaveLength(2);
    vi.stubEnv("IMPEX_GATE_VIA_ROUTE", "1");
    world({ modules: ["inventory"] }, true);
    await middleware(api("/api/sales/clients"));
    expect(gateCalls).toHaveLength(1);
  });
});

describe("the two paths give the same answer", () => {
  const worlds: [string, World][] = [
    ["everything on", {}],
    ["Purchasing and Sales off", { modules: ["inventory"] }],
    ["Inventory off", { modules: [] }],
    ["Finance only", { modules: ["finance"] }],
    ["modules list missing", { modules: undefined }],
    ["modules list malformed", { modules: "inventory" }],
    ["setup pending", { setup: "pending" }],
    ["profile setup missing", { profile: null }],
    ["organization service down", { org: 503 }],
    ["organization inactive", { org: 403 }],
    ["session expired", { me: 401 }],
    ["auth service down", { me: 500 }],
    ["a Super Admin token", { role: "super-admin" }],
  ];
  const paths = ["/api/products", "/api/stock/in", "/api/scan/resolve", "/api/purchasing/suppliers", "/api/sales/invoices/x/payments", "/api/finance/accounts"];

  it.each(worlds)("%s", async (_name, w) => {
    for (const path of paths) {
      vi.stubEnv("VERCEL", "");
      world(w);
      const direct = await verdict(await middleware(api(path)));
      vi.stubEnv("VERCEL", "1");
      world(w, true);
      const viaRoute = await verdict(await middleware(api(path)));
      expect(viaRoute, `${path} in "${_name}"`).toEqual(direct);
    }
  });
});

describe("POST /api/gate", () => {
  const post = (body: unknown, cookie: string | null = `impex_tenant_session=${TOKEN}`) =>
    gateRoute(new NextRequest("https://impex.example.com/api/gate", { method: "POST", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));

  it("decides only for the caller's own session: no cookie means nothing to decide and no service is called", async () => {
    world({});
    const res = await post({ path: "/api/sales/clients" }, null);
    expect(await res.json()).toEqual({ refusal: null });
    expect(serviceCalls).toEqual([]);
  });

  it("refuses to guess: a missing, non-API or oversized path is a 400, never an implicit allow", async () => {
    world({});
    for (const body of [{}, { path: 5 }, { path: "/stock" }, { path: "/api/" + "x".repeat(300) }, "not json"]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(serviceCalls).toEqual([]);
  });

  it("answers with the refusal (or null) and never caches", async () => {
    world({ modules: ["inventory"] });
    const res = await post({ path: "/api/purchasing/suppliers" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ refusal: { status: 403, body: { error: "This part of Impex is not enabled for your organization.", code: "module_disabled", module: "purchasing" } } });
    world({});
    expect(await (await post({ path: "/api/purchasing/suppliers" })).json()).toEqual({ refusal: null });
  });
});
