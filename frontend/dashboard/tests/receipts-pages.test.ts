import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { alphaOrg, orgAdmin, orgAdminB, superAdmin } from "./helpers";

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

import GoodsReceiptsLayout from "@/app/goods-receipts/layout";
import GoodsReceiptsPage from "@/app/goods-receipts/page";
import GoodsReceiptPage from "@/app/goods-receipts/[id]/page";
import ReceiveGoodsPage from "@/app/purchase-orders/[id]/receive/page";
import PurchaseOrderPage from "@/app/purchase-orders/[id]/page";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-07T10:00:00+00:00";
const A_ORDER = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718";
const B_ORDER = "9d4f3b3d-4e5f-4a6b-9bc3-d4e5f6071829";
const A_RECEIPT = "a1111111-1111-4111-8111-aaaaaaaaaaaa";
const B_RECEIPT = "b2222222-2222-4222-8222-bbbbbbbbbbbb";
const A_DRAFT = "a1111111-1111-4111-8111-dddddddddddd";
const A_SUPPLIER = "a1111111-1111-4111-8111-111111111111";
const B_SUPPLIER = "b2222222-2222-4222-8222-222222222222";
const W1 = "22222222-2222-4222-8222-222222222222";

const supplierRef = (id: string, name: string) => ({ id, name, code: null, is_active: true });
const receipt = (id: string, number: string, order: string, orderNumber: string, supplier: ReturnType<typeof supplierRef>, extra: Record<string, unknown> = {}) => ({
  id, number, status: "confirmed", purchase_order: { id: order, number: orderNumber, status: "partially_received" }, supplier, supplier_reference: `${supplier.name}-DN`,
  received_date: "2026-11-07", notes: null, line_count: 1, created_by_email: "a@b.c", created_at: now, confirmed_at: now, confirmed_by_email: "a@b.c", cancelled_at: null, cancelled_by_email: null,
  updated_at: now, ...extra,
});
const receiptDetail = (summary: ReturnType<typeof receipt>, product: string, extra: Record<string, unknown> = {}) => ({
  ...summary,
  lines: [{
    id: crypto.randomUUID(), purchase_order_line_id: crypto.randomUUID(), product_id: crypto.randomUUID(), product_sku: "SKU-1", product_name: product, unit: "pcs",
    ordered_quantity: "50.0000", received_elsewhere_quantity: "0.0000", pending_elsewhere_quantity: "0.0000", receivable_quantity: "50.0000",
    accepted_quantity: "30.0000", rejected_quantity: "2.0000", notes: null, inventory_movement_id: "c3c3c3c3-aaaa-4bbb-8ccc-123456789abc",
  }],
  posting: { attempts: 1, started_at: now, last_attempt_at: now, last_error: null }, inventory_operation_id: crypto.randomUUID(), editable: false,
  stock_notice: "Saving or reviewing a goods receipt does not change your stock. Stock is added only when you confirm the receipt, and only for the accepted quantities.", ...extra,
});
const orderDetail = (id: string, number: string, supplier: ReturnType<typeof supplierRef>, product: string, extra: Record<string, unknown> = {}) => ({
  id, number, supplier, supplier_reference: null, order_date: "2026-11-06", expected_delivery_date: null, currency_code: "USD", notes: null, status: "ordered", line_count: 1,
  total_amount: "62.5000", created_by_email: "a@b.c", ordered_at: now, ordered_by_email: "a@b.c", cancelled_at: null, cancelled_by_email: null, created_at: now, updated_at: now,
  lines: [{
    id: crypto.randomUUID(), product_id: crypto.randomUUID(), product_sku: "SKU-1", product_name: product, unit: "pcs", quantity: "50.0000", unit_price: "1.2500", line_total: "62.5000",
    notes: null, created_at: now, updated_at: now, received_quantity: "30.0000", pending_quantity: "0.0000", remaining_quantity: "20.0000",
  }],
  frozen: true, receipts: [], can_receive: true, stock_notice: "x", ...extra,
});

const alpha = supplierRef(A_SUPPLIER, "Alpha Metals");
const beta = supplierRef(B_SUPPLIER, "Beta Textiles");
const fresh = () => {
  const aReceipt = receipt(A_RECEIPT, "GR-000001", A_ORDER, "PO-000001", alpha);
  const bReceipt = receipt(B_RECEIPT, "GR-000001", B_ORDER, "PO-000001", beta);
  const aDraft = receipt(A_DRAFT, "GR-000002", A_ORDER, "PO-000001", alpha, { status: "draft", confirmed_at: null, confirmed_by_email: null });
  return {
    "token-alpha": {
      receipts: [aReceipt, aDraft], details: { [A_RECEIPT]: receiptDetail(aReceipt, "Alpha steel bolt"), [A_DRAFT]: receiptDetail(aDraft, "Alpha steel bolt", { editable: true }) } as Record<string, any>,
      orders: { [A_ORDER]: orderDetail(A_ORDER, "PO-000001", alpha, "Alpha steel bolt", { receipts: [aReceipt, aDraft] }) } as Record<string, any>,
    },
    "token-beta": {
      receipts: [bReceipt], details: { [B_RECEIPT]: receiptDetail(bReceipt, "Beta silk scarf") } as Record<string, any>,
      orders: { [B_ORDER]: orderDetail(B_ORDER, "PO-000001", beta, "Beta silk scarf", { receipts: [bReceipt] }) } as Record<string, any>,
    },
  };
};
let orgs = fresh();

let calls: { url: string; headers: Record<string, string>; method: string }[] = [];
function stubWorld(options: { status?: number } = {}) {
  calls = [];
  const users: Record<string, any> = { "token-alpha": orgAdmin, "token-beta": orgAdminB, "token-super": superAdmin };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers, method: init.method ?? "GET" });
      const token = (headers.Authorization ?? "").replace("Bearer ", "");
      if (url.endsWith("/api/v1/auth/me")) return users[token] ? json(200, users[token]) : json(401, {});
      if (url.endsWith("/api/v1/tenant/organization")) return users[token] ? json(200, alphaOrg) : json(401, {}); // the layout asks for the organization (its setup and its modules)
      if (!url.includes("/api/v1/purchasing/")) return json(404, {});
      if (options.status) return json(options.status, { detail: "x" });
      const org = (orgs as any)[token];
      if (!org) return json(401, {});
      const path = new URL(url).pathname.replace("/api/v1/purchasing", "");
      const params = new URL(url).searchParams;
      const page = (items: any[]) => json(200, { items, total: items.length, limit: Number(params.get("limit")), offset: Number(params.get("offset")) });
      if (path === "/suppliers") return page([]);
      if (path === "/goods-receipts") return page(org.receipts.filter((r: any) => !params.get("status") || r.status === params.get("status")));
      let match = path.match(/^\/goods-receipts\/([^/]+)$/);
      if (match) return org.details[match[1]] ? json(200, org.details[match[1]]) : json(404, { detail: "Goods receipt not found." });
      match = path.match(/^\/purchase-orders\/([^/]+)$/);
      if (match) return org.orders[match[1]] ? json(200, org.orders[match[1]]) : json(404, { detail: "Purchase order not found." });
      return json(404, {});
    })
  );
}
const purchasingCalls = () => calls.filter((c) => c.url.includes("/api/v1/purchasing/"));
const render = async (element: Promise<any>) => renderToStaticMarkup(await element);

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.INVENTORY_SERVICE_URL = "http://inventory-service:8002";
  process.env.PURCHASING_SERVICE_URL = "http://purchasing-service:8004";
  for (const key of Object.keys(jar)) delete jar[key];
  orgs = fresh();
});
afterEach(() => vi.unstubAllGlobals());

describe("Goods Receipts page", () => {
  it("lists the receipts with number, order, supplier, date, lines and status", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(GoodsReceiptsPage({ searchParams: {} }));
    for (const expected of ["Goods Receipts", "GR-000001", "GR-000002", "PO-000001", "Alpha Metals", "2026-11-07", "Confirmed", "Draft", "All statuses", "All suppliers", "Showing 1–2 of 2", "stock is added only when a receipt is confirmed"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).toContain(`href="/goods-receipts/${A_RECEIPT}"`);
  });

  it("two organizations: each sees only their own receipts", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const a = await render(GoodsReceiptsPage({ searchParams: {} }));
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const b = await render(GoodsReceiptsPage({ searchParams: {} }));
    expect(a).toContain("Alpha Metals");
    expect(a).not.toContain("Beta Textiles");
    expect(b).toContain("Beta Textiles");
    expect(b).not.toContain("Alpha Metals");
  });

  it("passes only whitelisted filters to the service", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await GoodsReceiptsPage({ searchParams: { q: "dn", status: "confirmed", supplier: A_SUPPLIER, warehouse: W1, from: "2026-11-01", to: "2026-11-30", page: "2", organization_id: B_SUPPLIER, sort: "x" } });
    const call = purchasingCalls().find((c) => new URL(c.url).pathname === "/api/v1/purchasing/goods-receipts")!;
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({
      q: "dn", status: "confirmed", supplier_id: A_SUPPLIER, date_from: "2026-11-01", date_to: "2026-11-30", limit: "25", offset: "25",
    });
    calls = [];
    await GoodsReceiptsPage({ searchParams: { status: "shipped", supplier: "' OR 1=1", warehouse: "x", from: "yesterday", to: "../", page: "banana" } });
    const clean = purchasingCalls().find((c) => new URL(c.url).pathname === "/api/v1/purchasing/goods-receipts")!;
    expect([...new URL(clean.url).searchParams.keys()].sort()).toEqual(["limit", "offset"]);
  });

  it("redirects without a session / for a Super Admin, calling no purchasing endpoint", async () => {
    stubWorld();
    await expect(GoodsReceiptsPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(GoodsReceiptsPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    expect(purchasingCalls()).toHaveLength(0);
  });

  it("explains an inactive organization, an outage and an expired session; and an empty list", async () => {
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 403 });
    expect(await render(GoodsReceiptsPage({ searchParams: {} }))).toContain("currently inactive or unavailable");
    stubWorld({ status: 503 });
    expect(await render(GoodsReceiptsPage({ searchParams: {} }))).toContain("temporarily unavailable");
    stubWorld({ status: 401 });
    await expect(GoodsReceiptsPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    orgs["token-alpha"].receipts = [];
    stubWorld();
    expect(await render(GoodsReceiptsPage({ searchParams: {} }))).toContain("No goods receipts yet");
    expect(await render(GoodsReceiptsPage({ searchParams: { q: "zzz" } }))).toContain("No goods receipts match these filters");
  });
});

describe("one goods receipt", () => {
  const page = (id: string) => render(GoodsReceiptPage({ params: { id } }));

  it("shows the order, the accepted and rejected quantities and the stock movement", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_RECEIPT);
    for (const expected of ["GR-000001", "Confirmed", "PO-000001", "Alpha Metals", "Alpha steel bolt", "SKU-1", "30", "Rejected", "#c3c3c3c3", "confirmed by a@b.c", "does not change your stock"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).toContain(`href="/movements?product=`);
    expect(html).not.toContain("Retry posting");
    expect(html).not.toContain("Confirm and add to stock");
  });

  it("a draft can be edited, confirmed or discarded", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_DRAFT);
    for (const expected of ["GR-000002", "Edit receipt", "Confirm and add to stock", "Discard draft"]) expect(html, expected).toContain(expected);
    expect(html).toContain(`/purchase-orders/${A_ORDER}/receive?receipt=${A_DRAFT}`);
  });

  it("a receipt being posted says so and offers a retry, with the reason", async () => {
    orgs["token-alpha"].details[A_DRAFT] = receiptDetail(orgs["token-alpha"].receipts[1], "Alpha steel bolt", {
      status: "posting", editable: false, posting: { attempts: 2, started_at: now, last_attempt_at: now, last_error: "The inventory service did not answer (ReadTimeout)." },
    });
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_DRAFT);
    for (const expected of ["Posting to stock", "being added to stock", "Retry posting", "Attempts: 2", "did not answer", "cannot be added twice"]) expect(html, expected).toContain(expected);
    expect(html).not.toContain("Edit receipt");
  });

  it("two organizations: another organization's receipt is simply 'not found'", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const own = await page(A_RECEIPT);
    const foreign = await page(B_RECEIPT);
    expect(own).toContain("Alpha steel bolt");
    expect(foreign).toContain("Goods receipt not found.");
    for (const leak of ["Beta", "scarf", "Textiles"]) expect(own + foreign, `alpha saw ${leak}`).not.toContain(leak);
  });

  it("does not call the service for something that is not an id, and redirects when signed out", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await page("../../etc/passwd")).toContain("Goods receipt not found.");
    expect(purchasingCalls()).toHaveLength(0);
    delete jar[TENANT_SESSION_COOKIE];
    await expect(page(A_RECEIPT)).rejects.toThrow("REDIRECT:/login");
  });
});

describe("Receive goods page", () => {
  const page = (id: string, searchParams: Record<string, string> = {}) => render(ReceiveGoodsPage({ params: { id }, searchParams }));

  it("shows what is ordered, received and remaining, with the accepted / rejected inputs and the 'no stock yet' notice", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_ORDER);
    for (const expected of ["Receive goods", "PO-000001", "Alpha steel bolt", "Ordered", "Received", "Remaining", "Accepted now", "Rejected now", "Review receipt", "Find a product on this order", "does not change your stock"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html.toLowerCase()).not.toContain("warehouse");
  });

  it.each([
    ["draft", "still a draft"], ["cancelled", "is cancelled"], ["received", "already fully received"], ["partially_received", "nothing left to receive right now"],
  ])("an order that is %s cannot be received against", async (status, phrase) => {
    orgs["token-alpha"].orders[A_ORDER] = { ...orgs["token-alpha"].orders[A_ORDER], status, can_receive: false };
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_ORDER);
    expect(html).toContain(phrase);
    expect(html).not.toContain("Review receipt");
  });

  it("resumes a draft only if it belongs to this order and is still a draft", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await page(A_ORDER, { receipt: A_DRAFT })).toContain("Editing the draft");
    expect(await page(A_ORDER, { receipt: A_RECEIPT })).not.toContain("Editing the draft"); // confirmed: not editable
    expect(await page(A_ORDER, { receipt: B_RECEIPT })).not.toContain("Editing the draft"); // another organization's
    expect(await page(A_ORDER, { receipt: "not-an-id" })).not.toContain("Editing the draft");
  });

  it("another organization's order is 'not found'; garbage ids never reach the service; signed-out users are redirected", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const foreign = await page(B_ORDER);
    expect(foreign).toContain("Purchase order not found.");
    expect(foreign).not.toContain("Beta");
    calls = [];
    expect(await page("../x")).toContain("Purchase order not found.");
    expect(purchasingCalls()).toHaveLength(0);
    delete jar[TENANT_SESSION_COOKIE];
    await expect(page(A_ORDER)).rejects.toThrow("REDIRECT:/login");
  });
});

describe("the purchase order page", () => {
  const page = (id: string) => render(PurchaseOrderPage({ params: { id } }));

  it("offers Receive goods, shows received and remaining quantities and lists the receipts", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_ORDER);
    for (const expected of ["Receive goods", `/purchase-orders/${A_ORDER}/receive`, "Received", "Remaining", "Goods receipts (2)", "GR-000001", "GR-000002", "Confirmed", "Draft", "Cancel order"]) {
      expect(html, expected).toContain(expected);
    }
  });

  it("a Received order has no Receive goods button and cannot be cancelled", async () => {
    orgs["token-alpha"].orders[A_ORDER] = { ...orgs["token-alpha"].orders[A_ORDER], status: "received", can_receive: false };
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_ORDER);
    expect(html).toContain("Everything on this order has been received");
    expect(html).not.toContain("Receive goods");
    expect(html).not.toContain("Cancel order");
  });

  it("a Partially Received order cannot be cancelled either", async () => {
    orgs["token-alpha"].orders[A_ORDER] = { ...orgs["token-alpha"].orders[A_ORDER], status: "partially_received" };
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_ORDER);
    expect(html).toContain("Partially Received");
    expect(html).toContain("can no longer be cancelled");
    expect(html).not.toContain("Cancel order");
  });
});

describe("navigation", () => {
  it("the Goods Receipts layout redirects invalid sessions, marks itself current and every page links to it", async () => {
    stubWorld();
    await expect((GoodsReceiptsLayout as any)({ children: null })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = renderToStaticMarkup(await (GoodsReceiptsLayout as any)({ children: "PAGE" }));
    expect((html.match(/<a[^>]*aria-current="page"[^>]*>(.*?)<\/a>/)?.[1] ?? "").replace(/<[^>]+>/g, "")).toBe("Goods Receipts");
    for (const href of ["/", "/products", "/stock", "/movements", "/delivery-lists", "/clients", "/suppliers", "/purchase-orders", "/goods-receipts"]) expect(html).toContain(`href="${href}"`);
  });
});
