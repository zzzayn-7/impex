import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as resolveCode } from "@/app/api/scan/resolve/route";
import { POST as registerBarcode } from "@/app/api/products/[id]/identifiers/route";
import { POST as generateCode } from "@/app/api/products/[id]/identifiers/generate/route";
import { POST as retireBarcode } from "@/app/api/products/[id]/identifiers/[identifierId]/retire/route";

const ID = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const IDENT = "11111111-1111-4111-8111-111111111111";
const TOKEN = "tenant-session-token";
const INVENTORY = "http://inventory-service:8002";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
const stub = (handler: (url: string, init: any) => Response) => {
  fetchMock = vi.fn(async (url: any, init: any) => handler(String(url), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
};

const get = (code: string | null, cookie: string | null = `impex_tenant_session=${TOKEN}`, extra = "") =>
  new NextRequest(`http://localhost:3001/api/scan/resolve${code === null ? "" : `?code=${encodeURIComponent(code)}`}${extra}`, {
    method: "GET",
    headers: cookie ? { cookie } : {},
  });
const post = (body?: unknown, cookie: string | null = `impex_tenant_session=${TOKEN}`, type: string | null = "application/json") =>
  new NextRequest("http://localhost:3001/api/x", {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), ...(type ? { "content-type": type } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const upstream = () => ({ url: fetchMock.mock.calls[0][0] as string, init: fetchMock.mock.calls[0][1] as any });
const scanned = { matched_by: "identifier", identifier_kind: "generated", product: { id: ID, name: "Bolt" }, stock: { total_quantity: "5.0000" } };

beforeEach(() => {
  process.env.INVENTORY_SERVICE_URL = INVENTORY;
  stub(() => json(200, scanned));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/scan/resolve", () => {
  it("is protected by the tenant session and calls nothing without one", async () => {
    expect((await resolveCode(get("BOLT-1", null))).status).toBe(401);
    expect((await resolveCode(get("BOLT-1", "impex_session=super-admin-token"))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the normalized code with the session token as the Bearer token, and returns the product and stock", async () => {
    const res = await resolveCode(get("  imx-abc234defghj\r\n"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(scanned);
    expect(upstream().url).toBe(`${INVENTORY}/api/v1/inventory/scan/resolve?code=IMX-ABC234DEFGHJ`);
    expect(upstream().init.method).toBe("GET");
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("strips a scanner's AIM prefix before asking", async () => {
    await resolveCode(get("]C0BOLT-1"));
    expect(upstream().url).toContain("code=BOLT-1");
  });

  it("never names an organization, whatever the browser sends", async () => {
    await resolveCode(get("BOLT-1", undefined, "&organization_id=evil&org_id=evil&tenant=evil"));
    expect(upstream().url).not.toMatch(/organization|org_id|tenant/i);
    expect(upstream().init.body).toBeUndefined();
    expect(Object.keys(upstream().init.headers)).toEqual(["Authorization"]);
  });

  it.each([null, "", "   ", "two words", "x".repeat(65), "emoji😀"])("refuses the code %j without calling the service", async (code) => {
    const res = await resolveCode(get(code));
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["http://evil.example/pay?x=1", "https://evil.example", "javascript:alert(1)", "data:text/html;base64,AAAA"])(
    "refuses the link %j: it is not fetched, followed or even forwarded",
    async (link) => {
      const res = await resolveCode(get(link));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("not opened");
      expect(fetchMock).not.toHaveBeenCalled(); // no request at all: not to the link, not to the service
    }
  );

  it.each([
    [404, "No product in your catalog matches this code.", 404],
    [410, "This barcode was retired and no longer identifies a product.", 410],
    [409, "This code matches more than one product.", 409],
    [403, "Your organization is not active.", 403],
    [401, "x", 401],
    [503, "x", 503],
  ])("passes service answer %i on as %i with a readable message", async (from, detail, to) => {
    stub(() => json(from, { detail }));
    const res = await resolveCode(get("BOLT-1"));
    expect(res.status).toBe(to);
    expect(typeof (await res.json()).error).toBe("string");
  });

  it("reports an unreachable service as 503 without leaking details, and a crash as a generic 502", async () => {
    stub(() => { throw new Error("connect ECONNREFUSED 10.0.0.5:8002"); });
    const down = await resolveCode(get("BOLT-1"));
    expect(down.status).toBe(503);
    expect(JSON.stringify(await down.json())).not.toContain("10.0.0.5");
    stub(() => json(500, { detail: "Traceback: secret.py" }));
    const crash = await resolveCode(get("BOLT-1"));
    expect(crash.status).toBe(502);
    expect(JSON.stringify(await crash.json())).not.toContain("secret.py");
  });

  it("is read-only: it makes exactly one GET and never a write", async () => {
    await resolveCode(get("BOLT-1"));
    await resolveCode(get("BOLT-1"));
    expect(fetchMock.mock.calls.map((c) => (c[1] as any).method)).toEqual(["GET", "GET"]);
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes("/stock/in") && !String(c[0]).includes("/stock/out") && !String(c[0]).includes("/stock/transfer"))).toBe(true);
  });
});

describe("POST /api/products/[id]/identifiers (register a barcode)", () => {
  const ctx = (id = ID) => ({ params: { id } });
  beforeEach(() => stub(() => json(201, { id: IDENT, value: "5901234123457" })));

  it("needs a session", async () => {
    expect((await registerBarcode(post({ kind: "supplier", value: "X1" }, null), ctx())).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only kind, the normalized value and the note", async () => {
    const res = await registerBarcode(post({ kind: "supplier", value: " 5901234-abc ", label: "  Acme   Ltd ", organization_id: "evil", product_id: "evil", is_active: false }), ctx());
    expect(res.status).toBe(201);
    expect(upstream().url).toBe(`${INVENTORY}/api/v1/inventory/products/${ID}/identifiers`);
    expect(JSON.parse(upstream().init.body)).toEqual({ kind: "supplier", value: "5901234-ABC", label: "Acme Ltd" });
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    [{ kind: "generated", value: "X1" }, "kind"], [{ value: "X1" }, "kind"], [{ kind: "supplier" }, "value"],
    [{ kind: "supplier", value: "has space" }, "value"], [{ kind: "supplier", value: "https://evil.example" }, "value"],
    [{ kind: "supplier", value: "OK-1", label: "x".repeat(101) }, "label"],
  ])("rejects %j on the %s field without calling the service", async (body, field) => {
    const res = await registerBarcode(post(body), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors).toHaveProperty(field);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects bad ids, non-JSON and broken JSON", async () => {
    expect((await registerBarcode(post({ kind: "supplier", value: "X1" }), ctx("nope"))).status).toBe(404);
    expect((await registerBarcode(post("x=1", undefined, "text/plain"), ctx())).status).toBe(415);
    expect((await registerBarcode(post("{broken"), ctx())).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a code that already belongs to another product under the barcode field", async () => {
    stub(() => json(409, { detail: "DUP-1 is already assigned to Other (OTHER) in your catalog. A code can identify only one product." }));
    const res = await registerBarcode(post({ kind: "manufacturer", value: "DUP-1" }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).fieldErrors.value).toContain("only one product");
  });

  it("answers 404 for another organization's product exactly like a missing one", async () => {
    stub(() => json(404, { detail: "Product not found." }));
    const res = await registerBarcode(post({ kind: "supplier", value: "X1" }), ctx());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Product not found.");
  });
});

describe("generate and retire", () => {
  it("generate: protected, validates the id, passes 201 and 200 through", async () => {
    expect((await generateCode(post(undefined, null, null), { params: { id: ID } })).status).toBe(401);
    expect((await generateCode(post(undefined, undefined, null), { params: { id: "../x" } })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    stub(() => json(201, { id: IDENT, value: "IMX-ABC234DEFGHJ" }));
    const first = await generateCode(post(undefined, undefined, null), { params: { id: ID } });
    expect(first.status).toBe(201);
    expect((await first.json()).created).toBe(true);
    expect(upstream().url).toBe(`${INVENTORY}/api/v1/inventory/products/${ID}/identifiers/generate`);
    stub(() => json(200, { id: IDENT, value: "IMX-ABC234DEFGHJ" }));
    const again = await generateCode(post(undefined, undefined, null), { params: { id: ID } });
    expect(again.status).toBe(200);
    expect((await again.json()).created).toBe(false);
  });

  it("generate: an archived product's 409 reaches the user", async () => {
    stub(() => json(409, { detail: "Bolt is archived. Restore it before generating codes." }));
    const res = await generateCode(post(undefined, undefined, null), { params: { id: ID } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("archived");
  });

  it("retire: protected, validates both ids, calls the matching endpoint", async () => {
    stub(() => json(200, { id: IDENT, is_active: false }));
    expect((await retireBarcode(post(undefined, null, null), { params: { id: ID, identifierId: IDENT } })).status).toBe(401);
    expect((await retireBarcode(post(undefined, undefined, null), { params: { id: ID, identifierId: "bad" } })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await retireBarcode(post(undefined, undefined, null), { params: { id: ID, identifierId: IDENT } })).status).toBe(200);
    expect(upstream().url).toBe(`${INVENTORY}/api/v1/inventory/products/${ID}/identifiers/${IDENT}/retire`);
  });

  it("retire: the label code's 409 reaches the user", async () => {
    stub(() => json(409, { detail: "The Impex label code of a product cannot be retired: printed labels depend on it." }));
    const res = await retireBarcode(post(undefined, undefined, null), { params: { id: ID, identifierId: IDENT } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("printed labels");
  });
});
