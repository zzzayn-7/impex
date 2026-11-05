import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addDecimal, api, exceeds, qty, shortfall } from "@/lib/sales-browser";
import { describeSalesFailure } from "@/lib/sales";
import { GET as listClients, POST as createClient } from "@/app/api/sales/clients/route";
import { PATCH as editClient } from "@/app/api/sales/clients/[id]/route";
import { POST as clientAction } from "@/app/api/sales/clients/[id]/[action]/route";
import { GET as listLists, POST as createList } from "@/app/api/sales/delivery-lists/route";
import { GET as getList, PATCH as editList } from "@/app/api/sales/delivery-lists/[id]/route";
import { POST as listAction } from "@/app/api/sales/delivery-lists/[id]/[action]/route";
import { POST as addItem } from "@/app/api/sales/delivery-lists/[id]/items/route";
import { DELETE as removeItem, PATCH as editItem } from "@/app/api/sales/delivery-lists/[id]/items/[itemId]/route";
import { POST as increaseItem } from "@/app/api/sales/delivery-lists/[id]/items/[itemId]/increase/route";

const ID = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718";
const ITEM = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "22222222-2222-4222-8222-222222222222";
const WAREHOUSE = "33333333-3333-4333-8333-333333333333";
const TOKEN = "session-token-abc";
const SALES = "http://sales-service:8003";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
const stub = (handler: (url: string, init: any) => Response) => {
  fetchMock = vi.fn(async (url: any, init: any) => handler(String(url), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
};
const request = (method: string, body?: unknown, { cookie = `impex_tenant_session=${TOKEN}`, type = "application/json", query = "" }: { cookie?: string | null; type?: string | null; query?: string } = {}) =>
  new NextRequest(`http://localhost:3001/api/sales/x${query}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(type && body !== undefined ? { "content-type": type } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const upstream = () => ({ url: fetchMock.mock.calls[0][0] as string, init: fetchMock.mock.calls[0][1] as any });
const sentBody = () => JSON.parse(upstream().init.body);

beforeEach(() => {
  process.env.SALES_SERVICE_URL = SALES;
  stub(() => json(200, {}));
});
afterEach(() => vi.unstubAllGlobals());

describe("exact decimal helpers (strings in, strings out)", () => {
  it("adds without floating point", () => {
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
    expect(addDecimal("5", "8.5")).toBe("13.5");
    expect(addDecimal("5.0000", "3")).toBe("8.0000");
    expect(addDecimal("99999999999999.9999", "0.0001")).toBe("100000000000000.0000");
  });
  it("compares exactly", () => {
    expect(exceeds("40.0001", "40")).toBe(true);
    expect(exceeds("40", "40.0000")).toBe(false);
    expect(exceeds("0.3", "0.30")).toBe(false);
    expect(shortfall("100", "40")).toBe("60");
    expect(shortfall("1.5", "0.25")).toBe("1.25");
    expect(shortfall("5", "5")).toBe("0");
  });
  it("formats quantities", () => {
    expect(qty("1234.5000")).toBe("1,234.5");
    expect(qty("10.0000")).toBe("10");
    expect(qty("0.1000")).toBe("0.1");
  });
  it("api() turns network failures and error bodies into a friendly result", async () => {
    const offline = await api("/x", {}, vi.fn(async () => { throw new Error("down"); }) as any);
    expect(offline).toMatchObject({ ok: false, status: 0 });
    expect(offline.error).toContain("Unable to reach");
    const dup = await api("/x", {}, vi.fn(async () => json(409, { error: "dup", code: "duplicate_item", item: { id: "i" } })) as any);
    expect(dup).toMatchObject({ ok: false, status: 409, error: "dup", code: "duplicate_item" });
  });
});

describe("failure mapping", () => {
  it("passes the duplicate-line detail through", () => {
    const failure = describeSalesFailure({ status: 409, data: { detail: { message: "already on this list", code: "duplicate_item", item: { id: ITEM, quantity: "5.0000", unit: "pcs", product_name: "Bolt" } } } });
    expect(failure).toMatchObject({ status: 409, message: "already on this list", code: "duplicate_item", item: { id: ITEM } });
  });
  it("maps statuses to safe messages", () => {
    expect(describeSalesFailure(null).status).toBe(503);
    expect(describeSalesFailure({ status: 500, data: { detail: "Traceback secret.py" } })).toEqual({ status: 502, message: "The request could not be completed. Please try again." });
    expect(describeSalesFailure({ status: 422, data: { detail: [{ loc: ["body", "client_id"], msg: "Value error, bad" }] } }).fieldErrors).toEqual({ clientId: "bad" });
    expect(describeSalesFailure({ status: 404, data: {} }, "Nope.").message).toBe("Nope.");
  });
});

describe("every Sales route is protected by the tenant session", () => {
  const ctx = { params: { id: ID, itemId: ITEM, action: "ready" } };
  it.each([
    ["list clients", () => listClients(request("GET", undefined, { cookie: null }))],
    ["create client", () => createClient(request("POST", { name: "A" }, { cookie: null }))],
    ["edit client", () => editClient(request("PATCH", { name: "A" }, { cookie: null }), ctx)],
    ["client action", () => clientAction(request("POST", undefined, { cookie: null }), { params: { id: ID, action: "deactivate" } })],
    ["list lists", () => listLists(request("GET", undefined, { cookie: null }))],
    ["create list", () => createList(request("POST", { clientId: ID }, { cookie: null }))],
    ["get list", () => getList(request("GET", undefined, { cookie: null }), ctx)],
    ["edit list", () => editList(request("PATCH", { notes: "x" }, { cookie: null }), ctx)],
    ["list action", () => listAction(request("POST", undefined, { cookie: null }), ctx)],
    ["add item", () => addItem(request("POST", { productId: PRODUCT, quantity: "1" }, { cookie: null }), ctx)],
    ["edit item", () => editItem(request("PATCH", { quantity: "1" }, { cookie: null }), ctx)],
    ["remove item", () => removeItem(request("DELETE", undefined, { cookie: null }), ctx)],
    ["increase item", () => increaseItem(request("POST", { quantity: "1" }, { cookie: null }), ctx)],
  ])("%s without a session answers 401 and calls nothing", async (_name, call) => {
    expect((await call()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not accept the Super Admin portal's cookie", async () => {
    expect((await addItem(request("POST", { productId: PRODUCT, quantity: "1" }, { cookie: "impex_session=super" }), { params: { id: ID } })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the HttpOnly session token as the Bearer token and nothing that names an organization", async () => {
    await createList(request("POST", { clientId: ID, organization_id: "evil", organizationId: "evil" }));
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(sentBody())).not.toMatch(/organization|tenant/i);
    expect(upstream().url).not.toMatch(/organization|tenant/i);
  });
});

describe("clients", () => {
  it("lists with whitelisted parameters only", async () => {
    stub(() => json(200, { items: [], total: 0, limit: 50, offset: 0 }));
    await listClients(request("GET", undefined, { query: "?q=acme&status=all&limit=9999&organization_id=evil&offset=-5" }));
    const url = new URL(upstream().url);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "acme", status: "all", limit: "200", offset: "0" });
  });

  it("registers a client: trims, maps field names, forwards only the known fields", async () => {
    stub(() => json(201, { id: ID, name: "Acme Ltd" }));
    const res = await createClient(request("POST", { name: "  Acme   Ltd ", contactPerson: " Jane ", email: "j@a.example", phone: "1", address: "x", is_active: false, organization_id: "evil" }));
    expect(res.status).toBe(201);
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/clients`);
    expect(sentBody()).toEqual({ name: "Acme Ltd", contact_person: "Jane", email: "j@a.example", phone: "1", address: "x" });
  });

  it.each([[{}, "name"], [{ name: "  " }, "name"], [{ name: "x".repeat(256) }, "name"], [{ name: "A", email: "bad" }, "email"], [{ name: "A", phone: "1".repeat(51) }, "phone"]])(
    "rejects %j on the %s field without calling the service", async (body, field) => {
      const res = await createClient(request("POST", body));
      expect(res.status).toBe(400);
      expect((await res.json()).fieldErrors).toHaveProperty(field);
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it("shows a duplicate name under the Name field", async () => {
    stub(() => json(409, { detail: "A client named 'Acme' already exists in your directory." }));
    const res = await createClient(request("POST", { name: "Acme" }));
    expect(res.status).toBe(409);
    expect((await res.json()).fieldErrors.name).toContain("already exists");
  });

  it("edits only the fields sent, rejects empty edits and bad ids, and (de)activates", async () => {
    stub(() => json(200, { id: ID }));
    await editClient(request("PATCH", { phone: "555", organization_id: "evil" }), { params: { id: ID } });
    expect(sentBody()).toEqual({ phone: "555" });
    expect((await editClient(request("PATCH", {}), { params: { id: ID } })).status).toBe(400);
    expect((await editClient(request("PATCH", { name: "A" }), { params: { id: "nope" } })).status).toBe(404);
    expect((await clientAction(request("POST"), { params: { id: ID, action: "delete" } })).status).toBe(404);
    fetchMock.mockClear();
    expect((await clientAction(request("POST"), { params: { id: ID, action: "deactivate" } })).status).toBe(200);
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/clients/${ID}/deactivate`);
  });
});

describe("delivery lists", () => {
  it("creates a draft: only the client, reference and notes are read", async () => {
    stub(() => json(201, { id: ID, number: "DL-000001" }));
    const res = await createList(request("POST", { clientId: ID, externalReference: " PO  1 ", notes: "n", status: "ready", number: "DL-9", created_by: "x" }));
    expect(res.status).toBe(201);
    expect(sentBody()).toEqual({ client_id: ID, external_reference: "PO 1", notes: "n" });
  });

  it.each([[{}], [{ clientId: "nope" }], [{ clientId: ID, externalReference: "x".repeat(101) }], [{ clientId: ID, notes: "x".repeat(2001) }]])(
    "rejects %j without calling the service", async (body) => {
      expect((await createList(request("POST", body))).status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it("refuses a list for an inactive client with the service's message", async () => {
    stub(() => json(409, { detail: "Acme is inactive. Reactivate the client before creating a delivery list for them." }));
    const res = await createList(request("POST", { clientId: ID }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("inactive");
  });

  it("filters with whitelisted parameters, ignoring anything else", async () => {
    stub(() => json(200, { items: [], total: 0, limit: 50, offset: 0 }));
    await listLists(request("GET", undefined, { query: `?status=draft&clientId=${ID}&q=po&organization_id=evil&sort=x` }));
    expect(Object.fromEntries(new URL(upstream().url).searchParams)).toEqual({ status: "draft", client_id: ID, q: "po", limit: "50", offset: "0" });
    fetchMock.mockClear();
    await listLists(request("GET", undefined, { query: "?status=shipped" }));
    expect(new URL(upstream().url).searchParams.has("status")).toBe(false);
    expect((await listLists(request("GET", undefined, { query: "?clientId=nope" }))).status).toBe(404);
  });

  it("reads one list, edits reference and notes, and cannot change status or client that way", async () => {
    stub(() => json(200, { id: ID }));
    expect((await getList(request("GET"), { params: { id: ID } })).status).toBe(200);
    fetchMock.mockClear();
    await editList(request("PATCH", { externalReference: "NEW", notes: "n", status: "ready", clientId: ITEM }), { params: { id: ID } });
    expect(sentBody()).toEqual({ external_reference: "NEW", notes: "n" });
    expect((await editList(request("PATCH", {}), { params: { id: ID } })).status).toBe(400);
    expect((await getList(request("GET"), { params: { id: "../x" } })).status).toBe(404);
  });

  it.each(["ready", "cancel", "reopen"])("%s calls the matching endpoint (and only that)", async (action) => {
    stub(() => json(200, { id: ID, status: "ready" }));
    expect((await listAction(request("POST"), { params: { id: ID, action } })).status).toBe(200);
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/delivery-lists/${ID}/${action}`);
    expect(upstream().init.method).toBe("POST");
  });

  it.each(["dispatch", "deduct", "reserve", "delete", "items"])("has no %s action", async (action) => {
    expect((await listAction(request("POST"), { params: { id: ID, action } })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relays a refused status change with its message", async () => {
    stub(() => json(409, { detail: "Add at least one product before marking the list Ready." }));
    const res = await listAction(request("POST"), { params: { id: ID, action: "ready" } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("at least one product");
  });
});

describe("items", () => {
  const ctx = { params: { id: ID } };

  it("adds a product with an explicit quantity, forwarding ONLY the id, quantity and warehouse", async () => {
    stub(() => json(201, { item: { id: ITEM }, item_count: 1 }));
    const res = await addItem(request("POST", {
      productId: PRODUCT, quantity: " 12.5 ", plannedWarehouseId: WAREHOUSE,
      productName: "Hacked", productSku: "X", unit: "kg", available_quantity: "9999", stock: { a: 1 }, organization_id: "evil",
    }), ctx);
    expect(res.status).toBe(201);
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/delivery-lists/${ID}/items`);
    expect(sentBody()).toEqual({ product_id: PRODUCT, quantity: "12.5", planned_warehouse_id: WAREHOUSE });
  });

  it("keeps the quantity an exact string", async () => {
    stub(() => json(201, { item: {}, item_count: 1 }));
    await addItem(request("POST", { productId: PRODUCT, quantity: "0.1000" }), ctx);
    expect(upstream().init.body).toContain('"quantity":"0.1000"');
  });

  it.each([
    ["no quantity", { productId: PRODUCT }, "quantity"], ["zero", { productId: PRODUCT, quantity: "0" }, "quantity"], ["negative", { productId: PRODUCT, quantity: "-3" }, "quantity"],
    ["text", { productId: PRODUCT, quantity: "lots" }, "quantity"], ["a JSON number", { productId: PRODUCT, quantity: 5 }, "quantity"],
    ["too many decimals", { productId: PRODUCT, quantity: "1.00001" }, "quantity"], ["no product", { quantity: "1" }, "productId"],
    ["bad product id", { productId: "nope", quantity: "1" }, "productId"], ["bad warehouse", { productId: PRODUCT, quantity: "1", plannedWarehouseId: "nope" }, "plannedWarehouseId"],
  ])("rejects %s without calling the service", async (_name, body, field) => {
    const res = await addItem(request("POST", body), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors).toHaveProperty(field);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a duplicate-line answer on with the existing line, so the user can choose", async () => {
    const item = { id: ITEM, quantity: "5.0000", unit: "pcs", product_name: "Steel bolt" };
    stub(() => json(409, { detail: { message: "Steel bolt is already on this list with a quantity of 5 pcs.", code: "duplicate_item", item } }));
    const res = await addItem(request("POST", { productId: PRODUCT, quantity: "3" }), ctx);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: "duplicate_item", item, error: expect.stringContaining("already on this list") });
  });

  it.each([[404, "Product not found."], [409, "Old widget is archived and cannot be added to a delivery list."], [422, "Quantity must be a whole number: Bolt is counted in 'pcs'."], [503, "The inventory service is unavailable"]])(
    "relays the service's answer %i readably", async (status, detail) => {
      stub(() => json(status, { detail }));
      const res = await addItem(request("POST", { productId: PRODUCT, quantity: "1" }), ctx);
      expect(res.status).toBe(status === 422 ? 400 : status);
      expect((await res.json()).error).toContain(detail.slice(0, 20));
    });

  it("sets and increases quantities explicitly, and removes a line", async () => {
    const both = { params: { id: ID, itemId: ITEM } };
    stub(() => json(200, { item: {}, item_count: 1 }));
    await editItem(request("PATCH", { quantity: "8", product_name: "x" }), both);
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/delivery-lists/${ID}/items/${ITEM}`);
    expect(sentBody()).toEqual({ quantity: "8" });
    fetchMock.mockClear();
    await editItem(request("PATCH", { plannedWarehouseId: null }), both);
    expect(sentBody()).toEqual({ planned_warehouse_id: null });
    fetchMock.mockClear();
    await increaseItem(request("POST", { quantity: "3" }), both);
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/delivery-lists/${ID}/items/${ITEM}/increase`);
    expect(sentBody()).toEqual({ quantity: "3" });
    fetchMock.mockClear();
    stub(() => new Response(null, { status: 204 }));
    const removed = await removeItem(request("DELETE"), both);
    expect(removed.status).toBe(200);
    expect(upstream().init.method).toBe("DELETE");
  });

  it("validates item edits before calling the service", async () => {
    const both = { params: { id: ID, itemId: ITEM } };
    expect((await editItem(request("PATCH", {}), both)).status).toBe(400);
    expect((await editItem(request("PATCH", { quantity: "0" }), both)).status).toBe(400);
    expect((await editItem(request("PATCH", { quantity: "1" }), { params: { id: ID, itemId: "bad" } })).status).toBe(404);
    expect((await increaseItem(request("POST", { quantity: "-1" }), both)).status).toBe(400);
    expect((await removeItem(request("DELETE"), { params: { id: "bad", itemId: ITEM } })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 without leaking details when the Sales Service is down", async () => {
    stub(() => { throw new Error("connect ECONNREFUSED 10.0.0.9:8003"); });
    const res = await addItem(request("POST", { productId: PRODUCT, quantity: "1" }), ctx);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.9");
  });
});
