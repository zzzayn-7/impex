import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import { GET as history } from "@/app/api/organizations/[id]/modules/history/route";
import { POST as preview } from "@/app/api/organizations/[id]/modules/preview/route";
import { PUT as apply } from "@/app/api/organizations/[id]/modules/route";
import { cleanChanges, describeModulesFailure } from "@/lib/modules";

const ORG = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
function stub(answer: (call: Call) => Response | null) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const response = answer(call);
    if (response === null) throw new Error("connection refused");
    return response;
  }));
}
const req = (method: string, url: string, body?: unknown) =>
  new NextRequest(`http://localhost:3000${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id = ORG) => ({ params: { id } });

beforeEach(() => {
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  for (const key of Object.keys(jar)) delete jar[key];
  jar.impex_session = "token-super";
});
afterEach(() => vi.unstubAllGlobals());

describe("PUT /api/organizations/{id}/modules (apply a reviewed change)", () => {
  const put = (body: unknown, id = ORG) => apply(req("PUT", `/api/organizations/${id}/modules`, body), ctx(id));

  it("forwards only the changes, the reviewed revision and a reason, with the session token", async () => {
    stub(() => json(200, { revision: 9 }));
    const res = await put({ changes: { sales: true, purchasing: false }, expected_revision: 8, reason: "  Approved in SUP-000123  ", organization_id: "other", updated_by: "me", changed_by: "x", admin: { id: "x" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: { revision: 9 } });
    expect(calls[0].url).toBe(`http://organization-service:8001/api/v1/organizations/${ORG}/modules`);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].headers.Authorization).toBe("Bearer token-super");
    expect(calls[0].body).toEqual({ changes: { sales: true, purchasing: false }, expected_revision: 8, reason: "Approved in SUP-000123" });
  });

  it("refuses bad input before calling the service", async () => {
    stub(() => json(200, {}));
    delete jar.impex_session;
    expect((await put({ changes: { sales: true }, expected_revision: 0 })).status).toBe(401);
    jar.impex_session = "token-super";
    for (const body of [{}, { changes: {}, expected_revision: 0 }, { changes: { sales: "yes" }, expected_revision: 0 }, { changes: { support: false }, expected_revision: 0 }, { changes: { banana: true }, expected_revision: 0 },
                        { changes: { sales: true } }, { changes: { sales: true }, expected_revision: -1 }, { changes: { sales: true }, expected_revision: 1.5 }, { changes: [true], expected_revision: 0 }]) {
      expect((await put(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await put({ changes: { sales: true }, expected_revision: 0 }, "not-a-uuid")).status).toBe(404);
    expect((await apply(new NextRequest(`http://localhost:3000/x`, { method: "PUT", body: "x" }), ctx())).status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it("explains refusals: blocked (with the reasons), stale review, not a Super Admin, unknown organization, outage", async () => {
    const blockers = [{ code: "pending_operations", module: "sales", message: "Sales has operations in progress that must finish first.", counts: [{ code: "dispatches_posting", label: "Dispatches being posted to stock", count: 2 }] }];
    stub(() => json(409, { detail: { code: "blocked", message: "This change cannot be applied.", blockers } }));
    let res = await put({ changes: { sales: false }, expected_revision: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This change cannot be applied.", code: "blocked", blockers });
    stub(() => json(409, { detail: { code: "stale_revision", message: "The module settings changed since you reviewed them. Review the current state and confirm again." } }));
    res = await put({ changes: { sales: true }, expected_revision: 1 });
    expect((await res.json()).code).toBe("stale_revision");
    stub(() => json(403, { detail: "Super Admin permission required" }));
    expect((await put({ changes: { sales: true }, expected_revision: 1 })).status).toBe(403);
    stub(() => json(404, { detail: "Organization 'x' not found." }));
    expect((await put({ changes: { sales: true }, expected_revision: 1 })).status).toBe(404);
    stub(() => null);
    res = await put({ changes: { sales: true }, expected_revision: 1 });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("Nothing was changed");
    stub(() => json(500, { detail: "boom: password=hunter2" }));
    expect(JSON.stringify(await (await put({ changes: { sales: true }, expected_revision: 1 })).json())).not.toContain("hunter2");
  });
});

describe("POST /api/organizations/{id}/modules/preview", () => {
  const post = (body: unknown, id = ORG) => preview(req("POST", `/api/organizations/${id}/modules/preview`, body), ctx(id));

  it("forwards only the changes and returns the review", async () => {
    stub(() => json(200, { revision: 3, changes: [], blockers: [], warnings: [], can_apply: false }));
    const res = await post({ changes: { sales: true }, expected_revision: 99, organization_id: "x" });
    expect(res.status).toBe(200);
    expect((await res.json()).preview.revision).toBe(3);
    expect(calls[0].body).toEqual({ changes: { sales: true } });
    expect(calls[0].url.endsWith(`/api/v1/organizations/${ORG}/modules/preview`)).toBe(true);
  });

  it("needs a session, a real organization id and a valid change", async () => {
    stub(() => json(200, {}));
    expect((await post({ changes: {} })).status).toBe(400);
    expect((await post({ changes: { finance: "on" } })).status).toBe(400);
    expect((await post({ changes: { sales: true } }, "../etc")).status).toBe(404);
    delete jar.impex_session;
    expect((await post({ changes: { sales: true } })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("GET /api/organizations/{id}/modules/history", () => {
  const get = (query = "", id = ORG) => history(req("GET", `/api/organizations/${id}/modules/history${query}`), ctx(id));

  it("asks for a bounded page", async () => {
    stub(() => json(200, { items: [], total: 0 }));
    await get("?limit=9999&offset=-5");
    expect(calls[0].url).toBe(`http://organization-service:8001/api/v1/organizations/${ORG}/modules/history?limit=200&offset=0`);
    await get("?limit=abc");
    expect(calls[1].url).toContain("limit=50&offset=0");
  });

  it("needs a Super Admin session", async () => {
    stub(() => json(403, { detail: "Super Admin permission required" }));
    expect((await get()).status).toBe(403);
    delete jar.impex_session;
    expect((await get()).status).toBe(401);
    expect((await get("", "nope")).status).toBe(401); // (the session is checked first)
  });
});

describe("the helpers", () => {
  it("cleanChanges keeps only known modules with true/false", () => {
    expect(cleanChanges({ sales: true, finance: false })).toEqual({ sales: true, finance: false });
    for (const bad of [null, undefined, [], {}, { support: true }, { sales: 1 }, { sales: "true" }, "sales"]) expect(cleanChanges(bad), String(bad)).toBeNull();
  });
  it("describeModulesFailure never repeats raw server text for unexpected errors", () => {
    expect(describeModulesFailure({ status: 500, data: { detail: "Traceback ..." } }).message).toBe("That could not be completed. Nothing was changed. Please try again.");
    expect(describeModulesFailure(null).status).toBe(503);
  });
});
