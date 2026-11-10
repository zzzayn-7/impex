import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as generateInvoice } from "@/app/api/sales/orders/[id]/invoice/route";

// POST /api/sales/orders/[id]/invoice: the Delivery Lists card's Generate Invoice. The browser sends nothing but the order id; the Sales Service builds
// and saves the draft invoice and the portal passes on only what the page needs.

const ORDER = "d0000000-0000-4000-8000-000000000001";
const INVOICE = "9f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const TOKEN = "session-token-abc";
const SALES = "http://sales-service:8003";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { method: string; path: string; body: any; headers: Record<string, string> };
let calls: Call[];
let answer: () => Response;

beforeEach(() => {
  process.env.SALES_SERVICE_URL = SALES;
  calls = [];
  answer = () => json(201, { created: true, invoice: { id: INVOICE, number: null, status: "draft", total: "29.8000", currency_code: "USD", client: { name: "Acme" }, lines: [{ secret: "not for the browser" }] } });
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any = {}) => {
    calls.push({ method: init.method ?? "GET", path: new URL(String(url)).pathname, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    return answer();
  }));
});
afterEach(() => vi.unstubAllGlobals());

const call = (id = ORDER, cookie: string | null = `impex_tenant_session=${TOKEN}`) =>
  generateInvoice(new NextRequest(`http://localhost:3001/api/sales/orders/${id}/invoice`, { method: "POST", headers: cookie ? { cookie } : {} }), { params: { id } });

describe("POST /api/sales/orders/[id]/invoice", () => {
  it("needs a signed-in administrator and a real order id, and asks the Sales Service for nothing otherwise", async () => {
    expect((await call(ORDER, null)).status).toBe(401);
    expect((await call("not-a-uuid")).status).toBe(404);
    expect((await call("../../clients")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("asks the Sales Service to generate the invoice for THIS order with the administrator's own token and nothing else", async () => {
    const res = await call();
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: `/api/v1/sales/orders/${ORDER}/invoice`, body: undefined });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers with the new draft's id and a few facts, not the whole invoice", async () => {
    expect(await (await call()).json()).toEqual({ invoice: { id: INVOICE, number: null, status: "draft", total: "29.8000", currency_code: "USD" }, created: true });
  });

  it("an order that already had an invoice answers 200 and says it was not made now", async () => {
    answer = () => json(200, { created: false, invoice: { id: INVOICE, number: "INV-000004", status: "issued", total: "10.0000", currency_code: "EUR" } });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: false, invoice: { id: INVOICE, number: "INV-000004", status: "issued" } });
  });

  it.each([
    [409, { detail: { code: "not_dispatched", message: "Nothing has been dispatched for this order yet, so there is nothing to invoice." } }, 409, "Nothing has been dispatched for this order yet, so there is nothing to invoice."],
    [422, { detail: { code: "price_missing", message: "No selling price is set for Bolt. Set it in Stock, or create this invoice by hand on the Sales Invoice page." } }, 400, "No selling price is set for Bolt. Set it in Stock, or create this invoice by hand on the Sales Invoice page."],
    [422, { detail: { code: "mixed_currencies", message: "The products of this order are priced in different currencies (EUR, USD), and nothing is converted." } }, 400, "The products of this order are priced in different currencies (EUR, USD), and nothing is converted."],
    [503, { detail: { code: "prices_unavailable", message: "The product prices could not be read just now, so the invoice was not made. Please try again in a moment." } }, 503, "The product prices could not be read just now, so the invoice was not made. Please try again in a moment."],
    [404, { detail: "Order not found." }, 404, "Order not found."],
    [401, { detail: "Invalid or expired token" }, 401, "Your session has expired. Please sign in again."],
    [500, { detail: "boom" }, 502, "The request could not be completed. Please try again."],
  ])("translates the Sales Service's %s into a safe answer", async (upstream, body, status, message) => {
    answer = () => json(upstream, body);
    const res = await call();
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(message);
  });

  it("says the service is unavailable when it cannot be reached", async () => {
    answer = () => { throw new Error("connection refused"); };
    const res = await call();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/unavailable/i);
  });
});
