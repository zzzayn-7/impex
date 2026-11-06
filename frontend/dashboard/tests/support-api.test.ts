import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gateApi, middleware, config } from "@/middleware";
import { describeSupportFailure } from "@/lib/support";
import { GET as listTickets, POST as createTicket } from "@/app/api/support/tickets/route";
import { POST as followUp } from "@/app/api/support/tickets/[id]/messages/route";

const ID = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718";
const OTHER_ORG = "b2e5c1d4-7a8f-4c3b-9d21-0f6e5a4b3c2d";
const TOKEN = "session-token-abc";
const SUPPORT = "http://support-service:8005";
const KEY = "ui-3f2b8c1e-0000-4000-8000-000000000001";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: { url: string; method: string; headers: Record<string, string>; body: any }[];
function stub(handler: (url: string, init: any) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    return handler(String(input), init);
  }));
}
const bodyOf = (i = 0) => JSON.parse(calls[i].body);

const request = (method: string, body?: unknown, { cookie = `impex_tenant_session=${TOKEN}`, query = "", key, headers = {} as Record<string, string> }: { cookie?: string | null; query?: string; key?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost:3001/api/support/tickets${query}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  process.env.SUPPORT_SERVICE_URL = SUPPORT;
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  stub(() => json(200, {}));
});
afterEach(() => vi.unstubAllGlobals());

describe("failure mapping", () => {
  it.each([
    [null, 503, "unavailable"], [{ status: 401, data: null }, 401, "unauthorized"], [{ status: 429, data: { detail: { code: "rate_limited", message: "Too fast." } } }, 429, "rate_limited"],
    [{ status: 409, data: { detail: { code: "ticket_closed", message: "This ticket is closed." } } }, 409, "ticket_closed"], [{ status: 404, data: { detail: "Ticket not found." } }, 404, undefined],
    [{ status: 500, data: { detail: "Traceback ..." } }, 502, "service_error"],
  ])("%j", (result, status, code) => {
    expect(describeSupportFailure(result as any)).toMatchObject({ status, ...(code ? { code } : {}) });
  });
  it("maps a validation answer to the form's field names and never leaks internals", () => {
    const f = describeSupportFailure({ status: 422, data: { detail: [{ loc: ["body", "subject"], msg: "Value error, The subject must be 3 to 150 characters." }, { loc: ["body", "weird_internal"], msg: "secret" }] } });
    expect(f).toMatchObject({ status: 400, fieldErrors: { subject: "The subject must be 3 to 150 characters." } });
    expect(JSON.stringify(f)).not.toContain("secret");
  });
});

describe("GET /api/support/tickets", () => {
  it("passes only whitelisted filters, with the caller's own token", async () => {
    stub(() => json(200, { items: [], total: 0, limit: 20, offset: 0, counts: {}, unread: 0 }));
    const res = await listTickets(request("GET", undefined, { query: `?status=open&category=change_request&unread=true&q=%20printer%20&limit=500&offset=10&organization_id=${OTHER_ORG}&priority=urgent` }));
    expect(res.status).toBe(200);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/support/tickets");
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: "open", category: "change_request", unread: "true", q: "printer", limit: "100", offset: "10" });
    expect(calls[0].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });
  it("drops unknown values and needs a session", async () => {
    await listTickets(request("GET", undefined, { query: "?status=bogus&category=sales&unread=maybe" }));
    expect([...new URL(calls[0].url).searchParams.keys()].sort()).toEqual(["limit", "offset"]);
    calls.length = 0;
    expect((await listTickets(request("GET", undefined, { cookie: null }))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
  it("answers a recoverable 503 when the Support Service is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const res = await listTickets(request("GET"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("Nothing was lost");
  });
});

const ticketBody = (extra: Record<string, unknown> = {}) => ({ subject: "Cannot print labels", category: "technical_issue", priority: "high", message: "The printer shows E-42.", ...extra });

describe("POST /api/support/tickets", () => {
  it("sends only the four fields and the idempotency key; nothing the server decides can be supplied", async () => {
    stub(() => json(201, { id: ID, ticket_number: "SUP-000001" }));
    const res = await createTicket(request("POST", ticketBody({
      subject: "  Cannot   print ", organization_id: OTHER_ORG, status: "resolved", ticket_number: "SUP-9", requester_email: "evil@x.y", recipient: "evil@x.y", sender_role: "super-admin", created_by_user_id: "x",
    }), { key: KEY }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ticket: { ticket_number: "SUP-000001" }, replayed: false });
    expect(calls[0].url).toBe(`${SUPPORT}/api/v1/support/tickets`);
    expect(calls[0].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "Idempotency-Key": KEY });
    expect(bodyOf()).toEqual({ subject: "Cannot   print", category: "technical_issue", priority: "high", message: "The printer shows E-42." });
  });
  it("defaults the priority to normal and reports a retry as a replay", async () => {
    stub(() => json(200, { id: ID }));
    const res = await createTicket(request("POST", ticketBody({ priority: undefined }), { key: KEY }));
    expect(res.status).toBe(200);
    expect((await res.json()).replayed).toBe(true);
    expect(bodyOf().priority).toBe("normal");
  });
  it.each([
    ["no key", ticketBody(), undefined], ["a bad key", ticketBody(), "short"], ["a short subject", ticketBody({ subject: "ab" }), KEY], ["a long subject", ticketBody({ subject: "x".repeat(151) }), KEY],
    ["no category", ticketBody({ category: undefined }), KEY], ["an unknown category", ticketBody({ category: "sales" }), KEY], ["an unknown priority", ticketBody({ priority: "critical" }), KEY],
    ["an empty message", ticketBody({ message: "   " }), KEY], ["a huge message", ticketBody({ message: "x".repeat(5001) }), KEY], ["a numeric subject", ticketBody({ subject: 12345 }), KEY],
  ])("refuses %s without calling the service", async (_name, body, key) => {
    const res = await createTicket(request("POST", body, { key }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it("needs a session and a JSON body", async () => {
    expect((await createTicket(request("POST", ticketBody(), { cookie: null, key: KEY }))).status).toBe(401);
    expect((await createTicket(request("POST", undefined, { key: KEY }))).status).toBe(415);
    expect(calls).toHaveLength(0);
  });
  it("passes the service's refusals through in plain words", async () => {
    stub(() => json(429, { detail: { code: "rate_limited", message: "You are sending tickets too quickly. Please wait a few minutes and try again." } }));
    const res = await createTicket(request("POST", ticketBody(), { key: KEY }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "rate_limited", error: expect.stringContaining("too quickly") });
    stub(() => json(403, { detail: "Your organization is not active." }));
    expect((await createTicket(request("POST", ticketBody(), { key: KEY }))).status).toBe(403);
  });
});

describe("POST /api/support/tickets/{id}/messages", () => {
  const params = (id = ID) => ({ params: { id } });
  it("sends only the text, with the key", async () => {
    stub(() => json(201, { id: ID }));
    const res = await followUp(request("POST", { body: "  Any news?  ", organization_id: OTHER_ORG, sender_role: "super-admin", status: "closed" }, { key: KEY }), params());
    expect(res.status).toBe(201);
    expect(calls[0].url).toBe(`${SUPPORT}/api/v1/support/tickets/${ID}/messages`);
    expect(bodyOf()).toEqual({ body: "Any news?" });
    expect(calls[0].headers).toMatchObject({ "Idempotency-Key": KEY });
  });
  it.each([["no key", { body: "hi" }, undefined, ID], ["a bad id", { body: "hi" }, KEY, "nope"], ["an empty message", { body: "  " }, KEY, ID], ["a huge message", { body: "x".repeat(5001) }, KEY, ID], ["a non-text body", { body: 5 }, KEY, ID]])("refuses %s without calling the service", async (_n, body, key, id) => {
    const res = await followUp(request("POST", body, { key }), params(id));
    expect([400, 404]).toContain(res.status);
    expect(calls).toHaveLength(0);
  });
  it("another organization's ticket is the service's plain 404; a closed ticket is explained", async () => {
    stub(() => json(404, { detail: "Ticket not found." }));
    expect((await followUp(request("POST", { body: "hi" }, { key: KEY }), params())).status).toBe(404);
    stub(() => json(409, { detail: { code: "ticket_closed", message: "This ticket is closed. Please open a new ticket for a new request." } }));
    const res = await followUp(request("POST", { body: "hi" }, { key: KEY }), params());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ticket_closed");
  });
  it("needs a session", async () => {
    expect((await followUp(request("POST", { body: "hi" }, { cookie: null, key: KEY }), params())).status).toBe(401);
  });
});

// =====================================================================================================
// first-time setup is mandatory before business activity - enforced on the server
// =====================================================================================================
describe("the business APIs wait for setup (middleware)", () => {
  const DONE = "2026-11-03T00:05:00+00:00";
  const world = (opts: { profile?: string | null; setup?: string; me?: number; org?: number; role?: string } = {}) =>
    stub((url) => {
      if (url.endsWith("/api/v1/auth/me")) {
        return opts.me ? json(opts.me, { detail: "x" }) : json(200, { role: opts.role ?? "organization-admin", is_active: true, profile_setup_completed_at: opts.profile === undefined ? DONE : opts.profile });
      }
      if (url.endsWith("/api/v1/tenant/organization")) return opts.org ? json(opts.org, { detail: "x" }) : json(200, { setup_status: opts.setup ?? "completed", modules: ["inventory", "purchasing", "sales"] });
      return json(404, {});
    });
  const api = (path: string, cookie: string | null = `impex_tenant_session=${TOKEN}`) => new NextRequest(`http://localhost:3001${path}`, { method: "POST", headers: cookie ? { cookie } : {} });
  const gated = ["/api/products", "/api/products/abc", "/api/warehouses", "/api/stock/in", "/api/scan/resolve", "/api/sales/invoices", "/api/sales/dispatches/x/confirm", "/api/purchasing/orders", "/api/purchasing/receipts/x"];

  it.each(gated)("%s answers 403 setup_required while the company is not set up", async (path) => {
    world({ setup: "pending" });
    const res = await middleware(api(path));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "setup_required" });
  });
  it.each(gated)("%s answers 403 while only the administrator's own profile is unconfirmed", async (path) => {
    world({ profile: null });
    expect((await middleware(api(path))).status).toBe(403);
  });
  it.each(["in_progress", "pending"])("a company that is '%s' is not set up", async (setup) => {
    world({ setup });
    expect((await middleware(api("/api/products"))).status).toBe(403);
  });
  it("lets everything through once the company and the administrator are set up", async () => {
    world();
    for (const path of gated) expect((await middleware(api(path))).headers.get("x-middleware-next"), path).toBe("1");
  });
  it("fails closed: if the setup state cannot be read it answers 503, never 'complete'", async () => {
    stub(() => { throw new Error("down"); });
    const res = await middleware(api("/api/products"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "setup_check_unavailable" });
    world({ org: 503 });
    expect((await middleware(api("/api/products"))).status).toBe(503);
    world({ me: 500 });
    expect((await middleware(api("/api/products"))).status).toBe(503);
    stub((url) => (url.endsWith("/auth/me") ? json(200, { role: "organization-admin", profile_setup_completed_at: DONE }) : (() => { throw new Error("org down"); })()));
    expect((await middleware(api("/api/products"))).status).toBe(503);
  });
  it("leaves authentication failures, other roles and inactive organizations to the routes and services that refuse them", async () => {
    world({ me: 401 });
    expect((await middleware(api("/api/products"))).headers.get("x-middleware-next")).toBe("1");
    world({ role: "super-admin" });
    expect((await middleware(api("/api/products"))).headers.get("x-middleware-next")).toBe("1");
    world({ org: 403 });
    expect((await middleware(api("/api/products"))).headers.get("x-middleware-next")).toBe("1");
    expect((await middleware(api("/api/products", null))).headers.get("x-middleware-next")).toBe("1");
    expect(calls.filter((c) => c.url.includes("/api/v1/tenant/organization"))).toHaveLength(1); // no cookie: nothing asked at all
  });
  it("sends only the caller's own token and names no organization", async () => {
    world();
    await middleware(api("/api/products"));
    expect(calls.map((c) => c.url)).toEqual(["http://auth-service:8000/api/v1/auth/me", "http://organization-service:8001/api/v1/tenant/organization"]);
    for (const call of calls) expect(call.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });
  it("never blocks authentication, setup, Help & Support, the logo or health checks", async () => {
    world({ setup: "pending", profile: null });
    for (const path of ["/api/auth/login", "/api/auth/logout", "/api/setup/logo", "/api/setup/complete", "/api/organization/logo", "/api/support/tickets", "/api/support/tickets/x/messages"]) {
      const res = await middleware(api(path));
      expect(res.headers.get("x-middleware-next"), path).toBe("1");
    }
    expect(calls).toHaveLength(0); // not even asked
  });
  it("the matcher covers exactly the gated APIs and the pages, and not the allowed routes", () => {
    const tests = (path: string) => config.matcher.some((m) => new RegExp("^" + m.replace(/:path\*/g, ".*") + "$").test(path));
    for (const path of gated) expect(tests(path), path).toBe(true);
    for (const path of ["/api/auth/login", "/api/setup/complete", "/api/support/tickets", "/api/organization/logo", "/login", "/_next/static/a.js"]) expect(tests(path), path).toBe(false);
    expect(tests("/products")).toBe(true);
    expect(tests("/support")).toBe(true);
  });
  it("is exposed for direct use", async () => {
    world({ setup: "pending" });
    expect((await gateApi(api("/api/stock/in"))).status).toBe(403);
  });
});
