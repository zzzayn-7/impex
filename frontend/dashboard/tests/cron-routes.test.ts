import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as financeSync from "@/app/api/cron/finance-sync/route";
import * as supportOutbox from "@/app/api/cron/support-outbox/route";

// Scheduled jobs: a Vercel schedule calls these PUBLIC routes with CRON_SECRET; they call an internal endpoint of the Finance / Support Service (through the
// binding) with the shared secret. They must refuse everyone else, fail closed when nothing is configured and never echo a secret.

const SECRET = "cron-secret-of-at-least-16-chars";
const KEY = "internal-shared-key";
const JOBS = [
  ["finance-sync", financeSync, "FINANCE_SERVICE_URL", "https://finance.internal/", "/internal/v1/finance/sync-cycle", { organizations: 3 }],
  ["support-outbox", supportOutbox, "SUPPORT_SERVICE_URL", "https://support.internal", "/internal/v1/support/outbox-run", { sent: 2, retry: 0, failed: 0 }],
] as const;

let calls: { url: string; init: any }[];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const post = (route: { POST: (r: NextRequest) => Promise<Response> }, authorization?: string) =>
  route.POST(new NextRequest("https://app.example.com/api/cron/x", { method: "POST", headers: authorization === undefined ? {} : { authorization } }));

beforeEach(() => {
  calls = [];
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("MODULE_INTERNAL_API_KEY", KEY);
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => { calls.push({ url: String(url), init }); return json(200, { organizations: 3, sent: 2, retry: 0, failed: 0 }); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe.each(JOBS)("/api/cron/%s", (_name, route, urlVar, base, path) => {
  beforeEach(() => { vi.stubEnv(urlVar, base); });

  it("calls the service's internal endpoint with the shared secret when Vercel's CRON_SECRET is presented", async () => {
    const res = await post(route, `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ ok: true, result: { organizations: 3 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${base.replace(/\/$/, "")}${path}`); // the bound URL, with or without a trailing slash
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ "X-Internal-Key": KEY });
  });

  it.each([undefined, "", "Bearer wrong", SECRET, `bearer ${SECRET}`, `Bearer ${SECRET}x`, `Bearer  ${SECRET}`, "Basic abc"])("refuses %j (401) and calls nothing", async (header) => {
    const res = await post(route, header);
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("fails closed when CRON_SECRET is missing or too short, even for a caller who sends an empty or matching value", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await post(route, "Bearer ")).status).toBe(503);
    expect((await post(route)).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "short");
    expect((await post(route, "Bearer short")).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("answers 503 when the shared service secret is not configured, and calls nothing", async () => {
    vi.stubEnv("MODULE_INTERNAL_API_KEY", "");
    expect((await post(route, `Bearer ${SECRET}`)).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("reports a failing or unreachable service as 502 without echoing any secret", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { detail: `Invalid service credentials ${KEY}` })));
    const refused = await post(route, `Bearer ${SECRET}`);
    expect(refused.status).toBe(502);
    expect(JSON.stringify(await refused.json())).not.toContain(KEY);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`connect ECONNREFUSED ${KEY}`); }));
    const down = await post(route, `Bearer ${SECRET}`);
    expect(down.status).toBe(502);
    expect(JSON.stringify(await down.json())).not.toContain(KEY);
  });

  it("only answers POST (a schedule's default); there is no GET", () => {
    expect((route as any).GET).toBeUndefined();
  });
});
