import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as createWarehouse } from "@/app/api/warehouses/route";
import { PATCH as editWarehouse } from "@/app/api/warehouses/[id]/route";
import { POST as archiveWarehouse } from "@/app/api/warehouses/[id]/archive/route";
import { POST as restoreWarehouse } from "@/app/api/warehouses/[id]/restore/route";
import { POST as stockAction } from "@/app/api/stock/[action]/route";

const ID = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const P = "11111111-1111-4111-8111-111111111111";
const W1 = "22222222-2222-4222-8222-222222222222";
const W2 = "33333333-3333-4333-8333-333333333333";
const TOKEN = "tenant-session-token";
const INVENTORY = "http://inventory-service:8002";
const KEY = "ui-3f2b8c1e-0000-4000-8000-000000000001";

const warehouse = { id: ID, code: "MAIN", name: "Main", address: null, is_active: true, created_at: "x", updated_at: "x", products_in_stock: 0 };
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
const wh = (id = ID) => ({ params: { id } });
const act = (action: string) => ({ params: { action } });
const upstream = () => ({ url: fetchMock.mock.calls[0][0] as string, init: fetchMock.mock.calls[0][1] as any });

const stockBody = { product_id: P, warehouse_id: W1, quantity: "5", reason: "Delivery" };

beforeEach(() => {
  process.env.INVENTORY_SERVICE_URL = INVENTORY;
  stub(() => json(201, warehouse));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("every warehouse and stock route is protected by the tenant session", () => {
  it.each([
    ["create warehouse", () => createWarehouse(request("POST", { code: "A", name: "A" }, { cookie: null }))],
    ["edit warehouse", () => editWarehouse(request("PATCH", { name: "X Y" }, { cookie: null }), wh())],
    ["archive warehouse", () => archiveWarehouse(request("POST", undefined, { cookie: null, type: null }), wh())],
    ["restore warehouse", () => restoreWarehouse(request("POST", undefined, { cookie: null, type: null }), wh())],
    ["stock in", () => stockAction(request("POST", stockBody, { cookie: null, key: KEY }), act("in"))],
    ["stock out", () => stockAction(request("POST", stockBody, { cookie: null, key: KEY }), act("out"))],
    ["transfer", () => stockAction(request("POST", stockBody, { cookie: null, key: KEY }), act("transfer"))],
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
    await createWarehouse(request("POST", { code: "MAIN", name: "Main" }));
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("POST /api/warehouses", () => {
  it("normalizes and forwards only code, name and address (a blank address becomes null)", async () => {
    const res = await createWarehouse(request("POST", { code: " main ", name: " Main   depot ", address: "", organization_id: "evil", organizationId: "evil", is_active: false }));
    expect(res.status).toBe(201);
    expect((await res.json()).warehouse.id).toBe(ID);
    expect(upstream().url).toBe(`${INVENTORY}/api/v1/inventory/warehouses`);
    expect(JSON.parse(upstream().init.body)).toEqual({ code: "MAIN", name: "Main depot", address: null });
  });

  it("rejects bad input without calling the service", async () => {
    const res = await createWarehouse(request("POST", { code: "bad code", name: "" }));
    expect(res.status).toBe(400);
    expect(Object.keys((await res.json()).fieldErrors).sort()).toEqual(["code", "name"]);
    expect((await createWarehouse(request("POST", "x=1", { type: "text/plain" }))).status).toBe(415);
    expect((await createWarehouse(request("POST", "{broken"))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a duplicate code under the Code field", async () => {
    stub(() => json(409, { detail: "A warehouse with code 'MAIN' already exists in your organization." }));
    const res = await createWarehouse(request("POST", { code: "MAIN", name: "Again" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.fieldErrors.code).toContain("already exists");
  });

  it("explains outages and inactive organizations safely", async () => {
    stub(() => { throw new Error("connect ECONNREFUSED 10.0.0.5:8002"); });
    const down = await createWarehouse(request("POST", { code: "MAIN", name: "Main" }));
    expect(down.status).toBe(503);
    expect(JSON.stringify(await down.json())).not.toContain("10.0.0.5");
    stub(() => json(403, { detail: "Your organization is not active." }));
    expect((await createWarehouse(request("POST", { code: "MAIN", name: "Main" }))).status).toBe(403);
  });
});

describe("PATCH /api/warehouses/[id]", () => {
  it("forwards only the changed fields", async () => {
    stub(() => json(200, warehouse));
    const res = await editWarehouse(request("PATCH", { name: "Renamed", address: "", organization_id: "evil" }), wh());
    expect(res.status).toBe(200);
    expect(upstream().url).toBe(`${INVENTORY}/api/v1/inventory/warehouses/${ID}`);
    expect(upstream().init.method).toBe("PATCH");
    expect(JSON.parse(upstream().init.body)).toEqual({ name: "Renamed", address: null });
  });

  it("rejects an empty edit, a non-UUID id and invalid values", async () => {
    expect((await editWarehouse(request("PATCH", {}), wh())).status).toBe(400);
    expect((await editWarehouse(request("PATCH", { organization_id: "evil" }), wh())).status).toBe(400);
    expect((await editWarehouse(request("PATCH", { name: "Ok" }), wh("not-a-uuid"))).status).toBe(404);
    expect((await editWarehouse(request("PATCH", { code: "bad code" }), wh())).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a warehouse the service does not find (including another organization's)", async () => {
    stub(() => json(404, { detail: "Warehouse not found." }));
    const res = await editWarehouse(request("PATCH", { name: "Hijack" }), wh());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Warehouse not found.");
  });
});

describe("archive and restore", () => {
  it("call the matching service endpoints and never delete", async () => {
    stub(() => json(200, { ...warehouse, is_active: false }));
    expect((await archiveWarehouse(request("POST", undefined, { type: null }), wh())).status).toBe(200);
    expect(upstream().url).toBe(`${INVENTORY}/api/v1/inventory/warehouses/${ID}/archive`);
    expect(upstream().init.method).toBe("POST");
    stub(() => json(200, warehouse));
    expect((await restoreWarehouse(request("POST", undefined, { type: null }), wh())).status).toBe(200);
    expect(upstream().url).toBe(`${INVENTORY}/api/v1/inventory/warehouses/${ID}/restore`);
  });

  it("reject malformed ids and relay a 404", async () => {
    expect((await archiveWarehouse(request("POST", undefined, { type: null }), wh("../x"))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    stub(() => json(404, { detail: "Warehouse not found." }));
    expect((await restoreWarehouse(request("POST", undefined, { type: null }), wh())).status).toBe(404);
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
    expect(JSON.parse(upstream().init.body)).toEqual({ product_id: P, warehouse_id: W1, quantity: "5", reason: "Delivery" });
  });

  it("transfer: forwards both warehouses", async () => {
    await stockAction(request("POST", { product_id: P, from_warehouse_id: W1, to_warehouse_id: W2, quantity: "2.5", warehouse_id: W1 }, { key: KEY }), act("transfer"));
    expect(JSON.parse(upstream().init.body)).toEqual({ product_id: P, from_warehouse_id: W1, to_warehouse_id: W2, quantity: "2.5" });
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
    ["bad warehouse id", { ...stockBody, warehouse_id: "nope" }, "warehouse_id"],
    ["long reason", { ...stockBody, reason: "x".repeat(256) }, "reason"],
  ])("rejects %s without calling the service", async (_name, body, field) => {
    const res = await stockAction(request("POST", body, { key: KEY }), act("out"));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors).toHaveProperty(field);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a transfer to the same warehouse", async () => {
    const res = await stockAction(request("POST", { product_id: P, from_warehouse_id: W1, to_warehouse_id: W1, quantity: "1" }, { key: KEY }), act("transfer"));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.to_warehouse_id).toContain("different");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the service's plain-language refusals on", async () => {
    const message = "Insufficient stock: 5 pcs of Bolt available in MAIN, 6 requested.";
    stub(() => json(409, { detail: message }));
    const res = await stockAction(request("POST", stockBody, { key: KEY }), act("out"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(message);

    stub(() => json(422, { detail: "Quantity must be a whole number: Bolt is counted in 'pcs'." }));
    const fraction = await stockAction(request("POST", { ...stockBody, quantity: "1.5" }, { key: KEY }), act("in"));
    expect(fraction.status).toBe(400);
    expect((await fraction.json()).error).toContain("whole number");

    stub(() => json(404, { detail: "Warehouse not found." }));
    const missing = await stockAction(request("POST", stockBody, { key: KEY }), act("in"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("Warehouse not found.");
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
