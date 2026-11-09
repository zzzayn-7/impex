import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as dispatchOrder } from "@/app/api/sales/orders/[id]/dispatch/route";
import { IDEMPOTENCY_KEY_RE } from "@/lib/stock-validation";

const ORDER = "d0000000-0000-4000-8000-000000000001";
const LIST = "a0000000-0000-4000-8000-000000000001";
const ITEM1 = "11111111-1111-4111-8111-111111111111";
const ITEM2 = "22222222-2222-4222-8222-222222222222";
const ITEM3 = "33333333-3333-4333-8333-333333333333";
const DISPATCH = "e0000000-0000-4000-8000-000000000001";
const TOKEN = "session-token-abc";
const SALES = "http://sales-service:8003";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const line = (id: string, ordered: string, dispatched: string) => ({ id, ordered_quantity: ordered, dispatched_quantity: dispatched, pending_quantity: "0.0000", remaining_quantity: "0" });
const order = (extra: Record<string, unknown> = {}) => ({
  id: ORDER, number: "SO-000001", status: "active", delivery_list: { id: LIST, number: "DL-000001", status: "ready" }, can_dispatch: true, message: null, dispatches: [],
  lines: [line(ITEM1, "400.0000", "150.0000"), line(ITEM2, "5.0000", "0.0000"), line(ITEM3, "7.0000", "7.0000")], ...extra,
});

type Call = { method: string; path: string; body: any; headers: Record<string, string> };
let calls: Call[];
let routes: Record<string, () => Response>;

beforeEach(() => {
  process.env.SALES_SERVICE_URL = SALES;
  calls = [];
  routes = {
    [`GET /api/v1/sales/orders/${ORDER}`]: () => json(200, order()),
    "POST /api/v1/sales/dispatches": () => json(201, { id: DISPATCH, status: "draft" }),
    [`PUT /api/v1/sales/dispatches/${DISPATCH}/lines`]: () => json(200, { id: DISPATCH, status: "draft" }),
    [`POST /api/v1/sales/dispatches/${DISPATCH}/confirm`]: () => json(200, { id: DISPATCH, status: "confirmed", dispatch_date: "2026-11-09" }),
  };
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any = {}) => {
    const path = new URL(String(url)).pathname;
    const method = init.method ?? "GET";
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    const handler = routes[`${method} ${path}`];
    return handler ? handler() : json(404, { detail: "not found" });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const call = (id = ORDER, cookie: string | null = `impex_tenant_session=${TOKEN}`) =>
  dispatchOrder(new NextRequest(`http://localhost:3001/api/sales/orders/${id}/dispatch`, { method: "POST", headers: cookie ? { cookie } : {} }), { params: { id } });
const writes = () => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path.replace(DISPATCH, "<dispatch>")}`);

describe("POST /api/sales/orders/[id]/dispatch", () => {
  it("needs a signed-in administrator and a real order id, and asks the Sales Service for nothing otherwise", async () => {
    expect((await call(ORDER, null)).status).toBe(401);
    expect((await call("not-a-uuid")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("dispatches everything that is left: prepares ONE dispatch with every remaining quantity, then confirms it", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ confirmed: true, dispatchedOn: "2026-11-09", dispatch: { status: "confirmed" } });
    expect(writes()).toEqual(["POST /api/v1/sales/dispatches", "POST /api/v1/sales/dispatches/<dispatch>/confirm"]);
    const create = calls.find((c) => c.method === "POST" && c.path === "/api/v1/sales/dispatches")!;
    // 400 ordered - 150 already dispatched, 5 untouched; the line that was dispatched completely is left out
    expect(create.body).toEqual({ delivery_list_id: LIST, lines: [{ delivery_list_item_id: ITEM1, quantity: "250.0000" }, { delivery_list_item_id: ITEM2, quantity: "5.0000" }] });
    expect(create.headers["Idempotency-Key"]).toMatch(IDEMPOTENCY_KEY_RE);
    expect(Object.keys(create.body)).not.toContain("organization_id");
    expect(calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("uses the same Idempotency-Key for the same order state, so a double click cannot create two dispatches", async () => {
    await call();
    await call();
    const keys = calls.filter((c) => c.path === "/api/v1/sales/dispatches" && c.method === "POST").map((c) => c.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("a dispatch that is already being posted is only confirmed again: nothing new is created and nothing is taken out twice", async () => {
    routes[`GET /api/v1/sales/orders/${ORDER}`] = () => json(200, order({ can_dispatch: false, dispatches: [{ id: DISPATCH, status: "posting" }] }));
    const res = await call();
    expect(res.status).toBe(200);
    expect(writes()).toEqual(["POST /api/v1/sales/dispatches/<dispatch>/confirm"]);
  });

  it("a draft left behind by an earlier refusal is refreshed with the current remaining quantities, then confirmed", async () => {
    routes[`GET /api/v1/sales/orders/${ORDER}`] = () => json(200, order({ can_dispatch: false, dispatches: [{ id: DISPATCH, status: "draft" }] }));
    expect((await call()).status).toBe(200);
    expect(writes()).toEqual(["PUT /api/v1/sales/dispatches/<dispatch>/lines", "POST /api/v1/sales/dispatches/<dispatch>/confirm"]);
    expect(calls.find((c) => c.method === "PUT")!.body.lines.map((l: any) => l.quantity)).toEqual(["250.0000", "5.0000"]);
  });

  it("cancelled earlier dispatches do not count: a new one is prepared", async () => {
    routes[`GET /api/v1/sales/orders/${ORDER}`] = () => json(200, order({ dispatches: [{ id: "x", status: "cancelled" }] }));
    expect((await call()).status).toBe(200);
    expect(writes()[0]).toBe("POST /api/v1/sales/dispatches");
  });

  it("refuses, creating nothing, when the order is not active, cannot be dispatched, or has nothing left", async () => {
    routes[`GET /api/v1/sales/orders/${ORDER}`] = () => json(200, order({ status: "pending_reservation" }));
    expect((await call()).status).toBe(409);
    routes[`GET /api/v1/sales/orders/${ORDER}`] = () => json(200, order({ can_dispatch: false, message: "A change to this order is being applied." }));
    const blocked = await call();
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toContain("being applied");
    routes[`GET /api/v1/sales/orders/${ORDER}`] = () => json(200, order({ lines: [line(ITEM3, "7.0000", "7.0000")] }));
    const empty = await call();
    expect(empty.status).toBe(409);
    expect((await empty.json()).error).toContain("Nothing is left to dispatch");
    expect(writes()).toEqual([]);
  });

  it("passes on 'not enough stock' and keeps the stock untouched (the confirmation is the only thing that deducts)", async () => {
    routes[`POST /api/v1/sales/dispatches/${DISPATCH}/confirm`] = () => json(409, { detail: { code: "insufficient_stock", message: "Only 10 pcs of Water bottle are on hand." } });
    const res = await call();
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("Water bottle");
  });

  it("answers 202 when the posting could not be verified yet, and the dispatch is NOT reported as done", async () => {
    routes[`POST /api/v1/sales/dispatches/${DISPATCH}/confirm`] = () => json(202, { id: DISPATCH, status: "posting", dispatch_date: "2026-11-09" });
    const res = await call();
    expect(res.status).toBe(202);
    expect((await res.json()).confirmed).toBe(false);
  });

  it("an order of another organization is simply not found", async () => {
    routes[`GET /api/v1/sales/orders/${ORDER}`] = () => json(404, { detail: "Order not found." });
    expect((await call()).status).toBe(404);
    expect(writes()).toEqual([]);
  });
});
