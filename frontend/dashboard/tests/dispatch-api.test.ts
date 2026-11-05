import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeSalesFailure } from "@/lib/sales";
import { percent } from "@/lib/sales-browser";
import { parseDispatchLines } from "@/lib/sales-routes";
import { GET as listDispatches, POST as createDispatch } from "@/app/api/sales/dispatches/route";
import { GET as getDispatch, PATCH as editDispatch } from "@/app/api/sales/dispatches/[id]/route";
import { PUT as saveLines } from "@/app/api/sales/dispatches/[id]/lines/route";
import { POST as dispatchAction } from "@/app/api/sales/dispatches/[id]/[action]/route";
import { GET as listLists } from "@/app/api/sales/delivery-lists/route";

const ID = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718";
const ITEM = "11111111-1111-4111-8111-111111111111";
const ITEM2 = "11111111-1111-4111-8111-222222222222";
const WAREHOUSE = "33333333-3333-4333-8333-333333333333";
const LIST = "44444444-4444-4444-8444-444444444444";
const TOKEN = "session-token-abc";
const SALES = "http://sales-service:8003";
const KEY = "ui-3f2b8c1e-0000-4000-8000-000000000001";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
const stub = (handler: (url: string, init: any) => Response) => {
  fetchMock = vi.fn(async (url: any, init: any) => handler(String(url), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
};
const request = (method: string, body?: unknown, { cookie = `impex_tenant_session=${TOKEN}`, query = "", key }: { cookie?: string | null; query?: string; key?: string } = {}) =>
  new NextRequest(`http://localhost:3001/api/sales/x${query}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const upstream = () => ({ url: fetchMock.mock.calls[0][0] as string, init: fetchMock.mock.calls[0][1] as any });
const sentBody = () => JSON.parse(upstream().init.body);
const params = (extra: Record<string, string> = {}) => ({ params: { id: ID, ...extra } });

beforeEach(() => {
  process.env.SALES_SERVICE_URL = SALES;
  stub(() => json(200, {}));
});
afterEach(() => vi.unstubAllGlobals());

describe("progress", () => {
  it.each([["0", "15", 0], ["10", "15", 66], ["15", "15", 100], ["5.5", "11", 50], ["0.0001", "100000000000000", 0], ["20", "15", 100], ["1", "0", 0]])("%s of %s is %i%%", (part, whole, expected) => {
    expect(percent(part, whole)).toBe(expected);
  });
});

describe("failure mapping for dispatches", () => {
  it("passes the over-dispatch, insufficient-stock and Inventory-refusal codes through", () => {
    for (const code of ["over_dispatch", "insufficient_stock", "inventory_rejected"]) {
      expect(describeSalesFailure({ status: 409, data: { detail: { message: "No.", code } } })).toMatchObject({ status: 409, code, message: "No." });
    }
  });
  it("maps dispatch field names for the form", () => {
    const failure = describeSalesFailure({ status: 422, data: { detail: [{ loc: ["body", "lines", 0, "warehouse_id"], msg: "bad" }, { loc: ["body", "dispatch_date"], msg: "Value error, worse" }] } });
    expect(failure.fieldErrors).toEqual({ warehouseId: "bad", dispatchDate: "worse" });
  });
});

const lineBody = (extra: Record<string, unknown> = {}) => ({ deliveryListItemId: ITEM, warehouseId: WAREHOUSE, quantity: "10", ...extra });

describe("parseDispatchLines", () => {
  it("keeps only the item, the warehouse and an exact quantity string", () => {
    expect(parseDispatchLines([lineBody({ unit: "box", productName: "x", organizationId: "evil", status: "confirmed" })])).toEqual({
      ok: true, lines: [{ delivery_list_item_id: ITEM, warehouse_id: WAREHOUSE, quantity: "10" }],
    });
  });
  it.each([
    ["not a list", "all"], ["a non-object line", [5]], ["a bad item id", [lineBody({ deliveryListItemId: "x" })]], ["a bad warehouse", [lineBody({ warehouseId: "x" })]],
    ["a numeric quantity", [lineBody({ quantity: 10 })]], ["a zero quantity", [lineBody({ quantity: "0" })]], ["a negative quantity", [lineBody({ quantity: "-1" })]],
    ["too many decimals", [lineBody({ quantity: "1.00001" })]], ["an exponent", [lineBody({ quantity: "1e3" })]], ["501 lines", Array.from({ length: 501 }, () => lineBody())],
  ])("refuses %s", (_name, value) => {
    expect(parseDispatchLines(value).ok).toBe(false);
  });
});

describe("dispatches: creating a draft", () => {
  it("sends only the allowed fields, the caller's token and the idempotency key", async () => {
    stub(() => json(201, { id: ID, number: "DS-000001", status: "draft" }));
    const res = await createDispatch(request("POST", {
      deliveryListId: LIST, dispatchDate: "2026-11-07", deliveryAddress: " 1 Dock Rd ", transportDetails: "  Truck   4 ", trackingReference: " TRK  9 ", notes: "n",
      lines: [lineBody({ unit: "box" })], organization_id: "evil", status: "confirmed", number: "DS-9", clientId: "evil",
    }, { key: KEY }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ dispatch: { number: "DS-000001" }, replayed: false });
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/dispatches`);
    expect(upstream().init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "Idempotency-Key": KEY });
    expect(sentBody()).toEqual({
      delivery_list_id: LIST, dispatch_date: "2026-11-07", delivery_address: "1 Dock Rd", transport_details: "Truck 4", tracking_reference: "TRK 9", notes: "n",
      lines: [{ delivery_list_item_id: ITEM, warehouse_id: WAREHOUSE, quantity: "10" }],
    });
  });

  it("a retry is reported as a replay", async () => {
    stub(() => json(200, { id: ID }));
    const res = await createDispatch(request("POST", { deliveryListId: LIST }, { key: KEY }));
    expect(res.status).toBe(200);
    expect((await res.json()).replayed).toBe(true);
  });

  it.each([
    ["no key", { deliveryListId: LIST }, undefined, 400],
    ["a bad key", { deliveryListId: LIST }, "short", 400],
    ["a bad list id", { deliveryListId: "nope" }, KEY, 404],
    ["a bad date", { deliveryListId: LIST, dispatchDate: "2026-13-45" }, KEY, 400],
    ["a bad quantity", { deliveryListId: LIST, lines: [lineBody({ quantity: "1e3" })] }, KEY, 400],
    ["a bad item id", { deliveryListId: LIST, lines: [lineBody({ deliveryListItemId: "x" })] }, KEY, 400],
    ["a missing warehouse", { deliveryListId: LIST, lines: [lineBody({ warehouseId: "" })] }, KEY, 400],
    ["lines that are not a list", { deliveryListId: LIST, lines: "all" }, KEY, 400],
    ["too many lines", { deliveryListId: LIST, lines: Array.from({ length: 501 }, () => lineBody()) }, KEY, 400],
    ["a long note", { deliveryListId: LIST, notes: "x".repeat(2001) }, KEY, 400],
    ["a long address", { deliveryListId: LIST, deliveryAddress: "x".repeat(1001) }, KEY, 400],
    ["a long tracking number", { deliveryListId: LIST, trackingReference: "x".repeat(101) }, KEY, 400],
  ])("refuses %s without calling the service", async (_name, body, key, status) => {
    const res = await createDispatch(request("POST", body, { key }));
    expect(res.status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs a session and JSON", async () => {
    expect((await createDispatch(request("POST", { deliveryListId: LIST }, { cookie: null, key: KEY }))).status).toBe(401);
    expect((await createDispatch(request("POST", "not json", { key: KEY }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relays the service's explanation for an over-dispatch, with its code", async () => {
    stub(() => json(409, { detail: { message: "You cannot dispatch 16 pcs of Bolt", code: "over_dispatch" } }));
    const res = await createDispatch(request("POST", { deliveryListId: LIST, lines: [lineBody()] }, { key: KEY }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "You cannot dispatch 16 pcs of Bolt", code: "over_dispatch" });
  });

  it("explains an outage", async () => {
    stub(() => { throw new Error("connection refused"); });
    expect((await createDispatch(request("POST", { deliveryListId: LIST }, { key: KEY }))).status).toBe(503);
  });
});

describe("dispatches: lines, header, reading", () => {
  it("replaces the lines with a PUT of exactly the allowed fields", async () => {
    stub(() => json(200, { id: ID }));
    const res = await saveLines(request("PUT", { lines: [lineBody(), lineBody({ deliveryListItemId: ITEM2, quantity: "2.5" })], organization_id: "evil" }), params());
    expect(res.status).toBe(200);
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/dispatches/${ID}/lines`);
    expect(upstream().init.method).toBe("PUT");
    expect(sentBody()).toEqual({ lines: [
      { delivery_list_item_id: ITEM, warehouse_id: WAREHOUSE, quantity: "10" }, { delivery_list_item_id: ITEM2, warehouse_id: WAREHOUSE, quantity: "2.5" },
    ] });
  });

  it("refuses bad input, a bad id and a missing session before calling the service", async () => {
    expect((await saveLines(request("PUT", { lines: [lineBody({ quantity: "-1" })] }), params())).status).toBe(400);
    expect((await saveLines(request("PUT", { nothing: true }), params())).status).toBe(400);
    expect((await saveLines(request("PUT", { lines: [] }), { params: { id: "x" } })).status).toBe(404);
    expect((await saveLines(request("PUT", { lines: [] }, { cookie: null }), params())).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("edits only the date, address, transport, tracking and notes", async () => {
    stub(() => json(200, { id: ID }));
    await editDispatch(request("PATCH", { dispatchDate: "2026-11-05", deliveryAddress: "Gate 5", transportDetails: " Van  2 ", trackingReference: " T-1 ", notes: "late", status: "confirmed", deliveryListId: LIST }), params());
    expect(sentBody()).toEqual({ dispatch_date: "2026-11-05", delivery_address: "Gate 5", transport_details: "Van 2", tracking_reference: "T-1", notes: "late" });
    fetchMock.mockClear();
    expect((await editDispatch(request("PATCH", { status: "confirmed" }), params())).status).toBe(400);
    expect((await editDispatch(request("PATCH", { dispatchDate: "soon" }), params())).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads one dispatch, and another organization's dispatch is a plain 404", async () => {
    stub(() => json(200, { id: ID, number: "DS-000001" }));
    expect(await (await getDispatch(request("GET"), params())).json()).toEqual({ dispatch: { id: ID, number: "DS-000001" } });
    stub(() => json(404, { detail: "Dispatch not found." }));
    const missing = await getDispatch(request("GET"), params());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "Dispatch not found." });
    expect((await getDispatch(request("GET"), { params: { id: "nope" } })).status).toBe(404);
  });

  it("lists with whitelisted parameters only", async () => {
    stub(() => json(200, { items: [], total: 0, limit: 50, offset: 0 }));
    await listDispatches(request("GET", undefined, { query: `?status=confirmed&clientId=${ID}&warehouseId=${WAREHOUSE}&deliveryListId=${LIST}&dateFrom=2026-11-01&dateTo=2026-11-30&q=%20trk&organization_id=evil&sort=x` }));
    expect(Object.fromEntries(new URL(upstream().url).searchParams)).toEqual({
      status: "confirmed", client_id: ID, warehouse_id: WAREHOUSE, delivery_list_id: LIST, date_from: "2026-11-01", date_to: "2026-11-30", q: "trk", limit: "50", offset: "0",
    });
    fetchMock.mockClear();
    await listDispatches(request("GET", undefined, { query: "?status=bogus" }));
    expect(new URL(upstream().url).searchParams.has("status")).toBe(false);
    expect((await listDispatches(request("GET", undefined, { query: "?clientId=nope" }))).status).toBe(404);
    expect((await listDispatches(request("GET", undefined, { query: "?dateFrom=nope" }))).status).toBe(400);
    expect((await listDispatches(request("GET", undefined, { cookie: null }))).status).toBe(401);
  });

  it("the delivery-list route now understands the new statuses and still ignores unknown ones", async () => {
    stub(() => json(200, { items: [], total: 0, limit: 50, offset: 0 }));
    for (const status of ["ready", "partially_dispatched", "dispatched"]) {
      fetchMock.mockClear();
      await listLists(request("GET", undefined, { query: `?status=${status}` }));
      expect(new URL(upstream().url).searchParams.get("status")).toBe(status);
    }
  });
});

describe("dispatches: confirming and cancelling", () => {
  it("confirm answers 200 with confirmed=true", async () => {
    stub(() => json(200, { id: ID, status: "confirmed" }));
    const res = await dispatchAction(request("POST"), params({ action: "confirm" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatch: { id: ID, status: "confirmed" }, confirmed: true });
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/dispatches/${ID}/confirm`);
    expect(upstream().init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });

  it("an unverified posting is a 202 with confirmed=false, not an error", async () => {
    stub(() => json(202, { id: ID, status: "posting" }));
    const res = await dispatchAction(request("POST"), params({ action: "confirm" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ dispatch: { id: ID, status: "posting" }, confirmed: false });
  });

  it("a definitive refusal keeps its code and message", async () => {
    stub(() => json(409, { detail: { message: "Not enough stock.", code: "insufficient_stock" } }));
    const res = await dispatchAction(request("POST"), params({ action: "confirm" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Not enough stock.", code: "insufficient_stock" });
  });

  it("only confirm and cancel exist; ids are checked; a session is required; an expired one is a 401", async () => {
    expect((await dispatchAction(request("POST"), params({ action: "delete" }))).status).toBe(404);
    expect((await dispatchAction(request("POST"), params({ action: "post" }))).status).toBe(404);
    expect((await dispatchAction(request("POST"), { params: { id: "x", action: "confirm" } })).status).toBe(404);
    expect((await dispatchAction(request("POST", undefined, { cookie: null }), params({ action: "confirm" }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    stub(() => json(401, { detail: "expired" }));
    expect((await dispatchAction(request("POST"), params({ action: "confirm" }))).status).toBe(401);
  });

  it("never talks to the Inventory Service itself", async () => {
    stub(() => json(200, { id: ID }));
    await dispatchAction(request("POST"), params({ action: "confirm" }));
    await createDispatch(request("POST", { deliveryListId: LIST }, { key: KEY }));
    for (const call of fetchMock.mock.calls) expect(String(call[0])).toContain("/api/v1/sales/");
  });
});
