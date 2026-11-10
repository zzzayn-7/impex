import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCostBody, parseInvestmentBody, parseOpeningBody, parseReconcileBody } from "@/lib/finance-routes";
import { GET as getSummary } from "@/app/api/finance/summary/route";
import { GET as getPnlTrend } from "@/app/api/finance/pnl-trend/route";
import { GET as getHistory } from "@/app/api/finance/history/route";
import { GET as getReconciliation } from "@/app/api/finance/reconciliation/route";
import { POST as postInvestment } from "@/app/api/finance/investments/route";
import { POST as reverseInvestment } from "@/app/api/finance/investments/[id]/reverse/route";
import { GET as listPositions, POST as postPosition } from "@/app/api/finance/opening-positions/route";
import { POST as reversePosition } from "@/app/api/finance/opening-positions/[id]/reverse/route";
import { GET as listCosts, POST as postCost } from "@/app/api/finance/inventory-costs/route";
import { POST as reconcileDelivery } from "@/app/api/finance/deliveries/[id]/reconcile/route";

// The portal's routes for Capital, Investment and Profit & Loss: session-only, whitelisted fields, exact money strings, nothing about an organization.

const ID = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718";
const PRODUCT = "11111111-1111-4111-8111-111111111111";
const TOKEN = "session-token-abc";
const FINANCE = "http://finance-service:8006";
const INVENTORY = "http://inventory-service:8002";
const KEY = "ui-3f2b8c1e-0000-4000-8000-000000000001";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
const stub = (handler: (url: string, init: any) => Response) => {
  fetchMock = vi.fn(async (url: any, init: any) => handler(String(url), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
};
const request = (method: string, body?: unknown, { cookie = `impex_tenant_session=${TOKEN}`, query = "", key }: { cookie?: string | null; query?: string; key?: string } = {}) =>
  new NextRequest(`http://localhost:3001/api/finance/x${query}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const financeCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(FINANCE));
const upstream = () => ({ url: financeCalls()[0][0] as string, init: financeCalls()[0][1] as any });
const sentBody = () => JSON.parse(upstream().init.body);
const params = () => ({ params: { id: ID } });

beforeEach(() => {
  process.env.FINANCE_SERVICE_URL = FINANCE;
  process.env.INVENTORY_SERVICE_URL = INVENTORY;
  stub(() => json(200, {}));
});
afterEach(() => vi.unstubAllGlobals());

describe("parsing what the browser sends", () => {
  it("an investment keeps only its own fields, the amount as an exact string, and the kind and form from a fixed list", () => {
    const parsed = parseInvestmentBody({ kind: "withdrawal", entryType: "inventory", amount: " 5000000.5 ", currencyCode: "pkr", effectiveDate: "2026-11-05", description: "  Seed   money ", organization_id: "x", effect: "9" });
    expect(parsed).toEqual({ ok: true, value: { kind: "withdrawal", entry_type: "inventory", amount: "5000000.5", currency_code: "PKR", effective_date: "2026-11-05", description: "Seed money" } });
    expect(parseInvestmentBody({ kind: "gift", entryType: "voucher", amount: "1", effectiveDate: "2026-11-05" })).toMatchObject({ ok: true, value: { kind: "contribution", entry_type: "cash" } }); // an unknown value falls back to the safe default
    for (const amount of ["", "0", "-1", "1.23456", "1e6", 5, "abc"]) {
      const bad = parseInvestmentBody({ amount, effectiveDate: "2026-11-05" });
      expect(bad.ok, String(amount)).toBe(false);
      if (!bad.ok) expect(bad.fieldErrors?.amount).toBeTruthy();
    }
    expect(parseInvestmentBody({ amount: "1", effectiveDate: "05/11/2026" })).toMatchObject({ ok: false, fieldErrors: { effectiveDate: "Enter a valid date." } });
    expect(parseInvestmentBody({ amount: "1", effectiveDate: "2026-11-05", currencyCode: "EURO" })).toMatchObject({ ok: false, fieldErrors: { currencyCode: expect.any(String) } });
    expect(parseInvestmentBody({ amount: "1", effectiveDate: "2026-11-05", notes: "x".repeat(501) })).toMatchObject({ ok: false, fieldErrors: { notes: expect.any(String) } });
  });

  it("an opening position treats an empty side as zero and rejects negatives", () => {
    expect(parseOpeningBody({ effectiveDate: "2026-11-05", assets: "8000000", liabilities: "", currencyCode: "pkr" })).toEqual({ ok: true, value: { effective_date: "2026-11-05", assets: "8000000", liabilities: "0", currency_code: "PKR" } });
    expect(parseOpeningBody({ effectiveDate: "2026-11-05", assets: "-1", liabilities: "0" })).toMatchObject({ ok: false, fieldErrors: { assets: expect.any(String) } });
    expect(parseOpeningBody({ effectiveDate: "x", assets: "1", liabilities: "1.00001" })).toMatchObject({ ok: false, fieldErrors: { effectiveDate: expect.any(String), liabilities: expect.any(String) } });
  });

  it("a stock cost needs a product id, a quantity and the cost of ONE unit - above zero", () => {
    expect(parseCostBody({ productId: PRODUCT, quantity: "10", unitCost: "100000", effectiveDate: "2026-11-05", sku: "FAKE", name: "Fake" })).toEqual({ ok: true, value: { product_id: PRODUCT, quantity: "10", unit_cost: "100000", effective_date: "2026-11-05" } }); // sku/name are never read from the browser
    for (const patch of [{ productId: "nope" }, { quantity: "0" }, { unitCost: "0" }, { unitCost: "" }]) expect(parseCostBody({ productId: PRODUCT, quantity: "1", unitCost: "1", effectiveDate: "2026-11-05", ...patch }).ok).toBe(false);
  });

  it("a reconciliation needs a price or a cost, and a reason", () => {
    expect(parseReconcileBody({ unitPrice: "50", unitCost: "30", currencyCode: "pkr", reason: " Checked the paper order " })).toEqual({ ok: true, value: { reason: "Checked the paper order", unit_price: "50", unit_cost: "30", currency_code: "PKR" } });
    expect(parseReconcileBody({ reason: "because" })).toMatchObject({ ok: false, fieldErrors: { unitCost: expect.any(String) } });
    expect(parseReconcileBody({ unitCost: "5", reason: "x" })).toMatchObject({ ok: false, fieldErrors: { reason: expect.any(String) } });
    expect(parseReconcileBody({ unitPrice: "0", reason: "because" })).toMatchObject({ ok: false, fieldErrors: { unitPrice: expect.any(String) } });
  });
});

describe("reading: summary, history and reconciliation", () => {
  it("the summary needs a session and a known period, and forwards only the period with the session's token", async () => {
    expect((await getSummary(request("GET", undefined, { cookie: null }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getSummary(request("GET", undefined, { query: "?period=2d" }))).status).toBe(400);
    stub(() => json(200, { period: { key: "1w" } }));
    const response = await getSummary(request("GET", undefined, { query: "?period=1w&organization_id=evil" }));
    expect(response.status).toBe(200);
    expect(upstream().url).toBe(`${FINANCE}/api/v1/finance/summary?period=1w`);
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("the summary defaults to one month", async () => {
    await getSummary(request("GET"));
    expect(upstream().url).toBe(`${FINANCE}/api/v1/finance/summary?period=1m`);
  });

  it("the history forwards a period, a category, a currency and a page - and refuses anything else", async () => {
    expect((await getHistory(request("GET", undefined, { query: "?category=secrets" }))).status).toBe(400);
    expect((await getHistory(request("GET", undefined, { query: "?period=forever" }))).status).toBe(400);
    stub(() => json(200, { items: [], total: 0, limit: 25, offset: 0 }));
    await getHistory(request("GET", undefined, { query: "?period=1y&category=loss_sales&currency=pkr&limit=9999&offset=-5&organization_id=evil" }));
    const url = new URL(upstream().url);
    expect(url.pathname).toBe("/api/v1/finance/history");
    expect(Object.fromEntries(url.searchParams)).toEqual({ period: "1y", category: "loss_sales", currency: "PKR", limit: "200", offset: "0" });
  });

  it("an outage or a refusal from the service is passed on safely", async () => {
    stub(() => json(403, { detail: { code: "module_disabled", message: "The Finance module is not enabled for your organization." } }));
    const refused = await getSummary(request("GET"));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toContain("not enabled");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));
    expect((await getHistory(request("GET"))).status).toBe(503);
    expect((await getReconciliation(request("GET"))).status).toBe(503);
  });

  it("reconciliation needs a session", async () => {
    expect((await getReconciliation(request("GET", undefined, { cookie: null }))).status).toBe(401);
    stub(() => json(200, { items: [] }));
    await getReconciliation(request("GET"));
    expect(upstream().url).toBe(`${FINANCE}/api/v1/finance/reconciliation`);
  });
});

describe("Record Investment", () => {
  const body = { kind: "contribution", entryType: "cash", amount: "5000000", currencyCode: "PKR", effectiveDate: "2026-11-05", description: "Seed money", organization_id: "evil", effect: "999" };

  it("needs a session and an Idempotency-Key, and sends nothing to the service without them", async () => {
    expect((await postInvestment(request("POST", body, { cookie: null, key: KEY }))).status).toBe(401);
    expect((await postInvestment(request("POST", body))).status).toBe(400);
    expect((await postInvestment(request("POST", body, { key: "short" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only the whitelisted fields, the key and the session token", async () => {
    stub(() => json(201, { id: ID, kind: "contribution" }));
    const response = await postInvestment(request("POST", body, { key: KEY }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ record: { id: ID, kind: "contribution" }, replayed: false });
    expect(upstream().url).toBe(`${FINANCE}/api/v1/finance/investments`);
    expect(upstream().init.headers["Idempotency-Key"]).toBe(KEY);
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sentBody()).toEqual({ kind: "contribution", entry_type: "cash", amount: "5000000", currency_code: "PKR", effective_date: "2026-11-05", description: "Seed money" });
  });

  it("a retry answers as a replay and a refused amount never reaches the service", async () => {
    stub(() => json(200, { id: ID }));
    expect((await (await postInvestment(request("POST", body, { key: KEY }))).json()).replayed).toBe(true);
    stub(() => json(200, {}));
    const bad = await postInvestment(request("POST", { ...body, amount: "0" }, { key: KEY }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).fieldErrors.amount).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns the service's validation and conflicts into field errors and clear messages", async () => {
    stub(() => json(422, { detail: [{ loc: ["body", "effective_date"], msg: "Value error, The date cannot be in the future." }] }));
    const response = await postInvestment(request("POST", body, { key: KEY }));
    expect(response.status).toBe(400);
    expect((await response.json()).fieldErrors.effectiveDate).toBeTruthy();
    stub(() => json(409, { detail: { code: "idempotency_key_reused", message: "This Idempotency-Key was already used for a different request." } }));
    expect((await postInvestment(request("POST", body, { key: KEY }))).status).toBe(409);
  });

  it("a reversal needs a session, a real id and a reason", async () => {
    expect((await reverseInvestment(request("POST", { reason: "typo" }, { cookie: null }), params())).status).toBe(401);
    expect((await reverseInvestment(request("POST", { reason: "typo" }), { params: { id: "not-an-id" } })).status).toBe(404);
    expect((await reverseInvestment(request("POST", { reason: "x" }), params())).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    stub(() => json(201, { id: "r1", is_reversal: true }));
    const done = await reverseInvestment(request("POST", { reason: "Entered twice", effectiveDate: "2020-01-01" }), params());
    expect(done.status).toBe(201);
    expect(upstream().url).toBe(`${FINANCE}/api/v1/finance/investments/${ID}/reverse`);
    expect(sentBody()).toEqual({ reason: "Entered twice" });
    stub(() => json(409, { detail: { code: "already_reversed", message: "This record was already reversed." } }));
    expect((await reverseInvestment(request("POST", { reason: "again" }), params())).status).toBe(409);
  });
});

describe("the opening position", () => {
  it("is listed, set once per request key and reversed with a reason", async () => {
    expect((await listPositions(request("GET", undefined, { cookie: null }))).status).toBe(401);
    stub(() => json(200, { items: [{ id: ID }] }));
    expect((await (await listPositions(request("GET"))).json()).items).toHaveLength(1);
    stub(() => json(201, { id: ID, equity: "5000000.0000" }));
    const set = await postPosition(request("POST", { effectiveDate: "2026-11-05", assets: "8000000", liabilities: "3000000", currencyCode: "pkr", organization_id: "evil" }, { key: KEY }));
    expect(set.status).toBe(201);
    expect(sentBody()).toEqual({ effective_date: "2026-11-05", assets: "8000000", liabilities: "3000000", currency_code: "PKR" });
    expect(upstream().init.headers["Idempotency-Key"]).toBe(KEY);
    expect((await postPosition(request("POST", { effectiveDate: "2026-11-05", assets: "1", liabilities: "0" }))).status).toBe(400); // no key
    stub(() => json(409, { detail: { code: "opening_exists", message: "An opening position in PKR already exists." } }));
    expect((await postPosition(request("POST", { effectiveDate: "2026-11-05", assets: "1", liabilities: "0" }, { key: KEY }))).status).toBe(409);
    stub(() => json(200, { id: ID, status: "reversed" }));
    expect((await reversePosition(request("POST", { reason: "Wrong balance sheet" }), params())).status).toBe(200);
    expect((await reversePosition(request("POST", { reason: "" }), params())).status).toBe(400);
    expect((await reversePosition(request("POST", { reason: "no id" }), { params: { id: "x" } })).status).toBe(404);
  });
});

describe("the cost of stock", () => {
  it("takes the SKU and name from the Inventory Service, never from the browser", async () => {
    stub((url) => (url.startsWith(INVENTORY) ? json(200, { id: PRODUCT, sku: "LAP-1", name: "Dell Latitude Laptop" }) : json(201, { id: ID })));
    const response = await postCost(request("POST", { productId: PRODUCT, quantity: "10", unitCost: "100000", currencyCode: "pkr", effectiveDate: "2026-11-05", sku: "FAKE", name: "Fake" }, { key: KEY }));
    expect(response.status).toBe(201);
    const inventory = fetchMock.mock.calls.find((c) => String(c[0]).startsWith(INVENTORY))!;
    expect(String(inventory[0])).toBe(`${INVENTORY}/api/v1/inventory/products/${PRODUCT}`);
    expect((inventory[1] as any).headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sentBody()).toEqual({ product_id: PRODUCT, quantity: "10", unit_cost: "100000", currency_code: "PKR", effective_date: "2026-11-05", sku: "LAP-1", name: "Dell Latitude Laptop" });
  });

  it("an unknown product or an unreachable inventory sends nothing to Finance", async () => {
    stub((url) => (url.startsWith(INVENTORY) ? json(404, { detail: "Product not found." }) : json(201, {})));
    const missing = await postCost(request("POST", { productId: PRODUCT, quantity: "1", unitCost: "1", effectiveDate: "2026-11-05" }, { key: KEY }));
    expect(missing.status).toBe(404);
    expect(financeCalls()).toHaveLength(0);
    stub(() => { throw new Error("down"); });
    expect((await postCost(request("POST", { productId: PRODUCT, quantity: "1", unitCost: "1", effectiveDate: "2026-11-05" }, { key: KEY }))).status).toBe(502);
  });

  it("needs a session and a key, and is listed for the session's organization", async () => {
    expect((await postCost(request("POST", {}, { cookie: null, key: KEY }))).status).toBe(401);
    expect((await postCost(request("POST", { productId: PRODUCT, quantity: "1", unitCost: "1", effectiveDate: "2026-11-05" }))).status).toBe(400);
    stub(() => json(200, { items: [] }));
    expect((await listCosts(request("GET"))).status).toBe(200);
    expect(upstream().url).toBe(`${FINANCE}/api/v1/finance/inventory-costs`);
  });
});

describe("reconciling a delivery", () => {
  it("forwards a whitelisted price, cost and reason for a real delivery id", async () => {
    expect((await reconcileDelivery(request("POST", { unitCost: "5", reason: "paper" }, { cookie: null }), params())).status).toBe(401);
    expect((await reconcileDelivery(request("POST", { unitCost: "5", reason: "paper" }), { params: { id: "x" } })).status).toBe(404);
    expect((await reconcileDelivery(request("POST", { reason: "paper" }), params())).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    stub(() => json(200, { id: ID, status: "recognized" }));
    const response = await reconcileDelivery(request("POST", { unitPrice: "50", unitCost: "30", currencyCode: "pkr", reason: "Checked the paper order", status: "recognized", cogs: "1" }), params());
    expect(response.status).toBe(200);
    expect(upstream().url).toBe(`${FINANCE}/api/v1/finance/deliveries/${ID}/reconcile`);
    expect(sentBody()).toEqual({ reason: "Checked the paper order", unit_price: "50", unit_cost: "30", currency_code: "PKR" });
    stub(() => json(409, { detail: { code: "already_recognized", message: "This delivery already has its price and cost, and they are final." } }));
    expect((await reconcileDelivery(request("POST", { unitCost: "5", reason: "again" }), params())).status).toBe(409);
  });
});

describe("the Profit & Loss trend", () => {
  it("needs a session and a known period, and forwards only the period", async () => {
    expect((await getPnlTrend(request("GET", undefined, { cookie: null }))).status).toBe(401);
    expect((await getPnlTrend(request("GET", undefined, { query: "?period=2d" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    stub(() => json(200, { buckets: [] }));
    const response = await getPnlTrend(request("GET", undefined, { query: "?period=1y&organization_id=evil" }));
    expect(response.status).toBe(200);
    expect(upstream().url).toBe(`${FINANCE}/api/v1/finance/pnl-trend?period=1y`);
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    await getPnlTrend(request("GET"));
    expect(financeCalls().at(-1)![0]).toBe(`${FINANCE}/api/v1/finance/pnl-trend?period=1m`);
  });

  it("passes on a refusal or an outage safely", async () => {
    stub(() => json(403, { detail: { code: "module_disabled", message: "The Finance module is not enabled for your organization." } }));
    expect((await getPnlTrend(request("GET"))).status).toBe(403);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect((await getPnlTrend(request("GET"))).status).toBe(503);
  });
});
