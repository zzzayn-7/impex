import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE as deleteExpenses, PUT as saveExpenses } from "@/app/api/finance/order-expenses/[orderId]/route";

// PUT /api/finance/order-expenses/[orderId]: Finance > PNL Calculator > Save. The browser sends only the amounts it typed. The order (and so its currency) is read from the Sales
// Service with the administrator's own token, so an order that is not theirs is "not found" and nothing is saved; the Finance Service stores the amounts.

const ORDER = "d0000000-0000-4000-8000-000000000001";
const TOKEN = "session-token-abc";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { method: string; path: string; body: any; headers: Record<string, string> };
let calls: Call[];
let sales: () => Response;
let finance: () => Response;

beforeEach(() => {
  process.env.SALES_SERVICE_URL = "http://sales-service:8003";
  process.env.FINANCE_SERVICE_URL = "http://finance-service:8006";
  calls = [];
  sales = () => json(200, { id: ORDER, number: "SO-000001", currency_code: "USD", total_amount: "350.0000", secret: "x" });
  finance = () => json(200, { order_id: ORDER, currency_code: "USD", goods_cost: "100.0000", delivery_charges: "5.0000", other_expenses: [], updated_by_email: "a@b.c", updated_at: "2026-11-07T10:00:00+00:00" });
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    calls.push({ method: init.method ?? "GET", path: u.pathname, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    return u.pathname.startsWith("/api/v1/sales/") ? sales() : finance();
  }));
});
afterEach(() => vi.unstubAllGlobals());

const save = (body: unknown = { goodsCost: "100", deliveryCharges: "5", otherExpenses: [{ label: "Packing", amount: "2.5" }] }, orderId = ORDER, cookie: string | null = `impex_tenant_session=${TOKEN}`) =>
  saveExpenses(new NextRequest(`http://localhost:3001/api/finance/order-expenses/${orderId}`, { method: "PUT", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }), { params: { orderId } });

describe("PUT /api/finance/order-expenses/[orderId]", () => {
  it("needs a signed-in administrator and a real order id, and asks nobody for anything otherwise", async () => {
    expect((await save(undefined, ORDER, null)).status).toBe(401);
    expect((await save(undefined, "not-a-uuid")).status).toBe(404);
    expect((await save(undefined, "../../clients")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("reads the order from the Sales Service with the administrator's token, then saves the amounts with the ORDER'S currency and nothing else", async () => {
    const res = await save({ goodsCost: "100", deliveryCharges: "5", otherExpenses: [{ label: "  Packing  box ", amount: "2.5", note: "x" }], currency: "EUR", organization_id: "evil", sellingPrice: "9999", profit: "1" });
    expect(res.status).toBe(200);
    expect(calls.map((c) => [c.method, c.path])).toEqual([["GET", `/api/v1/sales/orders/${ORDER}`], ["PUT", `/api/v1/finance/order-expenses/${ORDER}`]]);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[1].body).toEqual({ currency_code: "USD", goods_cost: "100", delivery_charges: "5", other_expenses: [{ label: "Packing box", amount: "2.5" }] });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).expenses.order_id).toBe(ORDER);
  });

  it("a blank amount counts as zero", async () => {
    await save({ goodsCost: "", deliveryCharges: undefined, otherExpenses: [{ label: "Fuel", amount: "" }] });
    expect(calls[1].body).toEqual({ currency_code: "USD", goods_cost: "0", delivery_charges: "0", other_expenses: [{ label: "Fuel", amount: "0" }] });
  });

  it.each([
    [{ goodsCost: "abc" }, /cost of the goods/], [{ goodsCost: "-1" }, /cost of the goods/], [{ goodsCost: "1.23456" }, /cost of the goods/], [{ goodsCost: 5 }, /cost of the goods/],
    [{ deliveryCharges: "1,5" }, /delivery/], [{ otherExpenses: "list" }, /list/], [{ otherExpenses: [{ label: "", amount: "1" }] }, /name/], [{ otherExpenses: [{ label: "x".repeat(61), amount: "1" }] }, /60/],
    [{ otherExpenses: [{ label: "Fuel", amount: "-5" }] }, /Fuel/], [{ otherExpenses: ["x"] }, /Invalid/], [{ otherExpenses: Array.from({ length: 21 }, (_, i) => ({ label: `E${i}`, amount: "1" })) }, /at most 20/],
  ])("refuses %j before asking any service", async (body, message) => {
    const res = await save(body as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect(calls).toHaveLength(0);
  });

  it("an order that is not the session's organization's is 'not found' and nothing is saved", async () => {
    sales = () => json(404, { detail: "Order not found." });
    const res = await save();
    expect(res.status).toBe(404);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("an order without prices cannot be worked out and nothing is saved", async () => {
    sales = () => json(200, { id: ORDER, number: "SO-000001", currency_code: null, total_amount: null });
    const res = await save();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no prices/);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("translates the services' answers: an expired session, an outage, a refusal", async () => {
    sales = () => json(401, { detail: "Invalid or expired token" });
    expect((await save()).status).toBe(401);
    sales = () => { throw new Error("down"); };
    expect((await save()).status).toBe(503);
    sales = () => json(200, { id: ORDER, currency_code: "USD" });
    finance = () => json(403, { detail: "The Finance module is not enabled." });
    expect((await save()).status).toBe(403);
    finance = () => { throw new Error("down"); };
    expect((await save()).status).toBe(503);
    finance = () => json(422, { detail: "bad" });
    expect([400, 422]).toContain((await save()).status);
  });
});

describe("DELETE /api/finance/order-expenses/[orderId]", () => {
  const remove = (orderId = ORDER, cookie: string | null = `impex_tenant_session=${TOKEN}`) =>
    deleteExpenses(new NextRequest(`http://localhost:3001/api/finance/order-expenses/${orderId}`, { method: "DELETE", headers: cookie ? { cookie } : {} }), { params: { orderId } });

  it("needs a session and a real order id, and asks nobody otherwise", async () => {
    expect((await remove(ORDER, null)).status).toBe(401);
    expect((await remove("not-a-uuid")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("asks the Finance Service to delete the saved expenses with the administrator's own token, and nothing else", async () => {
    finance = () => new Response(null, { status: 204 });
    const res = await remove();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "DELETE", path: `/api/v1/finance/order-expenses/${ORDER}` });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("translates the answers: nothing saved, an expired session, an outage", async () => {
    finance = () => json(404, { detail: "No expenses saved for this order." });
    expect((await remove()).status).toBe(404);
    finance = () => json(401, { detail: "x" });
    expect((await remove()).status).toBe(401);
    finance = () => { throw new Error("down"); };
    expect((await remove()).status).toBe(503);
  });
});
