import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUT as saveLayout } from "@/app/api/dashboard-layout/route";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

// PUT /api/dashboard-layout: the signed-in administrator's own arrangement. Only widget identifiers are read from the browser; they must be widgets this
// administrator may use NOW (the organization's modules decide that, on the server); what was saved for other widgets is carried along; the Auth Service
// is the record.

const AUTH = "http://auth-service:8000";
const ORG = "http://org-service:8001";
const TOKEN = "tenant-token-abc";
const USER = { id: "11111111-1111-4111-8111-111111111111", email: "olivia@acme.example", full_name: "Olivia Owner", role: "organization-admin", organization_id: "22222222-2222-4222-8222-222222222222", is_active: true, created_at: "x" };
const organization = (modules: string[]) => ({ id: USER.organization_id, name: "Acme", slug: "acme", modules });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[];
let me: () => Response;
let org: () => Response;
let save: (call: Call) => Response;

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = AUTH;
  process.env.ORG_SERVICE_URL = ORG;
  calls = [];
  me = () => json(200, USER);
  org = () => json(200, organization(["inventory", "sales"]));
  save = (call) => json(200, { ...USER, dashboard_layout: { version: 1, revision: 5, order: call.body.order, hidden: call.body.hidden } });
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (call.url === `${AUTH}/api/v1/auth/me`) return me();
    if (call.url.startsWith(`${ORG}/api/v1/tenant/organization`)) return org();
    if (call.url === `${AUTH}/api/v1/auth/me/dashboard-layout`) return save(call);
    return json(404, {});
  }));
});
afterEach(() => vi.unstubAllGlobals());

const put = (body: unknown, cookie: string | null = `${TENANT_SESSION_COOKIE}=${TOKEN}`, raw = false) =>
  saveLayout(new NextRequest("http://localhost:3001/api/dashboard-layout", { method: "PUT", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" }, body: raw ? (body as string) : JSON.stringify(body) }));
const writes = () => calls.filter((c) => c.url.endsWith("/me/dashboard-layout"));

describe("PUT /api/dashboard-layout", () => {
  it("saves the two lists against the session's own user in the Auth Service and returns what was saved", async () => {
    const res = await put({ order: ["org.kpi.active-products", "org.overview"], hidden: ["org.panel.organization"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ layout: { version: 1, revision: 5, order: ["org.kpi.active-products", "org.overview"], hidden: ["org.panel.organization"] } });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ method: "PUT", body: { order: ["org.kpi.active-products", "org.overview"], hidden: ["org.panel.organization"] } });
    expect(writes()[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("forwards ONLY the two lists: no user id, role, organization, HTML or CSS the browser might add", async () => {
    const res = await put({ order: ["org.overview"], hidden: [], user_id: "someone-else", role: "super-admin", css: "body{display:none}" });
    expect(res.status).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  it("refuses a widget whose module is switched off (Purchasing and Finance here) and saves nothing", async () => {
    for (const id of ["org.kpi.open-purchase-orders", "org.list.open-purchase-orders", "org.finance.snapshot"]) {
      expect((await put({ order: ["org.overview", id], hidden: [] })).status, id).toBe(400);
      expect((await put({ order: ["org.overview"], hidden: [id] })).status, id).toBe(400);
    }
    expect(writes()).toHaveLength(0);
    expect((await put({ order: ["org.kpi.invoiced-this-month"], hidden: [] })).status).toBe(200); // Sales is on
  });

  it("refuses unknown, repeated, wrongly typed and Super Admin widgets", async () => {
    for (const body of [
      { order: ["org.nope"], hidden: [] }, { order: ["org.overview", "org.overview"], hidden: [] }, { order: ["org.overview"], hidden: ["org.overview"] },
      { order: ["admin.kpi.active-tenants"], hidden: [] }, { order: [1], hidden: [] }, { order: "org.overview", hidden: [] }, { order: [] }, [], null,
    ]) expect((await put(body)).status, JSON.stringify(body)).toBe(400);
    expect((await put("{not json", undefined, true)).status).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  it("carries along what was saved for widgets the administrator cannot use right now, so a module switched off and on loses nothing", async () => {
    me = () => json(200, { ...USER, dashboard_layout: { version: 1, revision: 4, order: ["org.finance.snapshot", "org.overview"], hidden: ["org.list.open-purchase-orders"] } });
    await put({ order: ["org.overview", "org.panel.modules"], hidden: ["org.kpi.invoiced-this-month"] });
    expect(writes()[0].body).toEqual({ order: ["org.overview", "org.panel.modules", "org.finance.snapshot"], hidden: ["org.kpi.invoiced-this-month", "org.list.open-purchase-orders"] });
  });

  it("with the organization unreadable it does not guess which widgets are allowed: nothing is saved", async () => {
    org = () => json(503, {});
    expect((await put({ order: ["org.overview"], hidden: [] })).status).toBe(503);
    expect(writes()).toHaveLength(0);
  });

  it("an inactive organization can still arrange the one widget that needs nothing", async () => {
    org = () => json(403, {});
    expect((await put({ order: ["org.overview"], hidden: [] })).status).toBe(200);
    expect((await put({ order: ["org.overview", "org.panel.modules"], hidden: [] })).status).toBe(400);
  });

  it("requires a session, and only an organization administrator may save (a Super Admin's token is refused)", async () => {
    expect((await put({ order: [], hidden: [] }, null)).status).toBe(401);
    me = () => json(401, {});
    expect((await put({ order: [], hidden: [] })).status).toBe(401);
    me = () => json(200, { ...USER, role: "super-admin", organization_id: null });
    expect((await put({ order: [], hidden: [] })).status).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  it("translates the Auth Service's answers", async () => {
    save = () => json(422, {});
    expect((await put({ order: ["org.overview"], hidden: [] })).status).toBe(400);
    save = () => json(401, {});
    expect((await put({ order: ["org.overview"], hidden: [] })).status).toBe(401);
    save = () => json(500, {});
    expect((await put({ order: ["org.overview"], hidden: [] })).status).toBe(502);
    save = () => { throw new Error("down"); };
    expect((await put({ order: ["org.overview"], hidden: [] })).status).toBe(503);
  });
});
