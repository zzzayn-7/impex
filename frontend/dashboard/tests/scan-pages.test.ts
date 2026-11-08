import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ORG_B_ID, ORG_ID, orgAdmin, orgAdminB, superAdmin, alphaOrg } from "./helpers";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => null,
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import ProductForm from "@/app/products/product-form";
import ProductCodesPage from "@/app/products/[id]/codes/page";
import ScanLayout from "@/app/scan/layout";
import ScanPage from "@/app/scan/page";
import { describeFailure } from "@/lib/inventory";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-05T10:00:00+00:00";
const ALPHA_PRODUCT = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718"; // deliberately not the organization id from helpers
const BETA_PRODUCT = "7b2d1f1b-2c3d-4e4f-9fa1-b2c3d4e5f607";

const product = (id: string, sku: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, sku, name, description: null, category: "General", unit: "pcs", unit_allows_fractions: false, unit_locked: false, hs_code: null,
  cost_price: "1.0000", selling_price: "2.0000", currency_code: "USD", is_active: true, created_at: now, updated_at: now, ...extra,
});
const identifier = (productId: string, kind: string, value: string, extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), product_id: productId, kind, value, label: null, is_active: true, created_by_email: "a@b.c", created_at: now, retired_at: null, ...extra,
});
const label = (p: ReturnType<typeof product>, code: string) => ({
  product: { id: p.id, sku: p.sku, name: p.name, unit: p.unit },
  identifier: identifier(p.id, "generated", code),
  code,
  qr_svg: `<svg xmlns="http://www.w3.org/2000/svg"><title>${code}</title><path d="M0 0h1v1H0z"/></svg>`,
  barcode_svg: `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="9"/></svg>`,
});

type Org = { products: Record<string, ReturnType<typeof product>>; identifiers: Record<string, any[]>; labels: Record<string, any>; warehouses: any[] };
const alpha: Org = (() => {
  const p = product(ALPHA_PRODUCT, "ALPHA-1", "Alpha steel bolt");
  return {
    products: { [p.id]: p },
    identifiers: { [p.id]: [identifier(p.id, "generated", "IMX-ALPHACODE234"), identifier(p.id, "supplier", "ACME-ALPHA-77", { label: "Acme Alpha Ltd" })] },
    labels: { [p.id]: label(p, "IMX-ALPHACODE234") },
    warehouses: [{ id: "w1", code: "AMAIN", name: "Alpha main", address: null, is_active: true, created_at: now, updated_at: now, products_in_stock: 1 }],
  };
})();
const beta: Org = (() => {
  const p = product(BETA_PRODUCT, "BETA-1", "Beta silk scarf");
  return {
    products: { [p.id]: p },
    identifiers: { [p.id]: [identifier(p.id, "generated", "IMX-BETACODE5678")] },
    labels: { [p.id]: label(p, "IMX-BETACODE5678") },
    warehouses: [{ id: "w2", code: "BMAIN", name: "Beta main", address: null, is_active: true, created_at: now, updated_at: now, products_in_stock: 0 }],
  };
})();

let calls: { url: string; headers: Record<string, string>; method: string }[] = [];
function stubWorld(options: { status?: number; orgs?: Record<string, Org> } = {}) {
  calls = [];
  const orgs = options.orgs ?? { "token-alpha": alpha, "token-beta": beta };
  const users: Record<string, any> = { "token-alpha": orgAdmin, "token-beta": orgAdminB, "token-super": superAdmin };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers, method: init.method ?? "GET" });
      const token = (headers.Authorization ?? "").replace("Bearer ", "");
      if (url.endsWith("/api/v1/auth/me")) return users[token] ? json(200, users[token]) : json(401, {});
      if (url.endsWith("/api/v1/tenant/organization")) return users[token] ? json(200, alphaOrg) : json(401, {}); // the layout checks first-time setup
      if (!url.includes("/api/v1/inventory/")) return json(404, {});
      if (options.status) return json(options.status, { detail: "x" });
      const org = orgs[token];
      if (!org) return json(401, {});
      const path = new URL(url).pathname.replace("/api/v1/inventory", "");
      if (path === "/warehouses") return json(200, { items: org.warehouses, total: org.warehouses.length, limit: 200, offset: 0 });
      const match = path.match(/^\/products\/([^/]+)(\/identifiers|\/label)?$/);
      if (match) {
        const [, id, tail] = match;
        const found = org.products[id];
        if (!found) return json(404, { detail: "Product not found." }); // another organization's product looks exactly like this
        if (tail === "/identifiers") return json(200, { items: org.identifiers[id] });
        if (tail === "/label") return json(200, org.labels[id]);
        return json(200, found);
      }
      return json(404, {});
    })
  );
}
const inventoryCalls = () => calls.filter((c) => c.url.includes("/api/v1/inventory/"));

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.INVENTORY_SERVICE_URL = "http://inventory-service:8002";
  for (const key of Object.keys(jar)) delete jar[key];
});
afterEach(() => vi.unstubAllGlobals());

describe("Scan Product page", () => {
  it("renders the scan box, the camera button and the scanner hint", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = renderToStaticMarkup(await ScanPage({ searchParams: {} }));
    for (const expected of ['id="scan-input"', "autofocus", "Scan Product", "Use camera", "Look up", "USB and Bluetooth scanners", "Scanning only looks the product up"]) {
      expect(html.toLowerCase(), expected).toContain(expected.toLowerCase());
    }
  });

  it("does not start the camera or load anything but the organization's own warehouses", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = renderToStaticMarkup(await ScanPage({ searchParams: {} }));
    expect(html).not.toContain("Start camera"); // the camera panel does not even exist until the user asks for it
    expect(inventoryCalls().map((c) => new URL(c.url).pathname)).toEqual(["/api/v1/inventory/warehouses"]);
    expect(inventoryCalls()[0].headers.Authorization).toBe("Bearer token-alpha");
    expect(inventoryCalls().every((c) => !/organization|tenant|org_id/i.test(c.url))).toBe(true);
  });

  it("redirects without a session, for a Super Admin and for the wrong cookie, calling no inventory endpoint", async () => {
    stubWorld();
    await expect(ScanPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(ScanPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    delete jar[TENANT_SESSION_COOKIE];
    jar["impex_session"] = "token-alpha";
    await expect(ScanPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    expect(inventoryCalls()).toHaveLength(0);
  });

  it("is reachable from the navigation as 'Scan Product', marked current, and redirects invalid sessions before streaming", async () => {
    stubWorld();
    await expect(ScanLayout({ children: null })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = renderToStaticMarkup(await ScanLayout({ children: "PAGE" }));
    expect(html).toContain("PAGE");
    expect((html.match(/<a[^>]*aria-current="page"[^>]*>(.*?)<\/a>/)?.[1] ?? "").replace(/<[^>]+>/g, "")).toBe("Scan Product");
    for (const href of ["/", "/products", "/warehouses", "/stock", "/scan", "/movements"]) expect(html).toContain(`href="${href}"`);
  });
});

describe("Product codes & labels page", () => {
  const render = async (id: string) => renderToStaticMarkup(await ProductCodesPage({ params: { id } }));

  it("shows the label, the supplier barcode and the controls for the product", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(ALPHA_PRODUCT);
    for (const expected of ["Codes &amp; labels", "Alpha steel bolt", "ALPHA-1", "IMX-ALPHACODE234", "ACME-ALPHA-77", "Acme Alpha Ltd", "Print label", "Register barcode", "Retire", "data:image/svg+xml"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).toContain("Copies to print");
  });

  it("two organizations: each sees only its own product's codes, and the other's product id is simply 'not found'", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const alphaOwn = await render(ALPHA_PRODUCT);
    const alphaTriesBeta = await render(BETA_PRODUCT);
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const betaOwn = await render(BETA_PRODUCT);
    const betaTriesAlpha = await render(ALPHA_PRODUCT);

    expect(alphaOwn).toContain("IMX-ALPHACODE234");
    expect(betaOwn).toContain("IMX-BETACODE5678");
    for (const leak of ["Beta silk scarf", "BETA-1", "IMX-BETACODE5678"]) expect(alphaOwn + alphaTriesBeta, `alpha saw ${leak}`).not.toContain(leak);
    for (const leak of ["Alpha steel bolt", "ALPHA-1", "IMX-ALPHACODE234", "ACME-ALPHA-77"]) expect(betaOwn + betaTriesAlpha, `beta saw ${leak}`).not.toContain(leak);
    expect(alphaTriesBeta).toContain("Product not found.");
    expect(betaTriesAlpha).toContain("Product not found.");
  });

  it("never names an organization when asking the service, and uses the session token", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await render(ALPHA_PRODUCT);
    for (const call of inventoryCalls()) {
      expect(call.headers.Authorization).toBe("Bearer token-alpha");
      expect(call.url).not.toMatch(new RegExp(`organization|tenant|${ORG_ID}|${ORG_B_ID}`, "i"));
    }
    expect(new Set(inventoryCalls().map((c) => new URL(c.url).pathname))).toEqual(
      new Set([`/api/v1/inventory/products/${ALPHA_PRODUCT}`, `/api/v1/inventory/products/${ALPHA_PRODUCT}/identifiers`, `/api/v1/inventory/products/${ALPHA_PRODUCT}/label`])
    );
  });

  it("only reads: viewing the page never generates a code, and a product without one shows the Generate button", async () => {
    const bare = product(ALPHA_PRODUCT, "ALPHA-1", "Alpha steel bolt");
    stubWorld({ orgs: { "token-alpha": { products: { [bare.id]: bare }, identifiers: { [bare.id]: [] }, labels: {}, warehouses: [] } } });
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(ALPHA_PRODUCT);
    expect(html).toContain("Generate QR code &amp; barcode");
    expect(html).not.toContain("Print label");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/label"))).toBe(false); // the label endpoint would create the code
  });

  it("does not call the service for something that is not an id", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render("../../etc/passwd")).toContain("Product not found.");
    expect(inventoryCalls()).toHaveLength(0);
  });

  it("redirects without a session or for a Super Admin, and explains inactive / unavailable states", async () => {
    stubWorld();
    await expect(render(ALPHA_PRODUCT)).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(render(ALPHA_PRODUCT)).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 403 });
    expect(await render(ALPHA_PRODUCT)).toContain("currently inactive or unavailable");
    stubWorld({ status: 503 });
    expect(await render(ALPHA_PRODUCT)).toContain("temporarily unavailable");
    stubWorld({ status: 401 });
    await expect(render(ALPHA_PRODUCT)).rejects.toThrow("REDIRECT:/login");
  });
});

describe("the unit of measurement in the product form", () => {
  const form = (p: ReturnType<typeof product>) =>
    renderToStaticMarkup(createElement(ProductForm, { product: p as any, categories: [], onDone: () => undefined, onCancel: () => undefined }));

  it("is locked, with the reason, once the product has stock movements", () => {
    const html = form(product(ALPHA_PRODUCT, "ALPHA-1", "Alpha steel bolt", { unit_locked: true }));
    expect(html).toMatch(/<input[^>]*id="product-unit"[^>]*disabled=""/);
    expect(html).toContain("already has stock movements");
  });

  it("stays editable while there is no history", () => {
    const html = form(product(ALPHA_PRODUCT, "ALPHA-1", "Alpha steel bolt", { unit_locked: false }));
    expect(html).not.toMatch(/<input[^>]*id="product-unit"[^>]*disabled=""/);
    expect(html).not.toContain("already has stock movements");
  });

  it("a refused unit change is reported under the Unit field, not the SKU", () => {
    const message = "The unit of measurement cannot be changed because this product already has stock movements.";
    const failure = describeFailure({ status: 409, data: { detail: message } });
    expect(failure.status).toBe(409);
    expect(failure.fieldErrors).toEqual({ unit: message });
    expect(describeFailure({ status: 409, data: { detail: "A product with SKU 'X' already exists in your catalog." } }).fieldErrors).toHaveProperty("sku");
  });
});
