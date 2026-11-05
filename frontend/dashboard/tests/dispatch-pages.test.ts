import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { orgAdmin, orgAdminB, superAdmin } from "./helpers";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import DispatchesLayout from "@/app/dispatches/layout";
import DispatchesPage from "@/app/dispatches/page";
import DispatchPage from "@/app/dispatches/[id]/page";
import PrepareDispatchPage from "@/app/delivery-lists/[id]/dispatch/page";
import DeliveryListPage from "@/app/delivery-lists/[id]/page";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-07T10:00:00+00:00";
const A_LIST = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718";
const B_LIST = "9d4f3b3d-4e5f-4a6b-9bc3-d4e5f6071829";
const A_DISPATCH = "a1111111-1111-4111-8111-aaaaaaaaaaaa";
const B_DISPATCH = "b2222222-2222-4222-8222-bbbbbbbbbbbb";
const A_DRAFT = "a1111111-1111-4111-8111-dddddddddddd";
const A_CLIENT = "a1111111-1111-4111-8111-111111111111";
const B_CLIENT = "b2222222-2222-4222-8222-222222222222";
const W1 = "22222222-2222-4222-8222-222222222222";

const client = (id: string, name: string) => ({ id, name, is_active: true });
const dispatchSummary = (id: string, number: string, list: string, listNumber: string, c: ReturnType<typeof client>, extra: Record<string, unknown> = {}) => ({
  id, number, status: "confirmed", delivery_list: { id: list, number: listNumber, status: "partially_dispatched" }, client: c, dispatch_date: "2026-11-07",
  tracking_reference: `${c.name}-TRK`, line_count: 1, created_by_email: "a@b.c", created_at: now, confirmed_at: now, confirmed_by_email: "a@b.c", cancelled_at: null, cancelled_by_email: null,
  updated_at: now, ...extra,
});
const dispatchDetail = (summary: ReturnType<typeof dispatchSummary>, product: string, extra: Record<string, unknown> = {}) => ({
  ...summary, delivery_address: "1 Dock Rd", transport_details: "Truck 4", notes: null,
  lines: [{
    id: crypto.randomUUID(), delivery_list_item_id: crypto.randomUUID(), product_id: crypto.randomUUID(), product_sku: "SKU-1", product_name: product, unit: "pcs",
    requested_quantity: "15.0000", dispatched_elsewhere_quantity: "0.0000", pending_elsewhere_quantity: "0.0000", dispatchable_quantity: "15.0000", warehouse_id: W1, warehouse_code: "MAIN",
    quantity: "10.0000", inventory_movement_id: "c3c3c3c3-aaaa-4bbb-8ccc-123456789abc", available_in_warehouse: null,
  }],
  posting: { attempts: 1, started_at: now, last_attempt_at: now, last_error: null }, inventory_operation_id: crypto.randomUUID(), editable: false, stock_status: "not-needed",
  lines_exceeding_stock: 0, stock_notice: "Preparing, saving or reviewing a dispatch does not change your stock. Stock is deducted only when you confirm the dispatch, and only the quantities on its lines.", ...extra,
});
const listDetail = (id: string, number: string, c: ReturnType<typeof client>, product: string, extra: Record<string, unknown> = {}) => ({
  id, number, client: c, external_reference: null, status: "partially_dispatched", notes: null, item_count: 1, created_by_email: "a@b.c", created_at: now, updated_at: now,
  items: [{
    id: crypto.randomUUID(), product_id: crypto.randomUUID(), product_sku: "SKU-1", product_name: product, quantity: "15.0000", unit: "pcs", planned_warehouse_id: null, planned_warehouse_code: null,
    created_at: now, updated_at: now, stock: null, dispatched_quantity: "10.0000", pending_quantity: "0.0000", remaining_quantity: "5.0000",
  }],
  stock_status: "ok", items_exceeding_stock: 0, stock_notice: "x", dispatches: [], can_dispatch: true, ...extra,
});

const alpha = client(A_CLIENT, "Alpha Metals");
const beta = client(B_CLIENT, "Beta Textiles");
const fresh = () => {
  const aDone = dispatchSummary(A_DISPATCH, "DS-000001", A_LIST, "DL-000001", alpha);
  const aDraft = dispatchSummary(A_DRAFT, "DS-000002", A_LIST, "DL-000001", alpha, { status: "draft", confirmed_at: null, confirmed_by_email: null });
  const bDone = dispatchSummary(B_DISPATCH, "DS-000001", B_LIST, "DL-000001", beta);
  return {
    "token-alpha": {
      dispatches: [aDone, aDraft], details: { [A_DISPATCH]: dispatchDetail(aDone, "Alpha steel bolt"), [A_DRAFT]: dispatchDetail(aDraft, "Alpha steel bolt", { editable: true, status: "draft" }) } as Record<string, any>,
      lists: { [A_LIST]: listDetail(A_LIST, "DL-000001", alpha, "Alpha steel bolt", { dispatches: [aDone, aDraft] }) } as Record<string, any>,
    },
    "token-beta": {
      dispatches: [bDone], details: { [B_DISPATCH]: dispatchDetail(bDone, "Beta silk scarf") } as Record<string, any>,
      lists: { [B_LIST]: listDetail(B_LIST, "DL-000001", beta, "Beta silk scarf", { dispatches: [bDone] }) } as Record<string, any>,
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
      if (url.includes("/api/v1/inventory/")) return json(200, { items: [{ id: W1, code: "MAIN", name: "Main depot", is_active: true }], total: 1, limit: 200, offset: 0 });
      if (!url.includes("/api/v1/sales/")) return json(404, {});
      if (options.status) return json(options.status, { detail: "x" });
      const org = (orgs as any)[token];
      if (!org) return json(401, {});
      const path = new URL(url).pathname.replace("/api/v1/sales", "");
      const params = new URL(url).searchParams;
      const page = (items: any[]) => json(200, { items, total: items.length, limit: Number(params.get("limit")), offset: Number(params.get("offset")) });
      if (path === "/clients") return page([]);
      if (path === "/delivery-lists") return page(Object.values(org.lists).filter((l: any) => !params.get("status") || l.status === params.get("status")));
      if (path === "/dispatches") return page(org.dispatches.filter((d: any) => !params.get("status") || d.status === params.get("status")));
      let match = path.match(/^\/dispatches\/([^/]+)$/);
      if (match) return org.details[match[1]] ? json(200, org.details[match[1]]) : json(404, { detail: "Dispatch not found." });
      match = path.match(/^\/delivery-lists\/([^/]+)$/);
      if (match) return org.lists[match[1]] ? json(200, org.lists[match[1]]) : json(404, { detail: "Delivery list not found." });
      return json(404, {});
    })
  );
}
const salesCalls = () => calls.filter((c) => c.url.includes("/api/v1/sales/"));
const render = async (element: Promise<any>) => renderToStaticMarkup(await element);

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.INVENTORY_SERVICE_URL = "http://inventory-service:8002";
  process.env.SALES_SERVICE_URL = "http://sales-service:8003";
  for (const key of Object.keys(jar)) delete jar[key];
  orgs = fresh();
});
afterEach(() => vi.unstubAllGlobals());

describe("Dispatches page", () => {
  it("lists the dispatches with number, delivery list, client, date, lines and status", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(DispatchesPage({ searchParams: {} }));
    for (const expected of ["Dispatches", "DS-000001", "DS-000002", "DL-000001", "Alpha Metals", "2026-11-07", "Confirmed", "Draft", "All statuses", "All clients", "New Dispatch", "Showing 1–2 of 2", "deducts stock only when you confirm"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).toContain(`href="/dispatches/${A_DISPATCH}"`);
  });

  it("two organizations: each sees only their own dispatches", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const a = await render(DispatchesPage({ searchParams: {} }));
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const b = await render(DispatchesPage({ searchParams: {} }));
    expect(a).toContain("Alpha Metals");
    expect(a).not.toContain("Beta Textiles");
    expect(b).toContain("Beta Textiles");
    expect(b).not.toContain("Alpha Metals");
  });

  it("passes only whitelisted filters to the service", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await DispatchesPage({ searchParams: { q: "trk", status: "confirmed", client: A_CLIENT, list: A_LIST, from: "2026-11-01", to: "2026-11-30", page: "2", organization_id: B_CLIENT, sort: "x" } });
    const call = salesCalls().find((c) => new URL(c.url).pathname === "/api/v1/sales/dispatches")!;
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({
      q: "trk", status: "confirmed", client_id: A_CLIENT, delivery_list_id: A_LIST, date_from: "2026-11-01", date_to: "2026-11-30", limit: "25", offset: "25",
    });
    calls = [];
    await DispatchesPage({ searchParams: { status: "shipped", client: "' OR 1=1", list: "x", from: "yesterday", to: "../", page: "banana" } });
    const clean = salesCalls().find((c) => new URL(c.url).pathname === "/api/v1/sales/dispatches")!;
    expect([...new URL(clean.url).searchParams.keys()].sort()).toEqual(["limit", "offset"]);
  });

  it("redirects without a session / for a Super Admin, calling no sales endpoint", async () => {
    stubWorld();
    await expect(DispatchesPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(DispatchesPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    expect(salesCalls()).toHaveLength(0);
  });

  it("explains an inactive organization, an outage and an expired session; and an empty list", async () => {
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 403 });
    expect(await render(DispatchesPage({ searchParams: {} }))).toContain("currently inactive or unavailable");
    stubWorld({ status: 503 });
    expect(await render(DispatchesPage({ searchParams: {} }))).toContain("temporarily unavailable");
    stubWorld({ status: 401 });
    await expect(DispatchesPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    orgs["token-alpha"].dispatches = [];
    stubWorld();
    expect(await render(DispatchesPage({ searchParams: {} }))).toContain("No dispatches yet");
    expect(await render(DispatchesPage({ searchParams: { q: "zzz" } }))).toContain("No dispatches match these filters");
  });
});

describe("one dispatch", () => {
  const page = (id: string) => render(DispatchPage({ params: { id } }));

  it("shows the list, the client, the quantities, the warehouse and the stock movement", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_DISPATCH);
    for (const expected of ["DS-000001", "Confirmed", "DL-000001", "Alpha Metals", "Alpha steel bolt", "SKU-1", "MAIN", "Requested", "Dispatched", "#c3c3c3c3", "confirmed by a@b.c", "Deliver to: 1 Dock Rd", "Transport: Truck 4", "does not change your stock"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).toContain(`href="/movements?product=`);
    expect(html).not.toContain("Retry posting");
    expect(html).not.toContain("Confirm and deduct from stock");
  });

  it("a draft can be edited, confirmed or discarded", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_DRAFT);
    for (const expected of ["DS-000002", "Edit dispatch", "Confirm and deduct from stock", "Discard draft"]) expect(html, expected).toContain(expected);
    expect(html).toContain(`/delivery-lists/${A_LIST}/dispatch?dispatch=${A_DRAFT}`);
  });

  it("a draft that asks for more than the warehouse holds cannot be confirmed from here", async () => {
    orgs["token-alpha"].details[A_DRAFT] = { ...orgs["token-alpha"].details[A_DRAFT], lines_exceeding_stock: 1, stock_status: "ok" };
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_DRAFT);
    expect(html).toContain("cannot be confirmed yet");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Confirm and deduct from stock/);
  });

  it("a dispatch being posted says so and offers a retry, with the reason", async () => {
    orgs["token-alpha"].details[A_DRAFT] = dispatchDetail(orgs["token-alpha"].dispatches[1], "Alpha steel bolt", {
      status: "posting", editable: false, posting: { attempts: 2, started_at: now, last_attempt_at: now, last_error: "The inventory service did not answer (ReadTimeout)." },
    });
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_DRAFT);
    for (const expected of ["Posting to stock", "being deducted from stock", "Retry posting", "Attempts: 2", "did not answer", "cannot be deducted twice"]) expect(html, expected).toContain(expected);
    expect(html).not.toContain("Edit dispatch");
  });

  it("two organizations: another organization's dispatch is simply 'not found'", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const own = await page(A_DISPATCH);
    const foreign = await page(B_DISPATCH);
    expect(own).toContain("Alpha steel bolt");
    expect(foreign).toContain("Dispatch not found.");
    for (const leak of ["Beta", "scarf", "Textiles"]) expect(own + foreign, `alpha saw ${leak}`).not.toContain(leak);
  });

  it("does not call the service for something that is not an id, and redirects when signed out", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await page("../../etc/passwd")).toContain("Dispatch not found.");
    expect(salesCalls()).toHaveLength(0);
    delete jar[TENANT_SESSION_COOKIE];
    await expect(page(A_DISPATCH)).rejects.toThrow("REDIRECT:/login");
  });
});

describe("Prepare dispatch page", () => {
  const page = (id: string, searchParams: Record<string, string> = {}) => render(PrepareDispatchPage({ params: { id }, searchParams }));

  it("shows requested, dispatched, in progress and remaining per product, with the warehouse and quantity inputs", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_LIST);
    for (const expected of ["Prepare dispatch", "DL-000001", "Alpha steel bolt", "Requested", "Dispatched", "In progress", "Remaining", "Review dispatch", "Find a product on this list", "Use camera", "Dispatch date", "Tracking / reference number", "does not change your stock"]) {
      expect(html, expected).toContain(expected);
    }
  });

  it.each([
    ["draft", "still a draft"], ["cancelled", "is cancelled"], ["dispatched", "already fully dispatched"], ["ready", "nothing left to dispatch right now"],
  ])("a list that is %s cannot be dispatched against", async (status, phrase) => {
    orgs["token-alpha"].lists[A_LIST] = { ...orgs["token-alpha"].lists[A_LIST], status, can_dispatch: false };
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_LIST);
    expect(html).toContain(phrase);
    expect(html).not.toContain("Review dispatch");
  });

  it("resumes a draft only if it belongs to this list and is still a draft", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await page(A_LIST, { dispatch: A_DRAFT })).toContain("Editing the draft");
    expect(await page(A_LIST, { dispatch: A_DISPATCH })).not.toContain("Editing the draft"); // confirmed: not editable
    expect(await page(A_LIST, { dispatch: B_DISPATCH })).not.toContain("Editing the draft"); // another organization's
    expect(await page(A_LIST, { dispatch: "not-an-id" })).not.toContain("Editing the draft");
  });

  it("another organization's list is 'not found'; garbage ids never reach the service; signed-out users are redirected", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const foreign = await page(B_LIST);
    expect(foreign).toContain("Delivery list not found.");
    expect(foreign).not.toContain("Beta");
    calls = [];
    expect(await page("../x")).toContain("Delivery list not found.");
    expect(salesCalls()).toHaveLength(0);
    delete jar[TENANT_SESSION_COOKIE];
    await expect(page(A_LIST)).rejects.toThrow("REDIRECT:/login");
  });
});

describe("the delivery list page", () => {
  const page = (id: string) => render(DeliveryListPage({ params: { id } }));

  it("offers Prepare dispatch, shows dispatch progress per product and the dispatch history", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_LIST);
    for (const expected of ["Prepare dispatch", `/delivery-lists/${A_LIST}/dispatch`, "Partially Dispatched", "Dispatch progress", "10 of 15 pcs dispatched", "5 remaining", "Dispatches (2)", "DS-000001", "DS-000002", "Confirmed", "Draft"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="66"');
  });

  it("a list with goods dispatched can be neither reopened nor cancelled", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_LIST);
    expect(html).toContain("can no longer be reopened or cancelled");
    for (const absent of ["Reopen as draft", "Cancel list", "Mark Ready", "Add a product"]) expect(html, absent).not.toContain(absent);
  });

  it("a Ready list with only a draft dispatch can still be reopened; one with a posting dispatch cannot be cancelled", async () => {
    const aDraft = orgs["token-alpha"].dispatches[1];
    orgs["token-alpha"].lists[A_LIST] = { ...orgs["token-alpha"].lists[A_LIST], status: "ready", dispatches: [aDraft] };
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    let html = await page(A_LIST);
    expect(html).toContain("Reopen as draft");
    expect(html).toContain("Cancel list");
    orgs["token-alpha"].lists[A_LIST] = { ...orgs["token-alpha"].lists[A_LIST], dispatches: [{ ...aDraft, status: "posting" }] };
    html = await page(A_LIST);
    expect(html).not.toContain("Reopen as draft");
    expect(html).not.toContain("Cancel list");
  });

  it("a Dispatched list is complete and offers no dispatch", async () => {
    orgs["token-alpha"].lists[A_LIST] = { ...orgs["token-alpha"].lists[A_LIST], status: "dispatched", can_dispatch: false };
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_LIST);
    expect(html).toContain("Everything on this list has been dispatched");
    expect(html).not.toContain("Prepare dispatch");
  });

  it("an existing list without dispatch data still renders (older answers carry no dispatch fields)", async () => {
    const { dispatches, can_dispatch, ...older } = orgs["token-alpha"].lists[A_LIST];
    orgs["token-alpha"].lists[A_LIST] = { ...older, status: "ready", items: older.items.map(({ dispatched_quantity, pending_quantity, remaining_quantity, ...rest }: any) => rest) };
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await page(A_LIST);
    expect(html).toContain("DL-000001");
    expect(html).toContain("Reopen as draft");
  });
});

describe("navigation", () => {
  it("the Dispatches layout redirects invalid sessions, marks itself current and every page links to it", async () => {
    stubWorld();
    await expect((DispatchesLayout as any)({ children: null })).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = renderToStaticMarkup(await (DispatchesLayout as any)({ children: "PAGE" }));
    expect(html.match(/<a[^>]*aria-current="page"[^>]*>([^<]*)</)?.[1]).toBe("Dispatches");
    for (const href of ["/", "/products", "/warehouses", "/stock", "/scan", "/movements", "/delivery-lists", "/dispatches", "/clients", "/suppliers", "/purchase-orders", "/goods-receipts"]) expect(html).toContain(`href="${href}"`);
  });
});
