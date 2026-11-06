import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { orgAdmin, superAdmin } from "./helpers";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import { POST as reply } from "@/app/api/support/tickets/[id]/messages/route";
import { PATCH as update } from "@/app/api/support/tickets/[id]/route";
import { POST as retry } from "@/app/api/support/notifications/[id]/retry/route";
import { describeSupportFailure, listInbox } from "@/lib/support";
import { parseFilters } from "@/lib/support-filters";
import { TRANSITIONS, STATUSES } from "@/lib/support-labels";

const T1 = "a1111111-1111-4111-8111-aaaaaaaaaaaa";
const OUTBOX = "c3333333-3333-4333-8333-cccccccccccc";
const KEY = "ui-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
function stubSupport(answer: (call: Call) => Response | null | Promise<Response | null>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const response = await answer(call);
    if (response === null) throw new Error("connection refused");
    return response;
  }));
}

const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost:3000${url}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: { id } });

beforeEach(() => {
  process.env.SUPPORT_SERVICE_URL = "http://support-service:8005";
  for (const key of Object.keys(jar)) delete jar[key];
  jar.impex_session = "token-super";
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /api/support/tickets/{id}/messages (Super Admin reply)", () => {
  const post = (body: unknown, key: string | null = KEY, id = T1) => reply(req("POST", `/api/support/tickets/${id}/messages`, body, key ? { "Idempotency-Key": key } : {}), ctx(id));

  it("forwards the text and the chosen status with the Idempotency-Key and the session token, and nothing else", async () => {
    stubSupport(() => json(201, { id: T1, status: "waiting_for_customer" }));
    const res = await post({ body: "  Please restart the spooler.  ", status: "in_progress", to: "attacker@evil.example", recipient: "x@y.z", organization_id: "other", sender_role: "organization-admin" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ticket: { id: T1, status: "waiting_for_customer" }, replayed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://support-service:8005/api/v1/support/admin/tickets/${T1}/messages`);
    expect(calls[0].headers.Authorization).toBe("Bearer token-super");
    expect(calls[0].headers["Idempotency-Key"]).toBe(KEY);
    expect(calls[0].body).toEqual({ body: "Please restart the spooler.", status: "in_progress" });
  });

  it("answers 200 and replayed:true for a repeated key", async () => {
    stubSupport(() => json(200, { id: T1 }));
    const res = await post({ body: "Again" });
    expect(res.status).toBe(200);
    expect((await res.json()).replayed).toBe(true);
  });

  it("refuses without a session, a key, text or a known status, before calling the service", async () => {
    stubSupport(() => json(201, {}));
    delete jar.impex_session;
    expect((await post({ body: "x" })).status).toBe(401);
    jar.impex_session = "token-super";
    expect((await post({ body: "x" }, null)).status).toBe(400);
    expect((await post({ body: "x" }, "short")).status).toBe(400);
    expect((await post({ body: "   " })).status).toBe(400);
    expect((await post({ body: "a".repeat(5001) })).status).toBe(400);
    expect((await post({ body: "x", status: "deleted" })).status).toBe(400);
    expect((await post({ body: "x", status: 5 })).status).toBe(400);
    expect((await post({ body: "x" }, KEY, "not-a-uuid")).status).toBe(404);
    expect((await reply(new NextRequest(`http://localhost:3000/api/support/tickets/${T1}/messages`, { method: "POST", headers: { "Idempotency-Key": KEY }, body: "x" }), ctx(T1))).status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it("explains refusals in plain words: closed ticket, bad transition, not a Super Admin, unknown ticket, outage", async () => {
    stubSupport(() => json(409, { detail: { code: "ticket_closed", message: "This ticket is closed. Reopen it before replying." } }));
    let res = await post({ body: "x" });
    expect(res.status).toBe(409);
    expect((await res.json())).toEqual({ error: "This ticket is closed. Reopen it before replying.", code: "ticket_closed" });
    stubSupport(() => json(403, { detail: "Super Admin access required." }));
    res = await post({ body: "x" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Only a Super Admin can use the Support Inbox.");
    stubSupport(() => json(404, { detail: "Ticket not found." }));
    expect((await post({ body: "x" })).status).toBe(404);
    stubSupport(() => json(401, {}));
    expect((await post({ body: "x" })).status).toBe(401);
    stubSupport(() => null);
    res = await post({ body: "x" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("Nothing was lost");
    stubSupport(() => json(500, { detail: "boom: password=hunter2 at /app/secret.py" }));
    res = await post({ body: "x" });
    expect(JSON.stringify(await res.json())).not.toContain("hunter2");
  });
});

describe("PATCH /api/support/tickets/{id} (status and priority)", () => {
  const patch = (body: unknown, id = T1) => update(req("PATCH", `/api/support/tickets/${id}`, body), ctx(id));

  it("forwards only status and priority", async () => {
    stubSupport(() => json(200, { id: T1, status: "resolved", priority: "high" }));
    const res = await patch({ status: "resolved", priority: "high", subject: "hijack", organization_id: "x", messages: [] });
    expect(res.status).toBe(200);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe(`http://support-service:8005/api/v1/support/admin/tickets/${T1}`);
    expect(calls[0].body).toEqual({ status: "resolved", priority: "high" });
    expect((await res.json()).ticket.status).toBe("resolved");
  });

  it("refuses nothing-to-change, unknown values, a missing session and a malformed id", async () => {
    stubSupport(() => json(200, {}));
    expect((await patch({})).status).toBe(400);
    expect((await patch({ subject: "x" })).status).toBe(400);
    expect((await patch({ status: "banana" })).status).toBe(400);
    expect((await patch({ priority: "critical" })).status).toBe(400);
    expect((await patch({ status: "open" }, "nope")).status).toBe(404);
    delete jar.impex_session;
    expect((await patch({ status: "open" })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("passes a refused transition through as a 409 with the service's explanation", async () => {
    stubSupport(() => json(409, { detail: { code: "invalid_transition", message: "A ticket cannot go from Closed to Resolved." } }));
    const res = await patch({ status: "resolved" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("A ticket cannot go from Closed to Resolved.");
  });
});

describe("POST /api/support/notifications/{id}/retry", () => {
  it("asks the service for another attempt, naming no recipient", async () => {
    stubSupport(() => json(200, { id: OUTBOX, delivery_status: "pending" }));
    const res = await retry(req("POST", `/api/support/notifications/${OUTBOX}/retry`, { recipient: "x@y.z" }), ctx(OUTBOX));
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe(`http://support-service:8005/api/v1/support/admin/notifications/${OUTBOX}/retry`);
    expect(calls[0].body).toBeUndefined();
    expect((await res.json()).notification.delivery_status).toBe("pending");
  });

  it("needs a session and a real id", async () => {
    stubSupport(() => json(200, {}));
    expect((await retry(req("POST", "/x"), ctx("nope"))).status).toBe(404);
    delete jar.impex_session;
    expect((await retry(req("POST", "/x"), ctx(OUTBOX))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("the inbox request", () => {
  const filters = { q: "", status: "" as const, category: "" as const, priority: "" as const, unread: false, page: 1 };

  it("asks for the admin inbox with only the chosen filters and the right page", async () => {
    stubSupport(() => json(200, { items: [], total: 0, limit: 25, offset: 50, counts: {}, unread: 0 }));
    await listInbox("token-super", { ...filters, q: "printer", status: "open", category: "change_request", priority: "urgent", unread: true, page: 3 });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/support/admin/tickets");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "printer", status: "open", category: "change_request", priority: "urgent", unread: "true", limit: "25", offset: "50" });
    expect(calls[0].headers.Authorization).toBe("Bearer token-super");
  });

  it("maps failures to reasons the page can explain", async () => {
    for (const [status, reason] of [[401, "unauthorized"], [403, "forbidden"], [500, "unavailable"], [404, "unavailable"]] as const) {
      stubSupport(() => json(status, {}));
      expect(await listInbox("t", filters)).toEqual({ ok: false, reason });
    }
    stubSupport(() => null);
    expect(await listInbox("t", filters)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("parseFilters keeps only known names and values", () => {
    expect(parseFilters({ q: "  hi  ", status: "open", category: "technical_issue", priority: "high", unread: "true", page: "4", organization_id: "x", limit: "9999" })).toEqual({ q: "hi", status: "open", category: "technical_issue", priority: "high", unread: true, page: 4 });
    expect(parseFilters({ status: "x", category: "' OR 1=1", priority: "z", unread: "yes", page: "-3", q: "a".repeat(300) })).toEqual({ q: "a".repeat(100), status: "", category: "", priority: "", unread: false, page: 1 });
    expect(parseFilters({ page: ["2", "3"], status: ["resolved"] }).page).toBe(2);
    expect(parseFilters({})).toEqual({ q: "", status: "", category: "", priority: "", unread: false, page: 1 });
  });

  it("describeSupportFailure never repeats raw server text for unexpected errors", () => {
    expect(describeSupportFailure({ status: 500, data: { detail: "Traceback ..." } }).message).toBe("That could not be completed. Please try again.");
    expect(describeSupportFailure({ status: 429, data: { detail: "Too many messages. Please wait a moment." } }).status).toBe(429);
  });
});

describe("the status buttons", () => {
  it("offer exactly the moves the Support Service allows, and every status has a way out of a closed ticket", () => {
    expect([...STATUSES].sort()).toEqual(Object.keys(TRANSITIONS).sort());
    for (const status of STATUSES) expect(TRANSITIONS[status]).not.toContain(status);
    expect(TRANSITIONS.closed).toEqual(["open"]);
    expect(TRANSITIONS.resolved).toContain("open");
  });
});

// a Super Admin session must not be needed by anything but the Super Admin; the org-admin identity only serves as a "wrong person" in the page tests
void superAdmin;
void orgAdmin;
