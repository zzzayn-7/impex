import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as searchProducts, POST as createProduct } from "@/app/api/products/route";
import { GET as viewProduct, PATCH as editProduct } from "@/app/api/products/[id]/route";
import { POST as archiveProduct } from "@/app/api/products/[id]/archive/route";
import { POST as restoreProduct } from "@/app/api/products/[id]/restore/route";

const ID = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const TOKEN = "tenant-session-token";
const INVENTORY = "http://inventory-service:8002";

const product = {
  id: ID, sku: "WID-001", name: "Widget", description: null, unit: "pcs", hs_code: null,
  cost_price: "0.1000", selling_price: "0.2000", currency_code: "USD", is_active: true,
  created_at: "2026-11-04T10:00:00+00:00", updated_at: "2026-11-04T10:00:00+00:00",
};
const valid = { sku: "WID-001", name: "Widget", unit: "pcs", costPrice: "0.1", currencyCode: "USD" }; // no selling price: it is agreed per sales order

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
const stub = (handler: (url: string, init: any) => Response) => {
  fetchMock = vi.fn(async (url: any, init: any) => handler(String(url), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
};

const request = (method: string, body?: unknown, cookie: string | null = `impex_tenant_session=${TOKEN}`, type: string | null = "application/json") =>
  new NextRequest("http://localhost:3001/api/products", {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(type ? { "content-type": type } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const ctx = (id = ID) => ({ params: { id } });
const upstream = () => ({ url: fetchMock.mock.calls[0][0] as string, init: fetchMock.mock.calls[0][1] as any });

beforeEach(() => {
  process.env.INVENTORY_SERVICE_URL = INVENTORY;
  stub(() => json(201, product));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("every product route is protected by the tenant session", () => {
  it.each([
    ["create", () => createProduct(request("POST", valid, null))],
    ["edit", () => editProduct(request("PATCH", { name: "X Y" }, null), ctx())],
    ["archive", () => archiveProduct(request("POST", undefined, null, null), ctx())],
    ["restore", () => restoreProduct(request("POST", undefined, null, null), ctx())],
  ])("%s without a session answers 401 and never calls the Inventory Service", async (_name, call) => {
    expect((await call()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not accept the Super Admin portal's cookie", async () => {
    const res = await createProduct(request("POST", valid, "impex_session=super-admin-token"));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the HttpOnly session token as the Bearer token", async () => {
    await createProduct(request("POST", valid));
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("POST /api/products (create)", () => {
  it("rejects non-JSON requests", async () => {
    expect((await createProduct(request("POST", "x=1", undefined, "text/plain"))).status).toBe(415);
    expect((await createProduct(request("POST", "{broken"))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing everything", {}, ["sku", "name", "unit", "costPrice", "currencyCode"]],
    ["a bad SKU", { sku: "has space" }, ["sku"]],
    ["a negative price", { costPrice: "-1" }, ["costPrice"]],
    ["five decimals", { sellingPrice: "1.23456" }, ["sellingPrice"]],
    ["an exponent", { costPrice: "1e3" }, ["costPrice"]],
    ["a comma decimal", { costPrice: "12,5" }, ["costPrice"]],
    ["a bad currency", { currencyCode: "EURO" }, ["currencyCode"]],
    ["a bad HS code", { hsCode: "12" }, ["hsCode"]],
  ])("answers 400 with field errors for %s, without calling the Inventory Service", async (_label, change, fields) => {
    const body = Object.keys(change).length === 0 && fields.length > 1 ? {} : { ...valid, ...change };
    const res = await createProduct(request("POST", body));
    expect(res.status).toBe(400);
    expect(Object.keys((await res.json()).fieldErrors).sort()).toEqual([...fields].sort());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards money as the exact strings it received, never as numbers", async () => {
    await createProduct(request("POST", { ...valid, costPrice: "0.1", sellingPrice: "9999999999.9999" })); // a selling price may still be sent
    const { url, init } = upstream();
    expect(url).toBe(`${INVENTORY}/api/v1/inventory/products`);
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body);
    expect(sent.cost_price).toBe("0.1");
    expect(sent.selling_price).toBe("9999999999.9999");
    expect(typeof sent.cost_price).toBe("string");
  });

  it("normalizes and forwards only the product fields", async () => {
    await createProduct(request("POST", { ...valid, sku: " wid-001 ", name: "  Steel   bolt", currencyCode: "usd", description: "Strong", hsCode: "7318.15" }));
    expect(JSON.parse(upstream().init.body)).toEqual({
      sku: "WID-001", name: "Steel bolt", description: "Strong", unit: "pcs", hs_code: "7318.15",
      cost_price: "0.1", currency_code: "USD",
    });
  });

  it("never forwards an organization id or any other field the browser invents", async () => {
    await createProduct(request("POST", {
      ...valid, organization_id: "00000000-0000-4000-8000-000000000000", organizationId: "x", tenant_id: "y", org: "z",
      id: ID, is_active: false, stock: 50, created_at: "2020-01-01",
    }));
    const sent = JSON.parse(upstream().init.body);
    expect(Object.keys(sent).sort()).toEqual(["cost_price", "currency_code", "name", "sku", "unit"]);
    expect(upstream().url).not.toContain("?");
  });

  it("returns the created product and nothing secret", async () => {
    const res = await createProduct(request("POST", valid));
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(JSON.parse(text).product.sku).toBe("WID-001");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("organization_id");
  });

  it.each([
    [409, { detail: "A product with SKU 'WID-001' already exists in your catalog." }, 409, "already exists"],
    [403, { detail: "Your organization is not active." }, 403, "not active"],
    [401, { detail: "Missing, invalid or expired token" }, 401, "session has expired"],
    [503, { detail: "Organization service unavailable" }, 503, "unavailable"],
    [500, { detail: "stack trace" }, 502, "could not be completed"],
  ])("maps a %i from the Inventory Service to a safe %i", async (upstreamStatus, body, status, fragment) => {
    stub(() => json(upstreamStatus, body));
    const res = await createProduct(request("POST", valid));
    expect(res.status).toBe(status);
    const data = await res.json();
    expect(data.error).toContain(fragment);
    expect(JSON.stringify(data)).not.toContain("stack trace");
  });

  it("puts a duplicate-SKU message on the SKU field", async () => {
    stub(() => json(409, { detail: "A product with SKU 'WID-001' already exists in your catalog." }));
    const data = await (await createProduct(request("POST", valid))).json();
    expect(data.fieldErrors.sku).toContain("WID-001");
  });

  it("maps the Inventory Service's validation errors onto the form fields", async () => {
    stub(() => json(422, { detail: [{ loc: ["body", "cost_price"], msg: "Input should be greater than or equal to 0" }, { loc: ["body", "hs_code"], msg: "Value error, HS code must look like 8517" }] }));
    const res = await createProduct(request("POST", valid));
    expect(res.status).toBe(400);
    const { fieldErrors } = await res.json();
    expect(fieldErrors.costPrice).toContain("greater than");
    expect(fieldErrors.hsCode).toBe("HS code must look like 8517");
  });

  it("answers 503 when the Inventory Service cannot be reached", async () => {
    stub(() => {
      throw new Error("ECONNREFUSED");
    });
    expect((await createProduct(request("POST", valid))).status).toBe(503);
  });
});

describe("PATCH /api/products/[id] (edit)", () => {
  beforeEach(() => stub(() => json(200, { ...product, name: "Renamed" })));

  it("validates the id and the body before calling the Inventory Service", async () => {
    expect((await editProduct(request("PATCH", { name: "X Y" }), ctx("not-a-uuid"))).status).toBe(404);
    expect((await editProduct(request("PATCH", "x", undefined, "text/plain"), ctx())).status).toBe(415);
    expect((await editProduct(request("PATCH", {}), ctx())).status).toBe(400);
    expect((await editProduct(request("PATCH", { organization_id: "x" }), ctx())).status).toBe(400); // nothing editable was sent
    expect((await editProduct(request("PATCH", { costPrice: "-5" }), ctx())).status).toBe(400);
    expect((await editProduct(request("PATCH", { name: "" }), ctx())).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only the fields that were sent, to the product's own URL", async () => {
    const res = await editProduct(request("PATCH", { name: " Renamed ", sellingPrice: "17.25", organization_id: "evil", organizationId: "evil" }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).product.name).toBe("Renamed");
    const { url, init } = upstream();
    expect(url).toBe(`${INVENTORY}/api/v1/inventory/products/${ID}`);
    expect(init.method).toBe("PATCH");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ name: "Renamed", selling_price: "17.25" });
  });

  it("clears optional fields with null", async () => {
    await editProduct(request("PATCH", { description: "", hsCode: "" }), ctx());
    expect(JSON.parse(upstream().init.body)).toEqual({ description: null, hs_code: null });
  });

  it("passes on 'not found' (another organization's product looks exactly like a missing one) and SKU conflicts", async () => {
    stub(() => json(404, { detail: "Product not found." }));
    const missing = await editProduct(request("PATCH", { name: "X Y" }), ctx());
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("Product not found.");
    stub(() => json(409, { detail: "A product with SKU 'DUP' already exists in your catalog." }));
    const conflict = await editProduct(request("PATCH", { sku: "dup" }), ctx());
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).fieldErrors.sku).toContain("DUP");
  });
});

describe("archive and restore", () => {
  beforeEach(() => stub(() => json(200, { ...product, is_active: false })));

  it.each([
    ["archive", archiveProduct],
    ["restore", restoreProduct],
  ])("%s calls the product's own endpoint as the signed-in administrator, with nothing from the browser", async (action, handler) => {
    const res = await handler(request("POST", { organization_id: "evil" }), ctx());
    expect(res.status).toBe(200);
    const { url, init } = upstream();
    expect(url).toBe(`${INVENTORY}/api/v1/inventory/products/${ID}/${action}`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBeUndefined();
  });

  it.each([archiveProduct, restoreProduct])("rejects a malformed id and maps backend errors", async (handler) => {
    expect((await handler(request("POST"), ctx("nope"))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    stub(() => json(404, { detail: "Product not found." }));
    expect((await handler(request("POST"), ctx())).status).toBe(404);
    stub(() => json(403, { detail: "Your organization is not active." }));
    expect((await handler(request("POST"), ctx())).status).toBe(403);
  });
});

// ---- reading: the product selector's search and the product dialog's "view one" -------------------------------------------------------------------
describe("GET /api/products (search the active catalog)", () => {
  const search = (query: string, cookie: string | null = `impex_tenant_session=${TOKEN}`) =>
    searchProducts(new NextRequest(`http://localhost:3001/api/products${query}`, { method: "GET", headers: cookie ? { cookie } : {} }));

  it("needs the tenant session (and not the Super Admin's)", async () => {
    expect((await search("?q=bolt", null)).status).toBe(401);
    expect((await search("?q=bolt", "impex_session=super-admin-token")).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the Inventory Service for ACTIVE products matching the text, with a small page and the session's Bearer token, and returns just the items", async () => {
    stub(() => json(200, { items: [product], total: 1, limit: 8, offset: 0 }));
    const res = await search("?q=%20wid%20&limit=50&organization_id=someone-else");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [product], total: 1 });
    const { url, init } = upstream();
    expect(new URL(url).pathname).toBe("/api/v1/inventory/products");
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ status: "active", limit: "20", q: "wid" }); // limit capped; no organization parameter forwarded
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("works without text (the first products), and maps a service failure", async () => {
    stub(() => json(200, { items: [], total: 0, limit: 8, offset: 0 }));
    expect((await search("")).status).toBe(200);
    expect(Object.fromEntries(new URL(upstream().url).searchParams)).toEqual({ status: "active", limit: "8" });
    stub(() => json(403, { detail: "inactive" }));
    expect((await search("?q=x")).status).toBe(403);
    stub(() => { throw new Error("down"); });
    expect((await search("?q=x")).status).toBe(503);
  });
});

describe("GET /api/products/[id] (one product with its barcodes)", () => {
  const view = (id = ID, cookie: string | null = `impex_tenant_session=${TOKEN}`) =>
    viewProduct(new NextRequest(`http://localhost:3001/api/products/${id}`, { method: "GET", headers: cookie ? { cookie } : {} }), ctx(id));
  const identifier = { id: "i1", kind: "manufacturer", value: "5901234123457", label: null, is_active: true, created_at: "2026-11-04T10:00:00+00:00" };

  it("needs the tenant session and a well-formed id before asking the service", async () => {
    expect((await view(ID, null)).status).toBe(401);
    expect((await view("not-a-uuid")).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the product, its registered barcodes and its label (none until one is generated)", async () => {
    stub((url) => (url.endsWith("/identifiers") ? json(200, { items: [identifier] }) : json(200, product)));
    const res = await view();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ product, identifiers: [identifier], label: null });
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).pathname).sort()).toEqual([`/api/v1/inventory/products/${ID}`, `/api/v1/inventory/products/${ID}/identifiers`]);
  });

  it("another organization's product looks exactly like a missing one (404), and failures are mapped", async () => {
    stub(() => json(404, { detail: "Product not found." }));
    expect((await view()).status).toBe(404);
    stub(() => json(401, {}));
    expect((await view()).status).toBe(401);
    stub(() => json(403, {}));
    expect((await view()).status).toBe(403);
    stub(() => { throw new Error("down"); });
    expect((await view()).status).toBe(503);
  });
});

describe("POST /api/products without a selling price", () => {
  it("registers a product that has none, and forwards none", async () => {
    const res = await createProduct(request("POST", valid));
    expect(res.status).toBe(201);
    expect(JSON.parse(upstream().init.body)).not.toHaveProperty("selling_price");
  });
});
