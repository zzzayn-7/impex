import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as stockAction } from "@/app/api/stock/[action]/route";

const ID = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const P = "11111111-1111-4111-8111-111111111111";
const TOKEN = "tenant-session-token";
const INVENTORY = "http://inventory-service:8002";
const KEY = "ui-3f2b8c1e-0000-4000-8000-000000000001";

const operation = { operation_id: ID, kind: "in", replayed: false, movements: [] };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
const stub = (handler: (url: string, init: any) => Response) => {
  fetchMock = vi.fn(async (url: any, init: any) => handler(String(url), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
};

const request = (
  method: string,
  body?: unknown,
  { cookie = `impex_tenant_session=${TOKEN}`, type = "application/json", key }: { cookie?: string | null; type?: string | null; key?: string | null } = {}
) =>
  new NextRequest("http://localhost:3001/api/x", {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(type ? { "content-type": type } : {}), ...(key ? { "idempotency-key": key } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const act = (action: string) => ({ params: { action } });
const upstream = () => ({ url: fetchMock.mock.calls[0][0] as string, init: fetchMock.mock.calls[0][1] as any });

const stockBody = { product_id: P, quantity: "5", reason: "Delivery" };

beforeEach(() => {
  process.env.INVENTORY_SERVICE_URL = INVENTORY;
  stub(() => json(201, operation));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("every stock route is protected by the tenant session", () => {
  it.each([
    ["stock in", () => stockAction(request("POST", stockBody, { cookie: null, key: KEY }), act("in"))],
    ["stock out", () => stockAction(request("POST", stockBody, { cookie: null, key: KEY }), act("out"))],
  ])("%s without a session answers 401 and never calls the Inventory Service", async (_name, call) => {
    expect((await call()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not accept the Super Admin portal's cookie", async () => {
    const res = await stockAction(request("POST", stockBody, { cookie: "impex_session=super-admin-token", key: KEY }), act("in"));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the HttpOnly session token as the Bearer token", async () => {
    await stockAction(request("POST", stockBody, { key: KEY }), act("in"));
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("POST /api/stock/[action]", () => {
  beforeEach(() => stub(() => json(201, operation)));

  it.each(["opening", "in", "out"])("%s: forwards whitelisted fields, the key and the Bearer token", async (action) => {
    const res = await stockAction(request("POST", { ...stockBody, organization_id: "evil", balance_after: "999", movement_type: "in" }, { key: KEY }), act(action));
    expect(res.status).toBe(201);
    expect(upstream().url).toBe(`${INVENTORY}/api/v1/inventory/stock/${action}`);
    expect(upstream().init.headers["Idempotency-Key"]).toBe(KEY);
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(upstream().init.body)).toEqual({ product_id: P, quantity: "5", reason: "Delivery" });
  });

  it("never forwards a warehouse, and there is no transfer action any more", async () => {
    await stockAction(request("POST", { ...stockBody, warehouse_id: "11111111-1111-4111-8111-111111111111" }, { key: KEY }), act("in"));
    expect(JSON.parse(upstream().init.body)).toEqual({ product_id: P, quantity: "5", reason: "Delivery" });
    fetchMock.mockClear();
    expect((await stockAction(request("POST", { product_id: P, quantity: "1" }, { key: KEY }), act("transfer"))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the quantity an exact string", async () => {
    await stockAction(request("POST", { ...stockBody, quantity: "0.1000" }, { key: KEY }), act("in"));
    expect(upstream().init.body).toContain('"quantity":"0.1000"');
  });

  it("passes a replay (200) back as a success", async () => {
    stub(() => json(200, { ...operation, replayed: true }));
    const res = await stockAction(request("POST", stockBody, { key: KEY }), act("in"));
    expect(res.status).toBe(200);
    expect((await res.json()).operation.replayed).toBe(true);
  });

  it("requires a well-formed Idempotency-Key", async () => {
    for (const key of [null, "short", "has space in it", "x".repeat(101)]) {
      expect((await stockAction(request("POST", stockBody, { key }), act("in"))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown actions, non-JSON and broken bodies", async () => {
    expect((await stockAction(request("POST", stockBody, { key: KEY }), act("delete"))).status).toBe(404);
    expect((await stockAction(request("POST", stockBody, { key: KEY }), act("movements"))).status).toBe(404);
    expect((await stockAction(request("POST", "x=1", { type: "text/plain", key: KEY }), act("in"))).status).toBe(415);
    expect((await stockAction(request("POST", "{broken", { key: KEY }), act("in"))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no quantity", { ...stockBody, quantity: undefined }, "quantity"],
    ["zero", { ...stockBody, quantity: "0" }, "quantity"],
    ["negative", { ...stockBody, quantity: "-3" }, "quantity"],
    ["not a number", { ...stockBody, quantity: "lots" }, "quantity"],
    ["a JSON number instead of a string", { ...stockBody, quantity: 5 }, "quantity"],
    ["too many decimals", { ...stockBody, quantity: "1.00001" }, "quantity"],
    ["bad product id", { ...stockBody, product_id: "nope" }, "product_id"],
    ["long reason", { ...stockBody, reason: "x".repeat(256) }, "reason"],
  ])("rejects %s without calling the service", async (_name, body, field) => {
    const res = await stockAction(request("POST", body, { key: KEY }), act("out"));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors).toHaveProperty(field);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the service's plain-language refusals on", async () => {
    const message = "Insufficient stock: 5 pcs of Bolt available, 6 requested.";
    stub(() => json(409, { detail: message }));
    const res = await stockAction(request("POST", stockBody, { key: KEY }), act("out"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(message);

    stub(() => json(422, { detail: "Quantity must be a whole number: Bolt is counted in 'pcs'." }));
    const fraction = await stockAction(request("POST", { ...stockBody, quantity: "1.5" }, { key: KEY }), act("in"));
    expect(fraction.status).toBe(400);
    expect((await fraction.json()).error).toContain("whole number");

    stub(() => json(404, { detail: "Product not found." }));
    const missing = await stockAction(request("POST", stockBody, { key: KEY }), act("in"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("Product not found.");
  });

  it("maps 401, 403, 503 and unexpected failures to safe messages", async () => {
    const cases: [number, number][] = [[401, 401], [403, 403], [503, 503], [500, 502]];
    for (const [from, to] of cases) {
      stub(() => json(from, { detail: from === 500 ? "Traceback: secret.py line 3" : "x" }));
      const res = await stockAction(request("POST", stockBody, { key: KEY }), act("in"));
      expect(res.status).toBe(to);
      expect(JSON.stringify(await res.json())).not.toContain("secret.py");
    }
    stub(() => { throw new Error("boom"); });
    expect((await stockAction(request("POST", stockBody, { key: KEY }), act("in"))).status).toBe(503);
  });

  it("never puts an organization anywhere in what it sends", async () => {
    await stockAction(request("POST", { ...stockBody, organization_id: "evil", tenant_id: "evil" }, { key: KEY }), act("in"));
    const { body, headers } = upstream().init;
    expect(body).not.toMatch(/organization|tenant/i);
    expect(Object.keys(headers).join()).not.toMatch(/organization|tenant/i);
    expect(upstream().url).not.toMatch(/organization|tenant/i);
  });
});
