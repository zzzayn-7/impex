import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lineTotal, sumDecimals, validatePrice } from "@/lib/purchasing-browser";
import { describePurchasingFailure } from "@/lib/purchasing";
import { GET as listSuppliers, POST as createSupplier } from "@/app/api/purchasing/suppliers/route";
import { GET as getSupplier, PATCH as editSupplier } from "@/app/api/purchasing/suppliers/[id]/route";
import { POST as supplierAction } from "@/app/api/purchasing/suppliers/[id]/[action]/route";
import { GET as listOrders, POST as createOrder } from "@/app/api/purchasing/purchase-orders/route";
import { GET as getOrder, PATCH as editOrder } from "@/app/api/purchasing/purchase-orders/[id]/route";
import { POST as orderAction } from "@/app/api/purchasing/purchase-orders/[id]/[action]/route";
import { POST as addLine } from "@/app/api/purchasing/purchase-orders/[id]/lines/route";
import { DELETE as removeLine, PATCH as editLine } from "@/app/api/purchasing/purchase-orders/[id]/lines/[lineId]/route";

const ID = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718";
const LINE = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "22222222-2222-4222-8222-222222222222";
const WAREHOUSE = "33333333-3333-4333-8333-333333333333";
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

beforeEach(() => {
  process.env.PURCHASING_SERVICE_URL = PURCHASING;
  stub(() => json(200, {}));
});
afterEach(() => vi.unstubAllGlobals());

describe("exact money (the same vectors the Purchasing Service is tested with)", () => {
  it.each([
    ["50", "1.25", "62.5000"], ["3", "0.3333", "0.9999"], ["0.1", "0.2", "0.0200"], ["7", "0.1", "0.7000"], ["0.3333", "0.0001", "0.0000"], ["0.5", "0.0001", "0.0001"],
    ["0.4999", "0.0001", "0.0000"], ["1.5", "0.0003", "0.0005"], ["2", "49999999999999.9999", "99999999999999.9998"], ["99999999999999", "0", "0.0000"], ["2.5", "3.10", "7.7500"],
  ])("%s x %s = %s", (quantity, price, expected) => {
    expect(lineTotal(quantity, price)).toBe(expected);
  });

  it("matches a straightforward half-up reference for many values (no floats anywhere)", () => {
    const pow10 = (n: number) => BigInt("1" + "0".repeat(n));
    const reference = (q: string, p: string) => {
      const scale = (v: string) => (v.split(".")[1] ?? "").length;
      const digits = (v: string) => BigInt(v.replace(".", ""));
      const exact = digits(q) * digits(p); // scaled by 10^(scale(q)+scale(p))
      const s = scale(q) + scale(p);
      const target = 4;
      let value: bigint;
      if (s <= target) value = exact * pow10(target - s);
      else { const d = pow10(s - target); value = (exact + d / BigInt(2)) / d; }
      const text = value.toString().padStart(5, "0");
      return `${text.slice(0, -4)}.${text.slice(-4)}`;
    };
    for (let i = 1; i < 400; i++) {
      const q = `${(i * 37) % 500}.${String((i * 7919) % 10000).padStart(4, "0")}`;
      const p = `${(i * 13) % 90}.${String((i * 104729) % 10000).padStart(4, "0")}`;
      expect(lineTotal(q, p)).toBe(reference(q, p));
    }
  });

  it("adds exactly", () => {
    expect(sumDecimals(["62.5000", "7.7500"])).toBe("70.2500");
    expect(sumDecimals(["0.0001", "0.0002", "0.0003"])).toBe("0.0006");
    expect(sumDecimals([])).toBe("0.0000");
    expect(sumDecimals(["99999999999999.9999", "0.0001"])).toBe("100000000000000.0000");
  });

  it.each([["", "Enter"], ["abc", "at most 4 decimals"], ["-1", "at most 4 decimals"], ["1.00001", "at most 4 decimals"], ["1e3", "at most 4 decimals"], ["1,5", "at most 4 decimals"]])("rejects the price %j", (value, hint) => {
    expect(validatePrice(value)).toContain(hint);
  });
  it.each(["0", "0.0", "1", "12.5", "0.0001", "99999999999999.9999"])("accepts the price %j (zero is allowed)", (value) => {
    expect(validatePrice(value)).toBeUndefined();
  });
});

describe("failure mapping", () => {
  it("passes the duplicate-line detail through", () => {
    const line = { id: LINE, quantity: "5.0000", unit: "pcs", unit_price: "1.2500", product_name: "Bolt" };
    expect(describePurchasingFailure({ status: 409, data: { detail: { message: "already on this order", code: "duplicate_line", line } } })).toMatchObject({ status: 409, code: "duplicate_line", line: { id: LINE } });
  });
  it("maps statuses to safe messages", () => {
    expect(describePurchasingFailure(null).status).toBe(503);
    expect(describePurchasingFailure({ status: 500, data: { detail: "Traceback secret.py" } })).toEqual({ status: 502, message: "The request could not be completed. Please try again." });
    expect(describePurchasingFailure({ status: 422, data: { detail: [{ loc: ["body", "unit_price"], msg: "Value error, bad" }] } }).fieldErrors).toEqual({ unitPrice: "bad" });
    expect(describePurchasingFailure({ status: 404, data: {} }, "Nope.").message).toBe("Nope.");
  });
});

describe("every Purchasing route is protected by the tenant session", () => {
  const ctx = { params: { id: ID, lineId: LINE, action: "order" } };
  it.each([
    ["list suppliers", () => listSuppliers(request("GET", undefined, { cookie: null }))],
    ["create supplier", () => createSupplier(request("POST", { name: "A" }, { cookie: null }))],
    ["get supplier", () => getSupplier(request("GET", undefined, { cookie: null }), ctx)],
    ["edit supplier", () => editSupplier(request("PATCH", { name: "A" }, { cookie: null }), ctx)],
    ["supplier action", () => supplierAction(request("POST", undefined, { cookie: null }), { params: { id: ID, action: "deactivate" } })],
    ["list orders", () => listOrders(request("GET", undefined, { cookie: null }))],
    ["create order", () => createOrder(request("POST", { supplierId: ID, currencyCode: "USD" }, { cookie: null, key: KEY }))],
    ["get order", () => getOrder(request("GET", undefined, { cookie: null }), ctx)],
    ["edit order", () => editOrder(request("PATCH", { notes: "x" }, { cookie: null }), ctx)],
    ["order action", () => orderAction(request("POST", undefined, { cookie: null }), ctx)],
    ["add line", () => addLine(request("POST", { productId: PRODUCT, quantity: "1", unitPrice: "1" }, { cookie: null }), ctx)],
    ["edit line", () => editLine(request("PATCH", { quantity: "1" }, { cookie: null }), ctx)],
    ["remove line", () => removeLine(request("DELETE", undefined, { cookie: null }), ctx)],
  ])("%s without a session answers 401 and calls nothing", async (_name, call) => {
    expect((await call()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not accept the Super Admin portal's cookie", async () => {
    expect((await addLine(request("POST", { productId: PRODUCT, quantity: "1", unitPrice: "1" }, { cookie: "impex_session=super" }), { params: { id: ID } })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the HttpOnly session token as the Bearer token and nothing that names an organization", async () => {
    stub(() => json(201, { id: ID }));
    await createOrder(request("POST", { supplierId: ID, currencyCode: "usd", organization_id: "evil", organizationId: "evil" }, { key: KEY }));
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(sentBody())).not.toMatch(/organization|tenant/i);
    expect(upstream().url).not.toMatch(/organization|tenant/i);
  });
});

describe("suppliers", () => {
  it("lists with whitelisted parameters only", async () => {
    stub(() => json(200, { items: [], total: 0, limit: 50, offset: 0 }));
    await listSuppliers(request("GET", undefined, { query: "?q=acme&status=all&limit=9999&organization_id=evil&offset=-5" }));
    expect(Object.fromEntries(new URL(upstream().url).searchParams)).toEqual({ q: "acme", status: "all", limit: "200", offset: "0" });
  });

  it("registers a supplier: normalizes, maps field names, forwards only the known fields", async () => {
    stub(() => json(201, { id: ID, name: "Acme" }));
    const res = await createSupplier(request("POST", {
      name: "  Acme   Supplies ", code: "ac-1", contactPerson: " Jane ", email: "j@a.example", phone: "1", address: "x", countryCode: "de", taxIdentifier: "DE1", is_active: false, organization_id: "evil",
    }));
    expect(res.status).toBe(201);
    expect(upstream().url).toBe(`${PURCHASING}/api/v1/purchasing/suppliers`);
    expect(sentBody()).toEqual({ name: "Acme Supplies", code: "AC-1", contact_person: "Jane", email: "j@a.example", phone: "1", address: "x", country_code: "DE", tax_identifier: "DE1" });
  });

  it.each([[{}, "name"], [{ name: "  " }, "name"], [{ name: "A", email: "bad" }, "email"], [{ name: "A", countryCode: "DEU" }, "countryCode"], [{ name: "A", code: "has space" }, "code"], [{ name: "A", taxIdentifier: "x".repeat(51) }, "taxIdentifier"]])(
    "rejects %j on the %s field without calling the service", async (body, field) => {
      const res = await createSupplier(request("POST", body));
      expect(res.status).toBe(400);
      expect((await res.json()).fieldErrors).toHaveProperty(field);
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it("shows a duplicate name or code under the right field", async () => {
    stub(() => json(409, { detail: "A supplier named 'Acme' already exists in your directory." }));
    expect((await (await createSupplier(request("POST", { name: "Acme" }))).json()).fieldErrors).toHaveProperty("name");
    stub(() => json(409, { detail: "The supplier code 'AC' is already used by another supplier." }));
    expect((await (await createSupplier(request("POST", { name: "Acme", code: "ac" }))).json()).fieldErrors).toHaveProperty("code");
  });

  it("views and edits only what was sent, and (de)activates", async () => {
    stub(() => json(200, { id: ID }));
    expect((await getSupplier(request("GET"), { params: { id: ID } })).status).toBe(200);
    fetchMock.mockClear();
    await editSupplier(request("PATCH", { phone: "555", organization_id: "evil" }), { params: { id: ID } });
    expect(sentBody()).toEqual({ phone: "555" });
    expect((await editSupplier(request("PATCH", {}), { params: { id: ID } })).status).toBe(400);
    expect((await editSupplier(request("PATCH", { name: "A" }), { params: { id: "nope" } })).status).toBe(404);
    expect((await supplierAction(request("POST"), { params: { id: ID, action: "delete" } })).status).toBe(404);
    fetchMock.mockClear();
    expect((await supplierAction(request("POST"), { params: { id: ID, action: "deactivate" } })).status).toBe(200);
    expect(upstream().url).toBe(`${PURCHASING}/api/v1/purchasing/suppliers/${ID}/deactivate`);
  });
});

describe("creating a purchase order (duplicate-submission protection)", () => {
  it("forwards the Idempotency-Key and only the order fields", async () => {
    stub(() => json(201, { id: ID, number: "PO-000001" }));
    const res = await createOrder(request("POST", {
      supplierId: ID, currencyCode: "eur", supplierReference: " Q  1 ", orderDate: "2026-11-06", expectedDeliveryDate: "2026-11-20", notes: "n",
      status: "ordered", number: "PO-9", total_amount: "0", created_by: "x",
    }, { key: KEY }));
    expect(res.status).toBe(201);
    expect(upstream().url).toBe(`${PURCHASING}/api/v1/purchasing/purchase-orders`);
    expect(upstream().init.headers["Idempotency-Key"]).toBe(KEY);
    expect(sentBody()).toEqual({ supplier_id: ID, currency_code: "EUR", supplier_reference: "Q 1", notes: "n", order_date: "2026-11-06", expected_delivery_date: "2026-11-20" });
  });

  it("passes a replay (200) back as a success", async () => {
    stub(() => json(200, { id: ID, number: "PO-000001" }));
    const res = await createOrder(request("POST", { supplierId: ID, currencyCode: "USD" }, { key: KEY }));
    expect(res.status).toBe(200);
    expect((await res.json()).replayed).toBe(true);
  });

  it("requires a well-formed Idempotency-Key", async () => {
    for (const key of [undefined, "short", "has space in it", "x".repeat(101)]) {
      expect((await createOrder(request("POST", { supplierId: ID, currencyCode: "USD" }, { key }))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ currencyCode: "USD" }, "supplierId"], [{ supplierId: "nope", currencyCode: "USD" }, "supplierId"], [{ supplierId: ID, currencyCode: "US" }, "currencyCode"],
    [{ supplierId: ID, currencyCode: "USD", orderDate: "2026-13-45" }, "orderDate"], [{ supplierId: ID, currencyCode: "USD", orderDate: "2026-11-10", expectedDeliveryDate: "2026-11-09" }, "expectedDeliveryDate"],
    [{ supplierId: ID, currencyCode: "USD", supplierReference: "x".repeat(101) }, "supplierReference"], [{ supplierId: ID, currencyCode: "USD", notes: "x".repeat(2001) }, "notes"],
  ])("rejects %j on the %s field without calling the service", async (body, field) => {
    const res = await createOrder(request("POST", body, { key: KEY }));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors).toHaveProperty(field);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relays refusals readably (inactive supplier, unknown supplier, different request for the key)", async () => {
    for (const [status, detail] of [[409, "Acme is inactive. Reactivate the supplier before creating a purchase order for them."], [404, "Supplier not found."], [409, "This Idempotency-Key was already used for a different request."]] as const) {
      stub(() => json(status, { detail }));
      const res = await createOrder(request("POST", { supplierId: ID, currencyCode: "USD" }, { key: KEY }));
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(detail);
    }
  });
});

describe("orders: reading, editing, placing, cancelling", () => {
  it("filters with whitelisted parameters, ignoring anything else", async () => {
    stub(() => json(200, { items: [], total: 0, limit: 50, offset: 0 }));
    await listOrders(request("GET", undefined, { query: `?status=ordered&supplierId=${ID}&q=po&organization_id=evil&sort=x` }));
    expect(Object.fromEntries(new URL(upstream().url).searchParams)).toEqual({ status: "ordered", supplier_id: ID, q: "po", limit: "50", offset: "0" });
    fetchMock.mockClear();
    await listOrders(request("GET", undefined, { query: "?status=shipped" }));
    expect(new URL(upstream().url).searchParams.has("status")).toBe(false);
    expect((await listOrders(request("GET", undefined, { query: "?supplierId=nope" }))).status).toBe(404);
  });

  it("edits the header: maps names, validates, can clear the expected date, never sends status", async () => {
    stub(() => json(200, { id: ID }));
    await editOrder(request("PATCH", { supplierReference: " NEW ", notes: "n", expectedDeliveryDate: "", currencyCode: "gbp", status: "ordered", number: "X" }), { params: { id: ID } });
    expect(sentBody()).toEqual({ supplier_reference: "NEW", notes: "n", expected_delivery_date: null, currency_code: "GBP" });
    expect((await editOrder(request("PATCH", {}), { params: { id: ID } })).status).toBe(400);
    expect((await editOrder(request("PATCH", { currencyCode: "EU" }), { params: { id: ID } })).status).toBe(400);
    expect((await editOrder(request("PATCH", { orderDate: "" }), { params: { id: ID } })).status).toBe(400);
    expect((await getOrder(request("GET"), { params: { id: "../x" } })).status).toBe(404);
  });

  it.each(["order", "cancel"])("%s calls the matching endpoint (and only that)", async (action) => {
    stub(() => json(200, { id: ID, status: "ordered" }));
    expect((await orderAction(request("POST"), { params: { id: ID, action } })).status).toBe(200);
    expect(upstream().url).toBe(`${PURCHASING}/api/v1/purchasing/purchase-orders/${ID}/${action}`);
  });

  it.each(["receive", "receipt", "reopen", "complete", "invoice", "pay", "delete"])("has no %s action", async (action) => {
    expect((await orderAction(request("POST"), { params: { id: ID, action } })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relays a refusal of a frozen order readably", async () => {
    stub(() => json(409, { detail: "PO-000001 is ordered. Only a draft purchase order can be changed; an ordered one is frozen." }));
    const res = await editOrder(request("PATCH", { notes: "x" }), { params: { id: ID } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("frozen");
  });
});

describe("lines", () => {
  const ctx = { params: { id: ID } };

  it("adds an existing product: forwards ONLY id, quantity, price, warehouse and note", async () => {
    stub(() => json(201, { line: { id: LINE }, line_count: 1, total_amount: "62.5000" }));
    const res = await addLine(request("POST", {
      productId: PRODUCT, quantity: " 50 ", unitPrice: " 1.25 ", plannedWarehouseId: WAREHOUSE, notes: " pallet ",
      productName: "Hacked", productSku: "X", unit: "kg", lineTotal: "0.01", line_total: "0.01", total_amount: "0", selling_price: "0.01", organization_id: "evil",
    }), ctx);
    expect(res.status).toBe(201);
    expect(upstream().url).toBe(`${PURCHASING}/api/v1/purchasing/purchase-orders/${ID}/lines`);
    expect(sentBody()).toEqual({ product_id: PRODUCT, quantity: "50", unit_price: "1.25", planned_warehouse_id: WAREHOUSE, notes: "pallet" });
  });

  it("keeps quantity and price exact strings", async () => {
    stub(() => json(201, { line: {} }));
    await addLine(request("POST", { productId: PRODUCT, quantity: "0.1000", unitPrice: "0.2000" }), ctx);
    expect(upstream().init.body).toContain('"quantity":"0.1000"');
    expect(upstream().init.body).toContain('"unit_price":"0.2000"');
  });

  it.each([
    ["no product", { quantity: "1", unitPrice: "1" }, "productId"], ["bad product", { productId: "nope", quantity: "1", unitPrice: "1" }, "productId"],
    ["no quantity", { productId: PRODUCT, unitPrice: "1" }, "quantity"], ["zero quantity", { productId: PRODUCT, quantity: "0", unitPrice: "1" }, "quantity"],
    ["a JSON number quantity", { productId: PRODUCT, quantity: 5, unitPrice: "1" }, "quantity"], ["text quantity", { productId: PRODUCT, quantity: "lots", unitPrice: "1" }, "quantity"],
    ["no price", { productId: PRODUCT, quantity: "1" }, "unitPrice"], ["negative price", { productId: PRODUCT, quantity: "1", unitPrice: "-1" }, "unitPrice"],
    ["a JSON number price", { productId: PRODUCT, quantity: "1", unitPrice: 1.25 }, "unitPrice"], ["5-decimal price", { productId: PRODUCT, quantity: "1", unitPrice: "1.00001" }, "unitPrice"],
    ["bad warehouse", { productId: PRODUCT, quantity: "1", unitPrice: "1", plannedWarehouseId: "nope" }, "plannedWarehouseId"], ["long note", { productId: PRODUCT, quantity: "1", unitPrice: "1", notes: "x".repeat(501) }, "notes"],
  ])("rejects %s without calling the service", async (_name, body, field) => {
    const res = await addLine(request("POST", body), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors).toHaveProperty(field);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a zero price (a free sample)", async () => {
    stub(() => json(201, { line: {} }));
    expect((await addLine(request("POST", { productId: PRODUCT, quantity: "1", unitPrice: "0" }), ctx)).status).toBe(201);
  });

  it("passes a duplicate-line answer on with the existing line", async () => {
    const line = { id: LINE, quantity: "5.0000", unit: "pcs", unit_price: "1.2500", product_name: "Steel bolt" };
    stub(() => json(409, { detail: { message: "Steel bolt is already on this order.", code: "duplicate_line", line } }));
    const res = await addLine(request("POST", { productId: PRODUCT, quantity: "3", unitPrice: "2" }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "duplicate_line", line, error: expect.stringContaining("already on this order") });
  });

  it.each([[404, "Product not found."], [409, "Old widget is archived and cannot be ordered."], [422, "Quantity must be a whole number: Bolt is counted in 'pcs'."], [503, "The inventory service is unavailable"]])(
    "relays the service's answer %i readably", async (status, detail) => {
      stub(() => json(status, { detail }));
      const res = await addLine(request("POST", { productId: PRODUCT, quantity: "1", unitPrice: "1" }), ctx);
      expect(res.status).toBe(status === 422 ? 400 : status);
      expect((await res.json()).error).toContain(detail.slice(0, 20));
    });

  it("edits a line (quantity and/or price) and removes one", async () => {
    const both = { params: { id: ID, lineId: LINE } };
    stub(() => json(200, { line: {}, total_amount: "1.0000" }));
    await editLine(request("PATCH", { quantity: "8", unitPrice: "2.5", product_name: "x", lineTotal: "0" }), both);
    expect(upstream().url).toBe(`${PURCHASING}/api/v1/purchasing/purchase-orders/${ID}/lines/${LINE}`);
    expect(sentBody()).toEqual({ quantity: "8", unit_price: "2.5" });
    fetchMock.mockClear();
    await editLine(request("PATCH", { plannedWarehouseId: null }), both);
    expect(sentBody()).toEqual({ planned_warehouse_id: null });
    fetchMock.mockClear();
    expect((await removeLine(request("DELETE"), both)).status).toBe(200);
    expect(upstream().init.method).toBe("DELETE");
  });

  it("validates line edits before calling the service", async () => {
    const both = { params: { id: ID, lineId: LINE } };
    expect((await editLine(request("PATCH", {}), both)).status).toBe(400);
    expect((await editLine(request("PATCH", { quantity: "0" }), both)).status).toBe(400);
    expect((await editLine(request("PATCH", { unitPrice: "-1" }), both)).status).toBe(400);
    expect((await editLine(request("PATCH", { quantity: "1" }), { params: { id: ID, lineId: "bad" } })).status).toBe(404);
    expect((await removeLine(request("DELETE"), { params: { id: "bad", lineId: LINE } })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 without leaking details when the Purchasing Service is down", async () => {
    stub(() => { throw new Error("connect ECONNREFUSED 10.0.0.9:8004"); });
    const res = await addLine(request("POST", { productId: PRODUCT, quantity: "1", unitPrice: "1" }), ctx);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.9");
  });
});
