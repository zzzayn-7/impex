import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as createInvoice } from "@/app/api/sales/order-invoices/route";
import { GET as invoicePdf } from "@/app/api/sales/order-invoices/[id]/pdf/route";

// POST /api/sales/order-invoices: Sales Invoice > New invoice > Create invoice. The browser sends nothing but the order id; the Sales Service builds the invoice from the order's own
// lines at the agreed prices and the portal passes on only what the page needs. GET /api/sales/order-invoices/[id]/pdf: the same template as every invoice, for Print and Download.

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
  answer = () => json(201, { id: INVOICE, number: "INV-000004", total: "350.0000", lines: [{ secret: "not for the browser" }], client_address: "1 Main St" });
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any = {}) => {
    calls.push({ method: init.method ?? "GET", path: new URL(String(url)).pathname + new URL(String(url)).search, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    return answer();
  }));
});
afterEach(() => vi.unstubAllGlobals());

const create = (body: unknown = { orderId: ORDER }, cookie: string | null = `impex_tenant_session=${TOKEN}`) =>
  createInvoice(new NextRequest("http://localhost:3001/api/sales/order-invoices", { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));

describe("POST /api/sales/order-invoices", () => {
  it("needs a signed-in administrator and a real order id, and asks the Sales Service for nothing otherwise", async () => {
    expect((await create({ orderId: ORDER }, null)).status).toBe(401);
    expect((await create({ orderId: "not-a-uuid" })).status).toBe(404);
    expect((await create({})).status).toBe(404);
    expect((await create({ orderId: "../../clients" })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("asks the Sales Service for the invoice of THIS order with the administrator's own token, and sends nothing but the order id", async () => {
    const res = await create({ orderId: ORDER, total: "1", client_id: "evil", organization_id: "evil" });
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/sales/order-invoices", body: { order_id: ORDER } });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers with the invoice's id and number, not the whole invoice", async () => {
    expect(await (await create()).json()).toEqual({ invoice: { id: INVOICE, number: "INV-000004" }, created: true });
  });

  it("an order that already had an invoice answers 200 and says it was not made now", async () => {
    answer = () => json(200, { id: INVOICE, number: "INV-000004" });
    const res = await create();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invoice: { id: INVOICE, number: "INV-000004" }, created: false });
  });

  it.each([
    [409, { detail: { code: "not_prepared", message: "SO-000001 is not a prepared order waiting to be dispatched, so it cannot be invoiced here." } }, 409, "SO-000001 is not a prepared order waiting to be dispatched, so it cannot be invoiced here."],
    [422, { detail: { code: "prices_not_recorded", message: "SO-000001 was made before agreed prices were recorded, so there is no price to put on the invoice." } }, 400, null],
    [404, { detail: "Order not found." }, 404, "Order not found."],
    [401, { detail: "Invalid or expired token" }, 401, "Your session has expired. Please sign in again."],
    [500, { detail: "boom" }, 502, "The request could not be completed. Please try again."],
  ])("translates the Sales Service's %s into a safe answer", async (upstream, body, status, message) => {
    answer = () => json(upstream, body);
    const res = await create();
    expect(res.status).toBe(status);
    if (message) expect((await res.json()).error).toBe(message);
  });

  it("says the service is unavailable when it cannot be reached", async () => {
    answer = () => { throw new Error("connection refused"); };
    const res = await create();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/unavailable/i);
  });
});

describe("GET /api/sales/order-invoices/[id]/pdf", () => {
  const pdf = (id = INVOICE, query = "", cookie: string | null = `impex_tenant_session=${TOKEN}`) =>
    invoicePdf(new NextRequest(`http://localhost:3001/api/sales/order-invoices/${id}/pdf${query}`, { method: "GET", headers: cookie ? { cookie } : {} }), { params: { id } });

  it("needs a session and a real id", async () => {
    expect((await pdf(INVOICE, "", null)).status).toBe(401);
    expect((await pdf("nope")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("passes the PDF on with a safe filename: attached for Download, shown for Print, never cached", async () => {
    answer = () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="INV-000004.pdf"' } });
    const download = await pdf();
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="INV-000004.pdf"');
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(calls[0].path).toBe(`/api/v1/sales/order-invoices/${INVOICE}/pdf`);
    const shown = await pdf(INVOICE, "?inline=1");
    expect(shown.headers.get("content-disposition")).toBe('inline; filename="INV-000004.pdf"');
    expect(calls[1].path).toBe(`/api/v1/sales/order-invoices/${INVOICE}/pdf?inline=true`);
  });

  it("answers not found for an invoice that is not the session's own organization's", async () => {
    answer = () => json(404, { detail: "Invoice not found." });
    expect((await pdf()).status).toBe(404);
  });
});
