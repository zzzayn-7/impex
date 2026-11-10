import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as createOrder } from "@/app/api/sales/orders/route";
import { PATCH as editOrder } from "@/app/api/sales/orders/[id]/route";
import { lineTotal } from "@/lib/product-validation";
import { type OrderRow, orderLines, orderTotal, priceErrors, readyToSave, rowTotal, signatureOf, validatePrice } from "@/lib/order-form";
import { parseOrderLines } from "@/lib/sales-routes";

// Client-specific selling prices: the rules the Checkout applies in the browser (exact decimals, an empty price is never zero), and the portal routes that read the
// agreed price of ONE piece for every line and pass the order's currency to the Sales Service.

const WATER = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const FLOUR = "7a1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const CLIENT = "c0000000-0000-4000-8000-000000000001";
const ORDER = "d0000000-0000-4000-8000-000000000001";
const TOKEN = "session-token-abc";
const SALES = "http://sales-service:8003";

const row = (over: Partial<OrderRow> = {}): OrderRow => ({
  productId: WATER, sku: "WATER", name: "Water bottle", unit: "pcs", fractions: false, quantity: "20", onHand: "500", reserved: "0", available: "500", min: "0", unitPrice: "", ...over,
});

describe("validatePrice: the same rule as an invoice's selling price", () => {
  it.each(["0", "0.00", "1", "120000", "49.99", "0.0001", "99999999999999", "99999999999999.9999", " 25 ", "007"])("accepts %j", (value) => {
    expect(validatePrice(value)).toBeUndefined();
  });

  it("an empty or blank price is NOT entered (never zero)", () => {
    expect(validatePrice("")).toBe("Enter the price per piece.");
    expect(validatePrice("   ", "kg")).toBe("Enter the price per kg.");
  });

  it.each([
    ["-1", "A price cannot be negative."], ["-0.01", "A price cannot be negative."], ["-", "A price cannot be negative."],
    ["abc", "Enter a number such as 120000 or 49.99."], ["1,5", "Enter a number such as 120000 or 49.99."], ["1e3", "Enter a number such as 120000 or 49.99."],
    [".", "Enter a number such as 120000 or 49.99."], ["1.2.3", "Enter a number such as 120000 or 49.99."], ["Rs. 5", "Enter a number such as 120000 or 49.99."], ["NaN", "Enter a number such as 120000 or 49.99."],
    ["1.00001", "Use at most 4 decimal places."], ["0.123456", "Use at most 4 decimal places."],
    ["100000000000000", "That price is too large."], ["123456789012345678", "That price is too large."],
  ])("refuses %j", (value, message) => {
    expect(validatePrice(value)).toBe(message);
  });
});

describe("line totals and the order total are exact", () => {
  it("quantity x price, never floating point", () => {
    expect(lineTotal("3", "0.1")).toBe("0.3000");
    expect(lineTotal("20", "120000")).toBe("2400000.0000");
    expect(lineTotal("0.3333", "3")).toBe("0.9999");
    expect(lineTotal("1234567", "1999.9999")).toBe("2469133876.5433");
    expect(lineTotal("0.0001", "0.0001")).toBe("0.0000"); // 0.00000001 rounds half up to four decimals
    expect(lineTotal("0.5", "0.0001")).toBe("0.0001"); // 0.00005 rounds UP
  });

  it("a row has a total only when its quantity and its price are both valid", () => {
    expect(rowTotal(row())).toBeNull(); // no price yet
    expect(rowTotal(row({ unitPrice: "abc" }))).toBeNull();
    expect(rowTotal(row({ quantity: "0", unitPrice: "5" }))).toBeNull(); // a zero quantity is not a line
    expect(rowTotal(row({ unitPrice: "120000" }))).toBe("2400000.0000");
    expect(rowTotal(row({ unitPrice: "0" }))).toBe("0.0000"); // an explicit zero is a price
  });

  it("the order total is the sum of the lines, and only exists when EVERY line has a valid total", () => {
    const a = row({ unitPrice: "120000" });
    const b = row({ productId: FLOUR, sku: "FLOUR", name: "Flour", unit: "kg", fractions: true, quantity: "10", available: "20", unitPrice: "35000" });
    expect(orderTotal([a, b])).toBe("2750000.0000");
    expect(orderTotal([a, { ...b, unitPrice: "" }])).toBeNull();
    expect(orderTotal([])).toBeNull();
  });
});

describe("Save Order is allowed only when everything is valid", () => {
  const a = row({ unitPrice: "120000" });
  const b = row({ productId: FLOUR, sku: "FLOUR", name: "Flour", unit: "kg", fractions: true, quantity: "10", available: "20", unitPrice: "" });

  it("needs a client, a product, every quantity valid and EVERY price valid", () => {
    expect(readyToSave(CLIENT, [a])).toBe(true);
    expect(readyToSave("", [a])).toBe(false);
    expect(readyToSave(CLIENT, [])).toBe(false);
    expect(readyToSave(CLIENT, [a, b])).toBe(false); // one price is not enough
    expect(readyToSave(CLIENT, [a, { ...b, unitPrice: "35000" }])).toBe(true);
    expect(readyToSave(CLIENT, [a, { ...b, unitPrice: "-1" }])).toBe(false);
    expect(readyToSave(CLIENT, [{ ...a, quantity: "9999" }])).toBe(false); // more than is available
  });

  it("collects one problem per unpriced product", () => {
    expect(Object.keys(priceErrors([a, b]))).toEqual([FLOUR]);
  });

  it("the Idempotency fingerprint covers the currency and every price, so a changed price is a different order", () => {
    expect(signatureOf(CLIENT, [a], "USD")).not.toBe(signatureOf(CLIENT, [a], "EUR"));
    expect(signatureOf(CLIENT, [a], "USD")).not.toBe(signatureOf(CLIENT, [{ ...a, unitPrice: "120001" }], "USD"));
    expect(signatureOf(CLIENT, [a], "USD")).toBe(signatureOf(CLIENT, [{ ...a, unitPrice: " 120000 " }], "USD"));
  });

  it("only product ids, exact quantity strings and the price strings are sent", () => {
    expect(orderLines([a, { ...b, unitPrice: "35000.50" }])).toEqual([{ productId: WATER, quantity: "20", unitPrice: "120000" }, { productId: FLOUR, quantity: "10", unitPrice: "35000.50" }]);
  });
});

describe("parseOrderLines (the portal route's reading of the browser's lines)", () => {
  const line = (over: Record<string, unknown> = {}) => ({ productId: WATER, quantity: "20", unitPrice: "120000", ...over });

  it("required: every line must bring a valid price, exactly as typed", () => {
    expect(parseOrderLines([line(), line({ productId: FLOUR, unitPrice: "0" })], "required")).toEqual({
      ok: true, lines: [{ product_id: WATER, quantity: "20", unit_price: "120000" }, { product_id: FLOUR, quantity: "20", unit_price: "0" }],
    });
  });

  it.each([undefined, null, "", " ", "-1", "abc", "1e3", "1,5", "1.23456", "123456789012345", 5, true, ["1"], {}])("required: refuses the price %j", (price) => {
    const result = parseOrderLines([line({ unitPrice: price })], "required");
    expect(result.ok).toBe(false);
  });

  it("optional (editing): a line may omit its price, but one that is sent must be valid", () => {
    expect(parseOrderLines([{ productId: WATER, quantity: "20" }], "optional")).toEqual({ ok: true, lines: [{ product_id: WATER, quantity: "20" }] });
    expect(parseOrderLines([line({ unitPrice: "-1" })], "optional").ok).toBe(false);
  });

  it("none: an order without agreed prices ignores any price it is sent", () => {
    expect(parseOrderLines([line()], "none")).toEqual({ ok: true, lines: [{ product_id: WATER, quantity: "20" }] });
  });

  it("still refuses a repeated product, a bad id and a bad quantity", () => {
    expect(parseOrderLines([line(), line()], "required").ok).toBe(false);
    expect(parseOrderLines([line({ productId: "nope" })], "required").ok).toBe(false);
    expect(parseOrderLines([line({ quantity: "-1" })], "required").ok).toBe(false);
    expect(parseOrderLines([], "required").ok).toBe(false);
  });
});

// ---- the routes ------------------------------------------------------------------------------------------------------------------------------------
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { method: string; path: string; body: any; headers: Record<string, string> };
let calls: Call[];
let answer: () => Response;

beforeEach(() => {
  process.env.SALES_SERVICE_URL = SALES;
  calls = [];
  answer = () => json(201, { id: ORDER, number: "SO-000001" });
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any = {}) => {
    calls.push({ method: init.method ?? "GET", path: new URL(String(url)).pathname, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    return answer();
  }));
});
afterEach(() => vi.unstubAllGlobals());

const post = (body: unknown, key: string | null = "ui-key-0123456789", cookie: string | null = `impex_tenant_session=${TOKEN}`) =>
  createOrder(new NextRequest("http://localhost:3001/api/sales/orders", { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) }));
const good = { clientId: CLIENT, currencyCode: "pkr", lines: [{ productId: WATER, quantity: "20", unitPrice: "120000" }, { productId: FLOUR, quantity: "10", unitPrice: "35000.5" }] };

describe("POST /api/sales/orders (agreed prices)", () => {
  it("forwards the client, the currency (capitalised), and every line's quantity and agreed price, with the Idempotency-Key", async () => {
    const res = await post(good);
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/sales/orders" });
    expect(calls[0].body).toEqual({
      client_id: CLIENT, currency_code: "PKR",
      lines: [{ product_id: WATER, quantity: "20", unit_price: "120000" }, { product_id: FLOUR, quantity: "10", unit_price: "35000.5" }],
    });
    expect(calls[0].headers["Idempotency-Key"]).toBe("ui-key-0123456789");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("two clients, the same product, two prices: each order carries its own", async () => {
    await post({ ...good, clientId: CLIENT, lines: [{ productId: WATER, quantity: "20", unitPrice: "120000" }] }, "key-for-company-a");
    await post({ ...good, clientId: "c0000000-0000-4000-8000-000000000002", lines: [{ productId: WATER, quantity: "20", unitPrice: "110000" }] }, "key-for-company-b");
    expect(calls.map((c) => [c.body.client_id.slice(-1), c.body.lines[0].unit_price])).toEqual([["1", "120000"], ["2", "110000"]]);
  });

  it("refuses an order whose lines lack a price, BEFORE asking the Sales Service, and never reads an empty price as zero", async () => {
    for (const lines of [
      [{ productId: WATER, quantity: "20" }],
      [{ productId: WATER, quantity: "20", unitPrice: "" }],
      [{ productId: WATER, quantity: "20", unitPrice: "120000" }, { productId: FLOUR, quantity: "10" }],
      [{ productId: WATER, quantity: "20", unitPrice: "-1" }],
      [{ productId: WATER, quantity: "20", unitPrice: "1.00001" }],
    ]) expect((await post({ ...good, lines })).status, JSON.stringify(lines)).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("refuses a missing or malformed currency", async () => {
    for (const currencyCode of [undefined, "", "US", "USDX", "12$", 5, null]) expect((await post({ ...good, currencyCode })).status, String(currencyCode)).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("needs a session and an Idempotency-Key", async () => {
    expect((await post(good, "ui-key-0123456789", null)).status).toBe(401);
    expect((await post(good, null)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("passes on 201 (created), 200 (this exact request was already processed) and 202 (saved, booking not confirmed)", async () => {
    answer = () => json(200, { id: ORDER, number: "SO-000001" });
    expect(await (await post(good)).json()).toMatchObject({ replayed: true, pending: false });
    answer = () => json(202, { id: ORDER, number: "SO-000001" });
    const pending = await post(good);
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ pending: true });
  });

  it("shows the Sales Service's reasons: a different request under the same key, a shortage, a bad price", async () => {
    answer = () => json(409, { detail: "This Idempotency-Key was already used for a different request. Use a new key for a new order." });
    const clash = await post(good);
    expect(clash.status).toBe(409);
    expect((await clash.json()).error).toContain("different request");
    answer = () => json(422, { detail: [{ loc: ["body", "lines", 0, "unit_price"], msg: "Input should be greater than or equal to 0" }] });
    expect((await post(good)).status).toBe(400);
  });

  it("forwards nothing else the browser invents: no organization, no product name, no total", async () => {
    await post({ ...good, organization_id: "evil", total: "1", name: "x", lines: [{ productId: WATER, quantity: "1", unitPrice: "2", name: "Hacked", sku: "X", total: "9" }] });
    expect(calls[0].body).toEqual({ client_id: CLIENT, currency_code: "PKR", lines: [{ product_id: WATER, quantity: "1", unit_price: "2" }] });
  });
});

describe("PATCH /api/sales/orders/[id] (edit)", () => {
  const patch = (body: unknown) => editOrder(new NextRequest(`http://localhost:3001/api/sales/orders/${ORDER}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: `impex_tenant_session=${TOKEN}` }, body: JSON.stringify(body) }), { params: { id: ORDER } });

  it("a line may omit its price (it keeps the saved one); a price that is sent is forwarded exactly", async () => {
    answer = () => json(200, { id: ORDER });
    await patch({ version: 3, lines: [{ productId: WATER, quantity: "30" }, { productId: FLOUR, quantity: "2", unitPrice: "4.5" }] });
    expect(calls[0]).toMatchObject({ method: "PATCH", path: `/api/v1/sales/orders/${ORDER}` });
    expect(calls[0].body).toEqual({ version: 3, lines: [{ product_id: WATER, quantity: "30" }, { product_id: FLOUR, quantity: "2", unit_price: "4.5" }] });
  });

  it("refuses an invalid price and a missing version without asking the Sales Service", async () => {
    expect((await patch({ version: 3, lines: [{ productId: WATER, quantity: "30", unitPrice: "-5" }] })).status).toBe(400);
    expect((await patch({ lines: [{ productId: WATER, quantity: "30" }] })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
