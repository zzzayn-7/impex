// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// The ZXing / BarcodeDetector decoder needs a real camera frame; tests swap in a decoder that "sees" one code.
const decoderState = { code: "BOLT-1" as string | null };
vi.mock("@/lib/camera", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/camera")>()),
  createBrowserDecoder: async () => ({ name: "fake", decode: async () => decoderState.code }),
}));

import DispatchDetailView from "@/app/dispatches/[id]/dispatch-detail";
import DispatchIndex from "@/app/dispatches/dispatch-index";
import DispatchForm from "@/app/delivery-lists/[id]/dispatch/dispatch-form";
import DeliveryListDetail from "@/app/delivery-lists/[id]/delivery-list-detail";
import DispatchPanel from "@/app/scan/dispatch-panel";
import ScanProduct from "@/app/scan/scan-product";
import ReceiveForm from "@/app/purchase-orders/[id]/receive/receive-form";

const now = "2026-11-07T10:00:00+00:00";
const LIST = "a0000000-0000-4000-8000-000000000001";
const CLIENT = "c0000000-0000-4000-8000-000000000001";
const BOLT = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const FLOUR = "7a1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const NAILS = "8b1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const I_BOLT = "e0000000-0000-4000-8000-000000000001";
const I_FLOUR = "e0000000-0000-4000-8000-000000000002";
const W_MAIN = "22222222-2222-4222-8222-222222222222";
const W_SHELF = "33333333-3333-4333-8333-333333333333";
const DISPATCH = "f0000000-0000-4000-8000-000000000001";

const warehouses = [
  { id: W_MAIN, code: "MAIN", name: "Main depot", address: null, is_active: true, created_at: now, updated_at: now, products_in_stock: 1 },
  { id: W_SHELF, code: "SHELF", name: "Shelf room", address: null, is_active: true, created_at: now, updated_at: now, products_in_stock: 1 },
];
const stockLine = (id: string, code: string, quantity: string) => ({ warehouse_id: id, warehouse_code: code, warehouse_name: `${code} depot`, warehouse_active: true, quantity });
const stockOf = (id: string, sku: string, name: string, unit: string, lines: any[]) => ({
  product_id: id, sku, name, category: "G", unit, unit_allows_fractions: unit === "kg", is_active: true,
  total_quantity: lines.reduce((s, l) => s + Number(l.quantity), 0).toFixed(4), available_quantity: lines.reduce((s, l) => s + Number(l.quantity), 0).toFixed(4), lines,
});
const STOCK = {
  [BOLT]: stockOf(BOLT, "BOLT-1", "Steel bolt", "pcs", [stockLine(W_MAIN, "MAIN", "40.0000"), stockLine(W_SHELF, "SHELF", "20.0000")]),
  [FLOUR]: stockOf(FLOUR, "FLOUR", "Flour", "kg", [stockLine(W_MAIN, "MAIN", "2.5000")]),
};

const item = (id: string, productId: string, sku: string, name: string, unit: string, quantity: string, extra: Record<string, unknown> = {}) => ({
  id, product_id: productId, product_sku: sku, product_name: name, quantity, unit, planned_warehouse_id: null, planned_warehouse_code: null, created_at: now, updated_at: now,
  stock: null, dispatched_quantity: "0.0000", pending_quantity: "0.0000", remaining_quantity: quantity, ...extra,
});
const list = (extra: Record<string, unknown> = {}, items?: any[]) => ({
  id: LIST, number: "DL-000001", client: { id: CLIENT, name: "Acme Ltd", is_active: true }, external_reference: null, status: "ready", notes: null, item_count: 2,
  created_by_email: "a@b.c", created_at: now, updated_at: now, stock_status: "ok", items_exceeding_stock: 0, stock_notice: "x", dispatches: [], can_dispatch: true,
  items: items ?? [item(I_BOLT, BOLT, "BOLT-1", "Steel bolt", "pcs", "15.0000"), item(I_FLOUR, FLOUR, "FLOUR", "Flour", "kg", "2.0000")], ...extra,
});

// what the Sales Service would answer for a dispatch built from the lines the browser sent
function dispatchFrom(lines: any[], extra: Record<string, unknown> = {}) {
  const l = list();
  return {
    id: DISPATCH, number: "DS-000001", status: "draft", delivery_list: { id: LIST, number: "DL-000001", status: "ready" }, client: l.client, dispatch_date: "2026-11-07", tracking_reference: null,
    line_count: lines.length, created_by_email: "a@b.c", created_at: now, confirmed_at: null, confirmed_by_email: null, cancelled_at: null, cancelled_by_email: null, updated_at: now,
    delivery_address: null, transport_details: null, notes: null,
    lines: lines.map((x, i) => {
      const it = l.items.find((y) => y.id === x.deliveryListItemId)!;
      const w = warehouses.find((y) => y.id === x.warehouseId)!;
      const held = STOCK[it.product_id].lines.find((y) => y.warehouse_id === w.id)?.quantity ?? "0";
      return {
        id: `d000000${i}-0000-4000-8000-000000000000`, delivery_list_item_id: it.id, product_id: it.product_id, product_sku: it.product_sku, product_name: it.product_name, unit: it.unit,
        requested_quantity: it.quantity, dispatched_elsewhere_quantity: "0.0000", pending_elsewhere_quantity: "0.0000", dispatchable_quantity: it.quantity, warehouse_id: w.id, warehouse_code: w.code,
        quantity: x.quantity, inventory_movement_id: null, available_in_warehouse: held,
      };
    }),
    posting: { attempts: 0, started_at: null, last_attempt_at: null, last_error: null }, inventory_operation_id: null, editable: true, stock_status: "ok", lines_exceeding_stock: 0, stock_notice: "x", ...extra,
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; body: any; headers: any };
let calls: Call[];
let server: Record<string, (body: any, url: string, headers: any) => Response | Promise<Response>>;
let lastLines: any[] = [];
let readyLists: any[] = [];
let openDraft: any = null;

const CATALOG: Record<string, any> = {
  "BOLT-1": { matched_by: "sku", identifier_kind: null, product: { id: BOLT, sku: "BOLT-1", name: "Steel bolt", unit: "pcs", unit_allows_fractions: false, is_active: true }, stock: STOCK[BOLT] },
  FLOUR: { matched_by: "sku", identifier_kind: null, product: { id: FLOUR, sku: "FLOUR", name: "Flour", unit: "kg", unit_allows_fractions: true, is_active: true }, stock: STOCK[FLOUR] },
  NAILS: { matched_by: "sku", identifier_kind: null, product: { id: NAILS, sku: "NAILS", name: "Nails", unit: "pcs", unit_allows_fractions: false, is_active: true }, stock: stockOf(NAILS, "NAILS", "Nails", "pcs", []) },
};

function stub() {
  calls = [];
  server = {};
  lastLines = [];
  readyLists = [];
  openDraft = null;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, headers: init.headers ?? {} });
    if (url.startsWith("/api/scan/resolve")) {
      const code = decodeURIComponent(url.split("code=")[1]);
      return CATALOG[code] ? json(200, CATALOG[code]) : json(404, { error: "No product in your catalog matches this code." });
    }
    const key = `${method} ${url.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id")}`;
    if (server[key]) return server[key](body, url, init.headers ?? {});
    if (key === "GET /api/sales/delivery-lists") return json(200, { items: url.includes("status=ready") ? readyLists : [], total: readyLists.length, limit: 100, offset: 0 });
    if (key === "GET /api/sales/delivery-lists/:id") return json(200, { list: list() });
    if (key === "GET /api/sales/dispatches") return json(200, { items: openDraft ? [openDraft] : [], total: openDraft ? 1 : 0, limit: 1, offset: 0 });
    if (key === "GET /api/sales/dispatches/:id") return json(200, { dispatch: openDraft });
    if (key === "POST /api/sales/dispatches") { lastLines = body.lines; return json(201, { dispatch: dispatchFrom(body.lines), replayed: false }); }
    if (key === "PUT /api/sales/dispatches/:id/lines") { lastLines = body.lines; return json(200, { dispatch: dispatchFrom(body.lines) }); }
    if (key === "PATCH /api/sales/dispatches/:id") return json(200, { dispatch: dispatchFrom(lastLines) });
    if (key === "POST /api/sales/dispatches/:id/confirm") return json(200, { dispatch: dispatchFrom(lastLines, { status: "confirmed", editable: false, confirmed_at: now, confirmed_by_email: "a@b.c" }), confirmed: true });
    if (key === "POST /api/sales/dispatches/:id/cancel") return json(200, { dispatch: dispatchFrom(lastLines, { status: "cancelled", cancelled_at: now, cancelled_by_email: "a@b.c", editable: false }) });
    return json(404, { error: "not found" });
  }));
}
const posts = (suffix: string) => calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));
const stockCalls = () => calls.filter((c) => /\/api\/(stock|products|inventory|warehouses)/.test(c.url));

beforeEach(() => { router.replace.mockReset(); router.refresh.mockReset(); router.push.mockReset(); decoderState.code = "BOLT-1"; stub(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const user = () => userEvent.setup();
const quantityOf = (name: string, n = "") => screen.getByLabelText(`Quantity to dispatch of ${name}${n}`) as HTMLInputElement;
const warehouseOf = (name: string, n = "") => screen.getByLabelText(`Warehouse for ${name}${n}`) as HTMLSelectElement;

function mount(props: Partial<{ list: any; draft: any }> = {}) {
  return render(<DispatchForm list={(props.list ?? list()) as any} warehouses={warehouses as any} stock={STOCK as any} draft={(props.draft ?? null) as any} />);
}

// =====================================================================================================
describe("Prepare dispatch: choosing quantities and warehouses", () => {
  it("shows requested, dispatched, in progress and remaining, and says nothing changes stock yet", () => {
    mount({ list: list({}, [item(I_BOLT, BOLT, "BOLT-1", "Steel bolt", "pcs", "15.0000", { dispatched_quantity: "10.0000", pending_quantity: "2.0000", remaining_quantity: "3.0000" })]) });
    const block = screen.getByTestId("item-BOLT-1");
    expect(block.textContent).toContain("Requested");
    expect(block.textContent).toContain("15 pcs");
    expect(block.textContent).toContain("10"); // dispatched
    expect(block.textContent).toContain("3"); // remaining
    expect(screen.getByRole("note").textContent).toContain("does not change your stock");
    expect(calls).toHaveLength(0);
  });

  it("never fills in a quantity by itself", async () => {
    mount();
    await user().click(screen.getByRole("button", { name: "Dispatch Steel bolt" }));
    expect(quantityOf("Steel bolt").value).toBe("");
  });

  it("offers each warehouse with the stock it holds", async () => {
    mount();
    await user().click(screen.getByRole("button", { name: "Dispatch Steel bolt" }));
    const labels = within(warehouseOf("Steel bolt")).getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(["MAIN — Main depot (40 in stock)", "SHELF — Shelf room (20 in stock)"]);
  });

  it("refuses an empty dispatch without calling the server", async () => {
    mount();
    await user().click(screen.getByRole("button", { name: "Review dispatch" }));
    expect(screen.getByRole("alert").textContent).toContain("Enter the quantity to dispatch for at least one product");
    expect(calls).toHaveLength(0);
  });

  it("refuses more than the remaining quantity, exactly, without calling the server", async () => {
    mount();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Dispatch Steel bolt" }));
    await u.type(quantityOf("Steel bolt"), "15.0001");
    await u.click(screen.getByRole("button", { name: "Review dispatch" }));
    expect(screen.getByRole("alert").textContent).toContain("Only 15 pcs of Steel bolt can still be dispatched.");
    expect(calls).toHaveLength(0);
  });

  it("adds the quantities of one product that leaves from two warehouses before comparing with what remains", async () => {
    mount();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Dispatch Steel bolt" }));
    await u.type(quantityOf("Steel bolt"), "10");
    await u.click(screen.getByRole("button", { name: /another warehouse/ }));
    await u.type(quantityOf("Steel bolt", " (2)"), "6");
    await u.click(screen.getByRole("button", { name: "Review dispatch" }));
    expect(screen.getByRole("alert").textContent).toContain("Only 15 pcs of Steel bolt can still be dispatched.");
    expect(calls).toHaveLength(0);
  });

  it.each(["abc", "-1", "0", "1.00001", "1e3", "1,5"])("refuses the quantity %j", async (value) => {
    mount();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Dispatch Steel bolt" }));
    await u.type(quantityOf("Steel bolt"), value);
    await u.click(screen.getByRole("button", { name: "Review dispatch" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("warns when the typed quantity is more than the warehouse holds, but still lets the draft be saved", async () => {
    mount({ list: list({}, [item(I_BOLT, BOLT, "BOLT-1", "Steel bolt", "pcs", "50.0000")]) });
    const u = user();
    await u.click(screen.getByRole("button", { name: "Dispatch Steel bolt" }));
    await u.type(quantityOf("Steel bolt"), "45");
    expect(screen.getByText(/more than the 40 pcs in this warehouse/)).toBeTruthy();
    await u.click(screen.getByRole("button", { name: "Review dispatch" }));
    await screen.findByRole("heading", { name: "Review DS-000001" });
  });

  it("a fully dispatched list shows nothing to dispatch", () => {
    mount({ list: list({}, [item(I_BOLT, BOLT, "BOLT-1", "Steel bolt", "pcs", "15.0000", { dispatched_quantity: "15.0000", remaining_quantity: "0.0000" })]) });
    expect(screen.getByText("Everything on this list has been dispatched.")).toBeTruthy();
  });
});

// =====================================================================================================
describe("Prepare dispatch: locating a product by SKU, barcode or camera", () => {
  const box = () => screen.getByPlaceholderText(/Type, or scan into this box/);

  it("finds a product of the list, opens its row and focuses its quantity - without entering one", async () => {
    mount();
    const u = user();
    await u.type(box(), "bolt-1");
    await u.click(screen.getByRole("button", { name: "Find product" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Steel bolt (BOLT-1) located"));
    expect(quantityOf("Steel bolt").value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(quantityOf("Steel bolt")));
    expect(calls.map((c) => c.url)).toEqual(["/api/scan/resolve?code=BOLT-1"]);
  });

  it("a keyboard-emulating scanner (typing + Enter) works the same way", async () => {
    mount();
    await user().type(box(), "FLOUR{Enter}");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Flour (FLOUR) located"));
  });

  it("scanning the same code twice never raises the quantity", async () => {
    mount();
    const u = user();
    await u.type(box(), "BOLT-1{Enter}");
    await waitFor(() => quantityOf("Steel bolt"));
    await u.type(quantityOf("Steel bolt"), "4");
    await u.type(box(), "BOLT-1{Enter}");
    await u.type(box(), "BOLT-1{Enter}");
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith("/api/scan/resolve")).length).toBe(3));
    expect(quantityOf("Steel bolt").value).toBe("4");
  });

  it("rejects a real product that is NOT on this list", async () => {
    mount();
    const u = user();
    await u.type(box(), "NAILS{Enter}");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Nails (NAILS) is not on DL-000001"));
    expect(screen.queryByLabelText("Quantity to dispatch of Nails")).toBeNull();
  });

  it("the phone camera locates a product of the list, then switches itself off", async () => {
    const tracks = [{ stop: vi.fn() }];
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn(async () => ({ getTracks: () => tracks })) }, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    HTMLMediaElement.prototype.play = vi.fn(async () => undefined) as any;
    HTMLMediaElement.prototype.pause = vi.fn() as any;
    mount();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Use camera" }));
    await u.click(screen.getByRole("button", { name: "Start camera" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Steel bolt (BOLT-1) located"), { timeout: 3000 });
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(screen.queryByLabelText("Camera scanner")).toBeNull();
    expect(quantityOf("Steel bolt").value).toBe("");
    expect(calls.every((c) => c.url.startsWith("/api/scan/resolve"))).toBe(true);
  });

  it("the camera refuses a product that is not on the list", async () => {
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) }, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    HTMLMediaElement.prototype.play = vi.fn(async () => undefined) as any;
    HTMLMediaElement.prototype.pause = vi.fn() as any;
    decoderState.code = "NAILS";
    mount();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Use camera" }));
    await u.click(screen.getByRole("button", { name: "Start camera" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("is not on DL-000001"), { timeout: 3000 });
  });
});

// =====================================================================================================
describe("Prepare dispatch: review and explicit confirmation", () => {
  async function fillAndReview(u = user()) {
    await u.click(screen.getByRole("button", { name: "Dispatch Steel bolt" }));
    await u.type(quantityOf("Steel bolt"), "10");
    await u.selectOptions(warehouseOf("Steel bolt"), W_SHELF);
    await u.click(screen.getByRole("button", { name: "Review dispatch" }));
    await screen.findByRole("heading", { name: "Review DS-000001" });
    return u;
  }

  it("saves a DRAFT with the exact quantities, the chosen warehouse and a stable key - and deducts nothing", async () => {
    mount();
    await fillAndReview();
    const create = posts("/api/sales/dispatches");
    expect(create).toHaveLength(1);
    expect(create[0].headers["Idempotency-Key"]).toMatch(/^ui-[0-9a-f-]{36}$/);
    expect(create[0].body).toMatchObject({ deliveryListId: LIST, dispatchDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), lines: [{ deliveryListItemId: I_BOLT, warehouseId: W_SHELF, quantity: "10" }] });
    expect(JSON.stringify(create[0].body)).not.toMatch(/organization|unit|status|price|clientId/i);
    expect(posts("/confirm")).toHaveLength(0);
    expect(stockCalls()).toHaveLength(0);
    expect(screen.getByRole("note").textContent).toContain("Nothing has been deducted from your stock yet");
    expect(screen.getByText("In stock now")).toBeTruthy(); // the available stock of the chosen warehouse is shown at review
    expect(screen.getByText("20 pcs")).toBeTruthy();
  });

  it("only the Confirm button deducts stock, once", async () => {
    mount();
    const u = await fillAndReview();
    await u.click(screen.getByRole("button", { name: "Confirm and deduct from stock" }));
    await screen.findByText("DS-000001 confirmed");
    expect(posts("/confirm")).toHaveLength(1);
    expect(stockCalls()).toHaveLength(0); // the browser never writes stock itself
    expect(screen.getByRole("link", { name: "View the dispatch" }).getAttribute("href")).toBe(`/dispatches/${DISPATCH}`);
    expect(screen.getByRole("link", { name: /Back to DL-000001/ }).getAttribute("href")).toBe(`/delivery-lists/${LIST}`);
  });

  it("a double click on Confirm sends one request", async () => {
    let release: () => void = () => undefined;
    server["POST /api/sales/dispatches/:id/confirm"] = () =>
      new Promise<Response>((resolve) => { release = () => resolve(json(200, { dispatch: dispatchFrom(lastLines, { status: "confirmed", editable: false }), confirmed: true })); });
    mount();
    const u = await fillAndReview();
    await u.dblClick(screen.getByRole("button", { name: "Confirm and deduct from stock" }));
    expect(posts("/confirm")).toHaveLength(1);
    expect((screen.getByRole("button", { name: /Deducting from stock/ }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await screen.findByText("DS-000001 confirmed");
    expect(posts("/confirm")).toHaveLength(1);
  });

  it("a draft that asks for more than the warehouse holds cannot be confirmed from the review", async () => {
    mount({ list: list({}, [item(I_BOLT, BOLT, "BOLT-1", "Steel bolt", "pcs", "50.0000")]) });
    server["POST /api/sales/dispatches"] = (body) => { lastLines = body.lines; return json(201, { dispatch: dispatchFrom(body.lines, { lines_exceeding_stock: 1 }), replayed: false }); };
    const u = user();
    await u.click(screen.getByRole("button", { name: "Dispatch Steel bolt" }));
    await u.type(quantityOf("Steel bolt"), "45");
    await u.click(screen.getByRole("button", { name: "Review dispatch" }));
    await screen.findByRole("heading", { name: "Review DS-000001" });
    expect(screen.getByRole("alert").textContent).toContain("more than the warehouse holds right now");
    expect((screen.getByRole("button", { name: "Confirm and deduct from stock" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an unverified posting shows a retry, and retrying finishes it", async () => {
    let attempt = 0;
    server["POST /api/sales/dispatches/:id/confirm"] = () => {
      attempt += 1;
      return attempt === 1
        ? json(202, { dispatch: dispatchFrom(lastLines, { status: "posting", editable: false, posting: { attempts: 1, started_at: now, last_attempt_at: now, last_error: "The inventory service did not answer (ReadTimeout)." } }), confirmed: false })
        : json(200, { dispatch: dispatchFrom(lastLines, { status: "confirmed", editable: false }), confirmed: true });
    };
    mount();
    const u = await fillAndReview();
    await u.click(screen.getByRole("button", { name: "Confirm and deduct from stock" }));
    await screen.findByText("DS-000001 is being deducted from stock");
    expect(screen.getByRole("alert").textContent).toContain("Nothing is lost and nothing will be deducted twice");
    expect(screen.getByRole("alert").textContent).toContain("did not answer");
    await u.click(screen.getByRole("button", { name: "Retry posting" }));
    await screen.findByText("DS-000001 confirmed");
    expect(posts("/confirm")).toHaveLength(2);
    expect(posts("/api/sales/dispatches")).toHaveLength(1); // the draft was created once
  });

  it("insufficient stock explains itself and returns to editing the draft", async () => {
    server["POST /api/sales/dispatches/:id/confirm"] = () => json(409, { error: "Not enough stock: 40 pcs of Steel bolt in MAIN, 45 to dispatch. Nothing was deducted.", code: "insufficient_stock" });
    mount();
    const u = await fillAndReview();
    await u.click(screen.getByRole("button", { name: "Confirm and deduct from stock" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Not enough stock"));
    expect(screen.getByRole("button", { name: "Review dispatch" })).toBeTruthy();
    expect(quantityOf("Steel bolt").value).toBe("10");
  });

  it("a definitive refusal by the inventory service returns to editing", async () => {
    server["POST /api/sales/dispatches/:id/confirm"] = () => json(409, { error: "The inventory service refused to deduct this dispatch from stock: archived. Nothing was deducted.", code: "inventory_rejected" });
    mount();
    const u = await fillAndReview();
    await u.click(screen.getByRole("button", { name: "Confirm and deduct from stock" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Nothing was deducted"));
    expect(screen.getByRole("button", { name: "Review dispatch" })).toBeTruthy();
  });

  it("going back and reviewing again updates the same draft instead of creating another", async () => {
    mount();
    const u = await fillAndReview();
    await u.click(screen.getByRole("button", { name: "Back to edit" }));
    expect(quantityOf("Steel bolt").value).toBe("10");
    await u.clear(quantityOf("Steel bolt"));
    await u.type(quantityOf("Steel bolt"), "12");
    await u.click(screen.getByRole("button", { name: "Review dispatch" }));
    await screen.findByRole("heading", { name: "Review DS-000001" });
    expect(posts("/api/sales/dispatches")).toHaveLength(1);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(`/api/sales/dispatches/${DISPATCH}/lines`);
    expect(put.body.lines[0]).toMatchObject({ deliveryListItemId: I_BOLT, quantity: "12" });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("a failed save can be retried with the SAME key", async () => {
    let first = true;
    server["POST /api/sales/dispatches"] = (body) => {
      if (first) { first = false; return json(503, { error: "The sales service is unavailable. Please try again shortly." }); }
      lastLines = body.lines;
      return json(201, { dispatch: dispatchFrom(body.lines), replayed: false });
    };
    mount();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Dispatch Steel bolt" }));
    await u.type(quantityOf("Steel bolt"), "2");
    await u.click(screen.getByRole("button", { name: "Review dispatch" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("unavailable"));
    await u.click(screen.getByRole("button", { name: "Review dispatch" }));
    await screen.findByRole("heading", { name: "Review DS-000001" });
    const keys = posts("/api/sales/dispatches").map((c) => c.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("an over-dispatch caught by the server is shown and nothing is reviewed", async () => {
    server["POST /api/sales/dispatches"] = () => json(409, { error: "You cannot dispatch 4 pcs of Steel bolt: the client requested 15, 12 already dispatched, so at most 3 can still be dispatched.", code: "over_dispatch" });
    mount();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Dispatch Steel bolt" }));
    await u.type(quantityOf("Steel bolt"), "4");
    await u.click(screen.getByRole("button", { name: "Review dispatch" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("at most 3 can still be dispatched"));
    expect(screen.queryByRole("heading", { name: /Review/ })).toBeNull();
  });

  it("discarding the draft cancels it and returns to the list", async () => {
    mount();
    const u = await fillAndReview();
    await u.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/delivery-lists/${LIST}`));
    expect(posts("/cancel")).toHaveLength(1);
    expect(posts("/confirm")).toHaveLength(0);
  });

  it("an expired session goes to the sign-in page", async () => {
    server["POST /api/sales/dispatches"] = () => json(401, { error: "Your session has expired. Please sign in again." });
    mount();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Dispatch Steel bolt" }));
    await u.type(quantityOf("Steel bolt"), "1");
    await u.click(screen.getByRole("button", { name: "Review dispatch" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("resuming a draft fills in what was saved and updates it (PUT), keeping its number", async () => {
    const draft = dispatchFrom([{ deliveryListItemId: I_FLOUR, warehouseId: W_MAIN, quantity: "1.5000" }], { tracking_reference: "TRK-5" });
    mount({ draft });
    expect(quantityOf("Flour").value).toBe("1.5");
    expect(warehouseOf("Flour").value).toBe(W_MAIN);
    expect(screen.getByRole("status").textContent).toContain("Editing the draft DS-000001");
    expect((screen.getByLabelText("Tracking / reference number") as HTMLInputElement).value).toBe("TRK-5");
    await user().click(screen.getByRole("button", { name: "Review dispatch" }));
    await screen.findByRole("heading", { name: "Review DS-000001" });
    expect(posts("/api/sales/dispatches")).toHaveLength(0);
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
  });
});

// =====================================================================================================
describe("a dispatch page", () => {
  const detail = (extra: Record<string, unknown> = {}) => dispatchFrom([{ deliveryListItemId: I_BOLT, warehouseId: W_MAIN, quantity: "10.0000" }], extra) as any;

  it("confirms a draft and updates in place", async () => {
    lastLines = [{ deliveryListItemId: I_BOLT, warehouseId: W_MAIN, quantity: "10.0000" }];
    render(<DispatchDetailView dispatch={detail()} />);
    await user().click(screen.getByRole("button", { name: "Confirm and deduct from stock" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("is confirmed"));
    expect(screen.getByText("Confirmed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm and deduct from stock" })).toBeNull();
    expect(posts("/confirm")).toHaveLength(1);
  });

  it("a posting dispatch offers Retry posting and explains the 202", async () => {
    server["POST /api/sales/dispatches/:id/confirm"] = () => json(202, { dispatch: detail({ status: "posting", editable: false, posting: { attempts: 3, started_at: now, last_attempt_at: now, last_error: "x" } }), confirmed: false });
    render(<DispatchDetailView dispatch={detail({ status: "posting", editable: false, posting: { attempts: 2, started_at: now, last_attempt_at: now, last_error: "The inventory service failed (500)." } })} />);
    expect(screen.getByRole("status").textContent).toContain("Attempts: 2");
    expect(screen.queryByText("Edit dispatch")).toBeNull();
    await user().click(screen.getByRole("button", { name: "Retry posting" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("has not confirmed the posting yet"));
  });

  it("a draft with insufficient stock cannot be confirmed", () => {
    render(<DispatchDetailView dispatch={detail({ lines_exceeding_stock: 1 })} />);
    expect((screen.getByRole("button", { name: "Confirm and deduct from stock" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("cannot be confirmed yet");
  });

  it("discarding needs a second click and shows what happened", async () => {
    render(<DispatchDetailView dispatch={detail()} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(posts("/cancel")).toHaveLength(0);
    expect(screen.getByRole("alertdialog").textContent).toContain("No stock is involved");
    await u.click(screen.getByRole("button", { name: "Yes, discard it" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("was cancelled"));
  });

  it("a confirmed dispatch can no longer be changed (its only action is to invoice it) and shows its movement", () => {
    render(<DispatchDetailView dispatch={detail({ status: "confirmed", editable: false, confirmed_at: now, confirmed_by_email: "a@b.c", stock_status: "not-needed", lines: detail().lines.map((l: any) => ({ ...l, inventory_movement_id: "c3c3c3c3-aaaa-4bbb-8ccc-123456789abc" })) })} />);
    const actions = screen.getByRole("group", { name: "Dispatch actions" });
    expect(within(actions).queryAllByRole("button")).toHaveLength(0);
    expect(within(actions).queryByRole("link", { name: "Edit dispatch" })).toBeNull();
    expect(within(actions).getAllByRole("link").map((l) => l.textContent)).toEqual(["Create invoice"]);
    expect(screen.getByText("#c3c3c3c3")).toBeTruthy();
  });

  it("shows why a refused draft was returned to editing", () => {
    render(<DispatchDetailView dispatch={detail({ posting: { attempts: 1, started_at: null, last_attempt_at: now, last_error: "Steel bolt is archived." } })} />);
    expect(screen.getByText(/nothing was deducted: Steel bolt is archived/)).toBeTruthy();
  });
});

describe("the dispatches list", () => {
  const summary = { ...(dispatchFrom([{ deliveryListItemId: I_BOLT, warehouseId: W_MAIN, quantity: "1" }]) as any), line_count: 1 };
  const ok = { ok: true as const, items: [summary], total: 1, limit: 25, offset: 0 };
  const filters = { q: "", status: "" as const, clientId: "", listId: "", dateFrom: "", dateTo: "", page: 1 };

  it("changing a filter navigates with only whitelisted query parameters", async () => {
    render(<DispatchIndex list={ok} filters={filters} clients={[{ id: CLIENT, name: "Acme Ltd", is_active: true } as any]} dispatchable={[]} />);
    const u = user();
    await u.selectOptions(screen.getByLabelText("Status"), "confirmed");
    expect(router.push).toHaveBeenLastCalledWith("/dispatches?status=confirmed");
    await u.selectOptions(screen.getByLabelText("Client"), CLIENT);
    expect(router.push).toHaveBeenLastCalledWith(`/dispatches?client=${CLIENT}`);
    await u.type(screen.getByLabelText("Search"), "trk-7{enter}");
    expect(router.push).toHaveBeenLastCalledWith("/dispatches?q=trk-7");
  });

  it("New Dispatch starts from a Ready delivery list", async () => {
    const ready = { id: LIST, number: "DL-000001", client: { id: CLIENT, name: "Acme Ltd", is_active: true }, status: "ready", item_count: 2 } as any;
    render(<DispatchIndex list={ok} filters={filters} clients={[]} dispatchable={[ready]} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "New Dispatch" }));
    expect((screen.getByRole("button", { name: "Prepare dispatch" }) as HTMLButtonElement).disabled).toBe(true);
    await u.selectOptions(screen.getByLabelText("Delivery list"), LIST);
    await u.click(screen.getByRole("button", { name: "Prepare dispatch" }));
    expect(router.push).toHaveBeenCalledWith(`/delivery-lists/${LIST}/dispatch`);
  });

  it("explains when no list is ready, and shows the right empty state", async () => {
    render(<DispatchIndex list={{ ok: true, items: [], total: 0, limit: 25, offset: 0 }} filters={{ ...filters, status: "draft" }} clients={[]} dispatchable={[]} />);
    await user().click(screen.getByRole("button", { name: "New Dispatch" }));
    expect(screen.getByText(/No delivery list is ready for dispatch/)).toBeTruthy();
    expect(screen.getByText("No dispatches match these filters.")).toBeTruthy();
    await user().click(screen.getByRole("button", { name: "Clear filters" }));
    expect(router.push).toHaveBeenLastCalledWith("/dispatches");
  });
});

// =====================================================================================================
describe("a delivery list during dispatch", () => {
  it("shows quantity progress per product and the dispatch history", () => {
    const l = list({ status: "partially_dispatched", dispatches: [{ ...(dispatchFrom([{ deliveryListItemId: I_BOLT, warehouseId: W_MAIN, quantity: "1" }]) as any), status: "confirmed" }] },
      [item(I_BOLT, BOLT, "BOLT-1", "Steel bolt", "pcs", "15.0000", { dispatched_quantity: "10.0000", remaining_quantity: "5.0000" })]);
    render(<DeliveryListDetail list={l as any} />);
    const progress = screen.getByTestId("progress-BOLT-1");
    expect(progress.textContent).toContain("10 of 15 pcs dispatched");
    expect(progress.textContent).toContain("5 remaining");
    expect(within(progress).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("66");
    expect(screen.getByRole("heading", { name: "Dispatches (1)" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Prepare dispatch" })[0].getAttribute("href")).toBe(`/delivery-lists/${LIST}/dispatch`);
    expect(screen.queryByRole("button", { name: "Reopen as draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel list" })).toBeNull();
  });
});

// =====================================================================================================
describe("Scan Product: Prepare Dispatch", () => {
  const product = { id: BOLT, sku: "BOLT-1", name: "Steel bolt", unit: "pcs", unit_allows_fractions: false, is_active: true } as any;
  const mountPanel = (onAdded = vi.fn()) => render(<DispatchPanel product={product} stock={STOCK[BOLT] as any} warehouses={warehouses as any} onAdded={onAdded} onClose={vi.fn()} />);
  const readyList = { id: LIST, number: "DL-000001", client: { id: CLIENT, name: "Acme Ltd", is_active: true }, status: "ready", item_count: 2 };

  it("is offered next to Stock In, Stock Out and Add to Deliverables", async () => {
    render(<ScanProduct warehouses={warehouses as any} />);
    await user().type(screen.getByLabelText(/Scan or type a barcode/), "BOLT-1{Enter}");
    const group = await screen.findByRole("group", { name: "Actions" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Stock In", "Stock Out", "Add to Deliverables", "Prepare Dispatch"]);
  });

  it("shows requested, dispatched, remaining and the warehouse stock, and needs a typed quantity", async () => {
    readyLists = [readyList];
    server["GET /api/sales/delivery-lists/:id"] = () => json(200, { list: list({}, [item(I_BOLT, BOLT, "BOLT-1", "Steel bolt", "pcs", "15.0000", { dispatched_quantity: "10.0000", remaining_quantity: "5.0000" })]) });
    mountPanel();
    const form = await screen.findByRole("form", { name: "Dispatch quantity" });
    for (const text of ["Client requested", "15 pcs", "Already dispatched", "10 pcs", "Remaining", "5 pcs"]) expect(form.textContent, text).toContain(text);
    expect((screen.getByPlaceholderText("Type the quantity") as HTMLInputElement).value).toBe("");
    expect(within(screen.getByLabelText("Dispatching warehouse")).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "MAIN — Main depot (40 pcs in stock)", "SHELF — Shelf room (20 pcs in stock)"]);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Add to the draft dispatch" }));
    expect(screen.getByRole("alert").textContent).toContain("Enter a quantity");
    await u.type(screen.getByPlaceholderText("Type the quantity"), "6");
    await u.click(screen.getByRole("button", { name: "Add to the draft dispatch" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("Only 5 pcs of Steel bolt can still be dispatched");
    expect(posts("/api/sales/dispatches")).toHaveLength(0);
  });

  it("refuses a product that is not on the selected list", async () => {
    readyLists = [readyList];
    server["GET /api/sales/delivery-lists/:id"] = () => json(200, { list: list({}, [item(I_FLOUR, FLOUR, "FLOUR", "Flour", "kg", "2.0000")]) });
    mountPanel();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Steel bolt (BOLT-1) is not on DL-000001"));
    expect(screen.queryByRole("form", { name: "Dispatch quantity" })).toBeNull();
  });

  it("saves the typed quantity to a NEW draft dispatch and deducts nothing", async () => {
    readyLists = [readyList];
    const onAdded = vi.fn();
    mountPanel(onAdded);
    const u = user();
    await screen.findByRole("form", { name: "Dispatch quantity" });
    await u.selectOptions(screen.getByLabelText("Dispatching warehouse"), W_SHELF);
    await u.type(screen.getByPlaceholderText("Type the quantity"), "6");
    await u.click(screen.getByRole("button", { name: "Add to the draft dispatch" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    const create = posts("/api/sales/dispatches");
    expect(create).toHaveLength(1);
    expect(create[0].headers["Idempotency-Key"]).toMatch(/^ui-/);
    expect(create[0].body).toEqual({ deliveryListId: LIST, lines: [{ deliveryListItemId: I_BOLT, warehouseId: W_SHELF, quantity: "6" }] });
    expect(onAdded.mock.calls[0][0]).toContain("Nothing has been deducted from stock");
    expect(posts("/confirm")).toHaveLength(0);
    expect(stockCalls()).toHaveLength(0);
  });

  it("a second scan SETS the quantity of that product and warehouse on the open draft - it never adds to it", async () => {
    readyLists = [readyList];
    openDraft = dispatchFrom([{ deliveryListItemId: I_BOLT, warehouseId: W_MAIN, quantity: "4.0000" }, { deliveryListItemId: I_FLOUR, warehouseId: W_MAIN, quantity: "1.0000" }]);
    mountPanel();
    const u = user();
    await screen.findByRole("form", { name: "Dispatch quantity" });
    await screen.findByText(/Adding to the open draft/);
    expect(screen.getByRole("status").textContent).toContain("already on DS-000001 from this warehouse with 4 pcs");
    expect(screen.getByRole("status").textContent).toContain("never adds to it");
    await u.type(screen.getByPlaceholderText("Type the quantity"), "7");
    await u.click(screen.getByRole("button", { name: "Replace the quantity on the draft" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body.lines).toEqual([
      { deliveryListItemId: I_FLOUR, warehouseId: W_MAIN, quantity: "1.0000" }, // untouched
      { deliveryListItemId: I_BOLT, warehouseId: W_MAIN, quantity: "7" }, // replaced, not 4 + 7
    ]);
  });

  it("explains when no list is ready", async () => {
    mountPanel();
    await waitFor(() => expect(screen.getByText(/No delivery list is ready for dispatch/)).toBeTruthy());
  });
});

// =====================================================================================================
describe("Receive Goods: the phone camera (Step 16B follow-up)", () => {
  const O1 = "a0000000-0000-4000-8000-0000000000aa";
  const L1 = "e0000000-0000-4000-8000-0000000000a1";
  const L2 = "e0000000-0000-4000-8000-0000000000a2";
  const orderLine = (id: string, productId: string, sku: string, name: string, unit: string, quantity: string) => ({
    id, product_id: productId, product_sku: sku, product_name: name, unit, quantity, unit_price: "2.0000", line_total: "20.0000", planned_warehouse_id: null, planned_warehouse_code: null, notes: null,
    created_at: now, updated_at: now, received_quantity: "0.0000", pending_quantity: "0.0000", remaining_quantity: quantity,
  });
  const order = {
    id: O1, number: "PO-000001", supplier: { id: CLIENT, name: "Acme Supplies", code: null, is_active: true }, status: "ordered", can_receive: true, receipts: [], frozen: true, stock_notice: "x",
    lines: [orderLine(L1, BOLT, "BOLT-1", "Steel bolt", "pcs", "10.0000"), orderLine(L2, FLOUR, "FLOUR", "Flour", "kg", "5.0000")],
  } as any;

  function fakeCamera() {
    const tracks = [{ stop: vi.fn() }];
    const getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }));
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    HTMLMediaElement.prototype.play = vi.fn(async () => undefined) as any;
    HTMLMediaElement.prototype.pause = vi.fn() as any;
    return { tracks, getUserMedia };
  }
  const mountReceive = () => render(<ReceiveForm order={order} warehouses={warehouses as any} draft={null} />);
  const accepted = (name: string) => screen.getByLabelText(`Accepted quantity of ${name}`) as HTMLInputElement;

  it("offers Use camera beside the manual box and keeps manual entry working", async () => {
    fakeCamera();
    mountReceive();
    expect(screen.getByRole("button", { name: "Use camera" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Find product" })).toBeTruthy();
    const u = user();
    await u.type(screen.getByPlaceholderText(/Type, or scan into this box/), "FLOUR{Enter}");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Flour (FLOUR) located"));
  });

  it("does not touch the camera until Start camera is pressed", async () => {
    const { getUserMedia } = fakeCamera();
    mountReceive();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Use camera" }));
    expect(getUserMedia).not.toHaveBeenCalled();
    await u.click(screen.getByRole("button", { name: "Start camera" }));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("locates a product of the purchase order with the camera, releases the camera, and enters no quantity", async () => {
    const { tracks } = fakeCamera();
    decoderState.code = "BOLT-1";
    mountReceive();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Use camera" }));
    await u.click(screen.getByRole("button", { name: "Start camera" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Steel bolt (BOLT-1) located"), { timeout: 3000 });
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(screen.queryByLabelText("Camera scanner")).toBeNull();
    expect(accepted("Steel bolt").value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(accepted("Steel bolt")));
    expect(calls.every((c) => c.url.startsWith("/api/scan/resolve"))).toBe(true); // a lookup only: nothing was saved
  });

  it("refuses a product that is not on the purchase order", async () => {
    const { tracks } = fakeCamera();
    decoderState.code = "NAILS";
    mountReceive();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Use camera" }));
    await u.click(screen.getByRole("button", { name: "Start camera" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Nails (NAILS) is not on PO-000001"), { timeout: 3000 });
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(screen.queryByLabelText("Accepted quantity of Nails")).toBeNull();
  });

  it("scanning the same product again never raises the quantity", async () => {
    fakeCamera();
    decoderState.code = "BOLT-1";
    mountReceive();
    const u = user();
    for (let round = 0; round < 2; round++) {
      await u.click(screen.getByRole("button", { name: "Use camera" }));
      await u.click(screen.getByRole("button", { name: "Start camera" }));
      await waitFor(() => expect(calls.filter((c) => c.url.startsWith("/api/scan/resolve")).length).toBe(round + 1), { timeout: 3000 });
      if (round === 0) await u.type(accepted("Steel bolt"), "3");
    }
    expect(accepted("Steel bolt").value).toBe("3");
  });

  it("turns the camera off when it is hidden", async () => {
    const { tracks } = fakeCamera();
    decoderState.code = null;
    mountReceive();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Use camera" }));
    await u.click(screen.getByRole("button", { name: "Start camera" }));
    await screen.findByRole("button", { name: "Stop camera" });
    await u.click(screen.getByRole("button", { name: "Hide camera" }));
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it("releases the camera when the page is left", async () => {
    const { tracks } = fakeCamera();
    decoderState.code = null;
    const { unmount } = mountReceive();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Use camera" }));
    await u.click(screen.getByRole("button", { name: "Start camera" }));
    await screen.findByRole("button", { name: "Stop camera" });
    unmount();
    expect(tracks[0].stop).toHaveBeenCalled();
  });
});
