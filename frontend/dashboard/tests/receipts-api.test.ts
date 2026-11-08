import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describePurchasingFailure } from "@/lib/purchasing";
import { validateReceivedQuantity } from "@/lib/purchasing-browser";
import { GET as listReceipts, POST as createReceipt } from "@/app/api/purchasing/goods-receipts/route";
import { GET as getReceipt, PATCH as editReceipt } from "@/app/api/purchasing/goods-receipts/[id]/route";
import { PUT as saveLines } from "@/app/api/purchasing/goods-receipts/[id]/lines/route";
import { POST as receiptAction } from "@/app/api/purchasing/goods-receipts/[id]/[action]/route";

const ID = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718";
const LINE = "11111111-1111-4111-8111-111111111111";
const LINE2 = "11111111-1111-4111-8111-222222222222";
const ORDER = "44444444-4444-4444-8444-444444444444";
const TOKEN = "session-token-abc";
const PURCHASING = "http://purchasing-service:8004";
const KEY = "ui-3f2b8c1e-0000-4000-8000-000000000001";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
const stub = (handler: (url: string, init: any) => Response) => {
  fetchMock = vi.fn(async (url: any, init: any) => handler(String(url), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
};
const request = (method: string, body?: unknown, { cookie = `impex_tenant_session=${TOKEN}`, query = "", key }: { cookie?: string | null; query?: string; key?: string } = {}) =>
  new NextRequest(`http://localhost:3001/api/purchasing/x${query}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const upstream = () => ({ url: fetchMock.mock.calls[0][0] as string, init: fetchMock.mock.calls[0][1] as any });
const sentBody = () => JSON.parse(upstream().init.body);
const params = (extra: Record<string, string> = {}) => ({ params: { id: ID, ...extra } });

beforeEach(() => {
  process.env.PURCHASING_SERVICE_URL = PURCHASING;
  stub(() => json(200, {}));
});
afterEach(() => vi.unstubAllGlobals());

describe("received quantities", () => {
  it.each(["", "0", "0.0", "12", "2.5", "0.0001", "99999999999999.9999"])("accepts %j", (value) => {
    expect(validateReceivedQuantity(value, "accepted")).toBeUndefined();
  });
  it.each(["abc", "-1", "1.00001", "1e3", "1,5", " 1", "100000000000000"])("rejects %j", (value) => {
    expect(validateReceivedQuantity(value, "accepted")).toContain("at most 4 decimals");
  });
});

describe("failure mapping for receipts", () => {
  it("passes the over-receipt and Inventory-refusal codes through", () => {
    const over = describePurchasingFailure({ status: 409, data: { detail: { message: "You cannot receive 11", code: "over_receipt" } } });
    expect(over).toMatchObject({ status: 409, code: "over_receipt", message: "You cannot receive 11" });
    const refused = describePurchasingFailure({ status: 409, data: { detail: { message: "The inventory service refused", code: "inventory_rejected" } } });
    expect(refused.code).toBe("inventory_rejected");
  });
  it("maps receipt field names for the form", () => {
    const failure = describePurchasingFailure({ status: 422, data: { detail: [{ loc: ["body", "lines", 0, "accepted_quantity"], msg: "Input should be a valid decimal" }, { loc: ["body", "received_date"], msg: "Value error, bad" }] } });
    expect(failure.fieldErrors).toEqual({ acceptedQuantity: "Input should be a valid decimal", receivedDate: "bad" });
  });
});

const lineBody = (extra: Record<string, unknown> = {}) => ({ purchaseOrderLineId: LINE, acceptedQuantity: "10", rejectedQuantity: "1", notes: "  two dented  ", ...extra });

describe("goods receipts: creating a draft", () => {
  it("sends only the allowed fields, the caller's token and the idempotency key", async () => {
    stub(() => json(201, { id: ID, number: "GR-000001", status: "draft" }));
    const res = await createReceipt(request("POST", {
      purchaseOrderId: ORDER, receivedDate: "2026-11-07", supplierReference: "  DN   42 ", notes: "n", lines: [lineBody({ unit: "box", productName: "x", organizationId: "evil", status: "confirmed" })],
      organization_id: "evil", status: "confirmed", number: "GR-9", postingKey: "k",
    }, { key: KEY }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ receipt: { number: "GR-000001" }, replayed: false });
    expect(upstream().url).toBe(`${PURCHASING}/api/v1/purchasing/goods-receipts`);
    expect(upstream().init.method).toBe("POST");
    expect(upstream().init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "Idempotency-Key": KEY });
    expect(sentBody()).toEqual({
      purchase_order_id: ORDER, received_date: "2026-11-07", supplier_reference: "DN 42", notes: "n",
      lines: [{ purchase_order_line_id: LINE, accepted_quantity: "10", rejected_quantity: "1", notes: "two dented" }],
    });
  });

  it("quantities stay exact strings, a blank rejected quantity is zero, a number is refused", async () => {
    stub(() => json(201, {}));
    await createReceipt(request("POST", { purchaseOrderId: ORDER, lines: [{ purchaseOrderLineId: LINE, acceptedQuantity: "2.5000", warehouseId: "11111111-1111-4111-8111-111111111111" }] }, { key: KEY }));
    expect(sentBody().lines[0]).toEqual({ purchase_order_line_id: LINE, accepted_quantity: "2.5000", rejected_quantity: "0" }); // a warehouse sent by the browser is dropped
    fetchMock.mockClear();
    const res = await createReceipt(request("POST", { purchaseOrderId: ORDER, lines: [{ purchaseOrderLineId: LINE, acceptedQuantity: 2.5 }] }, { key: KEY }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a retry is reported as a replay", async () => {
    stub(() => json(200, { id: ID }));
    const res = await createReceipt(request("POST", { purchaseOrderId: ORDER }, { key: KEY }));
    expect(res.status).toBe(200);
    expect((await res.json()).replayed).toBe(true);
  });

  it.each([
    ["no key", { purchaseOrderId: ORDER }, undefined, 400],
    ["a bad key", { purchaseOrderId: ORDER }, "short", 400],
    ["a bad order id", { purchaseOrderId: "nope" }, KEY, 404],
    ["a bad date", { purchaseOrderId: ORDER, receivedDate: "2026-13-45" }, KEY, 400],
    ["a bad quantity", { purchaseOrderId: ORDER, lines: [lineBody({ acceptedQuantity: "1e3" })] }, KEY, 400],
    ["a bad line id", { purchaseOrderId: ORDER, lines: [lineBody({ purchaseOrderLineId: "x" })] }, KEY, 400],
    ["lines that are not a list", { purchaseOrderId: ORDER, lines: "all" }, KEY, 400],
    ["too many lines", { purchaseOrderId: ORDER, lines: Array.from({ length: 501 }, () => lineBody()) }, KEY, 400],
    ["a long note", { purchaseOrderId: ORDER, notes: "x".repeat(2001) }, KEY, 400],
  ])("refuses %s without calling the service", async (_name, body, key, status) => {
    const res = await createReceipt(request("POST", body, { key }));
    expect(res.status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs a session and JSON", async () => {
    expect((await createReceipt(request("POST", { purchaseOrderId: ORDER }, { cookie: null, key: KEY }))).status).toBe(401);
    expect((await createReceipt(request("POST", "not json", { key: KEY }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relays the service's explanation for an over-receipt, with its code", async () => {
    stub(() => json(409, { detail: { message: "You cannot receive 11 pcs of Bolt", code: "over_receipt" } }));
    const res = await createReceipt(request("POST", { purchaseOrderId: ORDER, lines: [lineBody()] }, { key: KEY }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "You cannot receive 11 pcs of Bolt", code: "over_receipt" });
  });

  it("explains an outage", async () => {
    stub(() => { throw new Error("connection refused"); });
    const res = await createReceipt(request("POST", { purchaseOrderId: ORDER }, { key: KEY }));
    expect(res.status).toBe(503);
  });
});

describe("goods receipts: lines, header, reading", () => {
  it("replaces the lines with a PUT of exactly the allowed fields", async () => {
    stub(() => json(200, { id: ID }));
    const res = await saveLines(request("PUT", { lines: [lineBody(), lineBody({ purchaseOrderLineId: LINE2, acceptedQuantity: "0", rejectedQuantity: "3", notes: "" })], organization_id: "evil" }), params());
    expect(res.status).toBe(200);
    expect(upstream().url).toBe(`${PURCHASING}/api/v1/purchasing/goods-receipts/${ID}/lines`);
    expect(upstream().init.method).toBe("PUT");
    expect(sentBody()).toEqual({
      lines: [
        { purchase_order_line_id: LINE, accepted_quantity: "10", rejected_quantity: "1", notes: "two dented" },
        { purchase_order_line_id: LINE2, accepted_quantity: "0", rejected_quantity: "3" },
      ],
    });
  });

  it("refuses bad input, a bad id and a missing session before calling the service", async () => {
    expect((await saveLines(request("PUT", { lines: [lineBody({ rejectedQuantity: "-1" })] }), params())).status).toBe(400);
    expect((await saveLines(request("PUT", { nothing: true }), params())).status).toBe(400);
    expect((await saveLines(request("PUT", { lines: [] }), { params: { id: "x" } })).status).toBe(404);
    expect((await saveLines(request("PUT", { lines: [] }, { cookie: null }), params())).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("edits only the date, reference and notes", async () => {
    stub(() => json(200, { id: ID }));
    await editReceipt(request("PATCH", { receivedDate: "2026-11-05", supplierReference: " DN 9 ", notes: "late", status: "confirmed", purchaseOrderId: ORDER }), params());
    expect(sentBody()).toEqual({ received_date: "2026-11-05", supplier_reference: "DN 9", notes: "late" });
    fetchMock.mockClear();
    expect((await editReceipt(request("PATCH", { status: "confirmed" }), params())).status).toBe(400);
    expect((await editReceipt(request("PATCH", { receivedDate: "soon" }), params())).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads one receipt, and another organization's receipt is a plain 404", async () => {
    stub(() => json(200, { id: ID, number: "GR-000001" }));
    const res = await getReceipt(request("GET"), params());
    expect(await res.json()).toEqual({ receipt: { id: ID, number: "GR-000001" } });
    stub(() => json(404, { detail: "Goods receipt not found." }));
    const missing = await getReceipt(request("GET"), params());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "Goods receipt not found." });
    expect((await getReceipt(request("GET"), { params: { id: "nope" } })).status).toBe(404);
  });

  it("lists with whitelisted parameters only", async () => {
    stub(() => json(200, { items: [], total: 0, limit: 50, offset: 0 }));
    await listReceipts(request("GET", undefined, { query: `?status=confirmed&supplierId=${ID}&warehouseId=11111111-1111-4111-8111-111111111111&purchaseOrderId=${ORDER}&dateFrom=2026-11-01&dateTo=2026-11-30&q=%20dn&organization_id=evil&sort=x` }));
    expect(Object.fromEntries(new URL(upstream().url).searchParams)).toEqual({
      status: "confirmed", supplier_id: ID, purchase_order_id: ORDER, date_from: "2026-11-01", date_to: "2026-11-30", q: "dn", limit: "50", offset: "0",
    });
    fetchMock.mockClear();
    await listReceipts(request("GET", undefined, { query: "?status=bogus" }));
    expect(new URL(upstream().url).searchParams.has("status")).toBe(false);
    expect((await listReceipts(request("GET", undefined, { query: "?supplierId=nope" }))).status).toBe(404);
    expect((await listReceipts(request("GET", undefined, { query: "?dateFrom=nope" }))).status).toBe(400);
    expect((await listReceipts(request("GET", undefined, { cookie: null }))).status).toBe(401);
  });
});

describe("goods receipts: confirming and cancelling", () => {
  it("confirm answers 200 with confirmed=true", async () => {
    stub(() => json(200, { id: ID, status: "confirmed" }));
    const res = await receiptAction(request("POST"), params({ action: "confirm" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ receipt: { id: ID, status: "confirmed" }, confirmed: true });
    expect(upstream().url).toBe(`${PURCHASING}/api/v1/purchasing/goods-receipts/${ID}/confirm`);
    expect(upstream().init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });

  it("an unverified posting is a 202 with confirmed=false, not an error", async () => {
    stub(() => json(202, { id: ID, status: "posting" }));
    const res = await receiptAction(request("POST"), params({ action: "confirm" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ receipt: { id: ID, status: "posting" }, confirmed: false });
  });

  it("a definitive refusal keeps its code and message", async () => {
    stub(() => json(409, { detail: { message: "Nothing was added.", code: "inventory_rejected" } }));
    const res = await receiptAction(request("POST"), params({ action: "confirm" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Nothing was added.", code: "inventory_rejected" });
  });

  it("cancel goes to the cancel endpoint", async () => {
    stub(() => json(200, { id: ID, status: "cancelled" }));
    await receiptAction(request("POST"), params({ action: "cancel" }));
    expect(upstream().url).toBe(`${PURCHASING}/api/v1/purchasing/goods-receipts/${ID}/cancel`);
  });

  it("only confirm and cancel exist; ids are checked; a session is required; an expired one is a 401", async () => {
    expect((await receiptAction(request("POST"), params({ action: "delete" }))).status).toBe(404);
    expect((await receiptAction(request("POST"), params({ action: "post" }))).status).toBe(404);
    expect((await receiptAction(request("POST"), { params: { id: "x", action: "confirm" } })).status).toBe(404);
    expect((await receiptAction(request("POST", undefined, { cookie: null }), params({ action: "confirm" }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    stub(() => json(401, { detail: "expired" }));
    expect((await receiptAction(request("POST"), params({ action: "confirm" }))).status).toBe(401);
  });

  it("never talks to the Inventory Service itself", async () => {
    stub(() => json(200, { id: ID }));
    await receiptAction(request("POST"), params({ action: "confirm" }));
    await createReceipt(request("POST", { purchaseOrderId: ORDER }, { key: KEY }));
    for (const call of fetchMock.mock.calls) expect(String(call[0])).toContain("/api/v1/purchasing/");
  });
});
