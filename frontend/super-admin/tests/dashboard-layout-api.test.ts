import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUT as saveLayout } from "@/app/api/dashboard-layout/route";
import { ADMIN_WIDGET_IDS } from "@/lib/dashboard-widgets";
import { SESSION_COOKIE } from "@/lib/session";
import { superAdmin } from "./helpers";

// PUT /api/dashboard-layout (Super Admin Portal): the signed-in Super Admin's own arrangement. Only this portal's "admin." widget identifiers are
// accepted from the browser; the Auth Service (the record) validates them again for the Super Admin role.

const AUTH = "http://auth-service:8000";
const TOKEN = "super-admin-token";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[];
let me: () => Response;
let save: (call: Call) => Response;

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = AUTH;
  calls = [];
  me = () => json(200, superAdmin);
  save = (call) => json(200, { ...superAdmin, dashboard_layout: { version: 1, revision: 2, order: call.body.order, hidden: call.body.hidden } });
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (call.url === `${AUTH}/api/v1/auth/me`) return me();
    if (call.url === `${AUTH}/api/v1/auth/me/dashboard-layout`) return save(call);
    return json(404, {});
  }));
});
afterEach(() => vi.unstubAllGlobals());

const put = (body: unknown, cookie: string | null = `${SESSION_COOKIE}=${TOKEN}`, raw = false) =>
  saveLayout(new NextRequest("http://localhost:3000/api/dashboard-layout", { method: "PUT", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" }, body: raw ? (body as string) : JSON.stringify(body) }));
const writes = () => calls.filter((c) => c.url.endsWith("/me/dashboard-layout"));

describe("PUT /api/dashboard-layout (Super Admin Portal)", () => {
  it("saves the two lists against the Super Admin's own account and returns what was saved", async () => {
    const res = await put({ order: ["admin.panel.docker-compose", "admin.kpi.active-tenants"], hidden: ["admin.kpi.system-uptime"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ layout: { version: 1, revision: 2, order: ["admin.panel.docker-compose", "admin.kpi.active-tenants"], hidden: ["admin.kpi.system-uptime"] } });
    expect(writes()[0]).toMatchObject({ method: "PUT", body: { order: ["admin.panel.docker-compose", "admin.kpi.active-tenants"], hidden: ["admin.kpi.system-uptime"] } });
    expect(Object.keys(writes()[0].body)).toEqual(["order", "hidden"]);
    expect(writes()[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("accepts every Super Admin widget, in any order, and an empty dashboard", async () => {
    expect((await put({ order: [...ADMIN_WIDGET_IDS].reverse(), hidden: [] })).status).toBe(200);
    expect((await put({ order: [], hidden: [...ADMIN_WIDGET_IDS] })).status).toBe(200);
  });

  it("refuses the Organization Portal's widgets, unknown and repeated ones, wrong types and extra fields; nothing is saved", async () => {
    for (const body of [
      { order: ["org.overview"], hidden: [] }, { order: [], hidden: ["org.kpi.active-products"] }, { order: ["admin.nope"], hidden: [] },
      { order: ["admin.kpi.active-tenants", "admin.kpi.active-tenants"], hidden: [] }, { order: ["admin.kpi.active-tenants"], hidden: ["admin.kpi.active-tenants"] },
      { order: [1], hidden: [] }, { order: "admin.kpi.active-tenants", hidden: [] }, { order: [] }, [], null,
      { order: [], hidden: [], user_id: "someone-else" }, { order: [], hidden: [], css: "body{display:none}" },
    ]) expect((await put(body)).status, JSON.stringify(body)).toBe(400);
    expect((await put("{not json", undefined, true)).status).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  it("requires a Super Admin session: no cookie, an expired one, or an organization administrator's token", async () => {
    expect((await put({ order: [], hidden: [] }, null)).status).toBe(401);
    me = () => json(401, {});
    expect((await put({ order: [], hidden: [] })).status).toBe(401);
    me = () => json(200, { ...superAdmin, role: "organization-admin", organization_id: "o" });
    expect((await put({ order: [], hidden: [] })).status).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  it("translates the Auth Service's answers", async () => {
    save = () => json(422, {});
    expect((await put({ order: [], hidden: [] })).status).toBe(400);
    save = () => json(401, {});
    expect((await put({ order: [], hidden: [] })).status).toBe(401);
    save = () => json(500, {});
    expect((await put({ order: [], hidden: [] })).status).toBe(502);
    save = () => { throw new Error("down"); };
    expect((await put({ order: [], hidden: [] })).status).toBe(503);
  });
});
