// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import ReceiptDetailView from "@/app/goods-receipts/[id]/receipt-detail";
import ReceiptIndex from "@/app/invoices/suppliers/receipt-index";
import ReceiveForm from "@/app/purchase-orders/[id]/receive/receive-form";

const now = "2026-11-07T10:00:00+00:00";
const ORDER = "a0000000-0000-4000-8000-000000000001";
const SUPPLIER = "c0000000-0000-4000-8000-000000000001";
const BOLT = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const FLOUR = "7a1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const NAILS = "8b1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const L_BOLT = "e0000000-0000-4000-8000-000000000001";
const L_FLOUR = "e0000000-0000-4000-8000-000000000002";
const RECEIPT = "f0000000-0000-4000-8000-000000000001";

const product = (id: string, sku: string, name: string, unit: string, extra: Record<string, unknown> = {}) => ({
  id, sku, name, description: null, unit, unit_allows_fractions: unit === "kg", unit_locked: false, hs_code: null, cost_price: "1", selling_price: "2", currency_code: "USD",
  is_active: true, created_at: now, updated_at: now, ...extra,
});
const found = (p: ReturnType<typeof product>) => ({
  matched_by: "sku", identifier_kind: null, product: p,
  stock: { product_id: p.id, sku: p.sku, name: p.name, unit: p.unit, unit_allows_fractions: p.unit === "kg", is_active: p.is_active, total_quantity: "3" },
});
const CATALOG: Record<string, any> = {
  "BOLT-1": found(product(BOLT, "BOLT-1", "Steel bolt", "pcs")), FLOUR: found(product(FLOUR, "FLOUR", "Flour", "kg")), NAILS: found(product(NAILS, "NAILS", "Nails", "pcs")),
};

const orderLine = (id: string, productId: string, sku: string, name: string, unit: string, quantity: string, extra: Record<string, unknown> = {}) => ({
  id, product_id: productId, product_sku: sku, product_name: name, unit, quantity, unit_price: "2.0000", line_total: "20.0000", notes: null,
  created_at: now, updated_at: now, received_quantity: "0.0000", pending_quantity: "0.0000", remaining_quantity: quantity, ...extra,
});
const order = (extra: Record<string, unknown> = {}, lines?: any[]) => ({
  id: ORDER, number: "PO-000001", supplier: { id: SUPPLIER, name: "Acme Supplies", code: null, is_active: true }, supplier_reference: null, order_date: "2026-11-06", expected_delivery_date: null,
  currency_code: "USD", notes: null, status: "ordered", line_count: 2, total_amount: "30.0000", created_by_email: "a@b.c", ordered_at: now, ordered_by_email: "a@b.c", cancelled_at: null, cancelled_by_email: null,
  created_at: now, updated_at: now, frozen: true, stock_notice: "x", receipts: [], can_receive: true,
  lines: lines ?? [orderLine(L_BOLT, BOLT, "BOLT-1", "Steel bolt", "pcs", "10.0000"), orderLine(L_FLOUR, FLOUR, "FLOUR", "Flour", "kg", "5.0000")], ...extra,
});
// what the Purchasing Service would answer for a receipt built from the lines the browser sent
function receiptFrom(lines: any[], extra: Record<string, unknown> = {}) {
  const po = order();
  return {
    id: RECEIPT, number: "GR-000001", status: "draft", purchase_order: { id: ORDER, number: "PO-000001", status: "ordered" }, supplier: po.supplier, supplier_reference: null, received_date: "2026-11-07", notes: null,
    line_count: lines.length, created_by_email: "a@b.c", created_at: now, confirmed_at: null, confirmed_by_email: null, cancelled_at: null, cancelled_by_email: null, updated_at: now,
    lines: lines.map((l, i) => {
      const ol = po.lines.find((x) => x.id === l.purchaseOrderLineId)!;
      return {
        id: `d000000${i}-0000-4000-8000-000000000000`, purchase_order_line_id: ol.id, product_id: ol.product_id, product_sku: ol.product_sku, product_name: ol.product_name, unit: ol.unit,
        ordered_quantity: ol.quantity, received_elsewhere_quantity: "0.0000", pending_elsewhere_quantity: "0.0000", receivable_quantity: ol.quantity,
        accepted_quantity: l.acceptedQuantity, rejected_quantity: l.rejectedQuantity, notes: l.notes ?? null, inventory_movement_id: null,
      };
    }),
    posting: { attempts: 0, started_at: null, last_attempt_at: null, last_error: null }, inventory_operation_id: null, editable: true, stock_notice: "x", ...extra,
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; body: any; headers: any };
let calls: Call[];
let server: Record<string, (body: any, url: string, headers: any) => Response | Promise<Response>>;
let lastLines: any[] = [];

function stub() {
  calls = [];
  server = {};
  lastLines = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, headers: init.headers ?? {} });
    if (url.startsWith("/api/scan/resolve")) {
      const code = decodeURIComponent(url.split("code=")[1]);
      return CATALOG[code] ? json(200, CATALOG[code]) : json(404, { error: "No product in your catalog matches this code." });
    }
    const key = `${method} ${url.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id")}`;
    if (server[key]) return server[key](body, url, init.headers ?? {});
    if (key === "POST /api/purchasing/goods-receipts") { lastLines = body.lines; return json(201, { receipt: receiptFrom(body.lines), replayed: false }); }
    if (key === "PUT /api/purchasing/goods-receipts/:id/lines") { lastLines = body.lines; return json(200, { receipt: receiptFrom(body.lines) }); }
    if (key === "PATCH /api/purchasing/goods-receipts/:id") return json(200, { receipt: receiptFrom(lastLines) });
    if (key === "POST /api/purchasing/goods-receipts/:id/confirm") return json(200, { receipt: receiptFrom(lastLines, { status: "confirmed", editable: false, confirmed_at: now, confirmed_by_email: "a@b.c" }), confirmed: true });
    if (key === "POST /api/purchasing/goods-receipts/:id/cancel") return json(200, { receipt: receiptFrom(lastLines, { status: "cancelled", cancelled_at: now, cancelled_by_email: "a@b.c", editable: false }) });
    return json(404, { error: "not found" });
  }));
}
const posts = (suffix: string) => calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));
const stockCalls = () => calls.filter((c) => /\/api\/(stock|products|inventory)/.test(c.url));

beforeEach(() => { router.replace.mockReset(); router.refresh.mockReset(); router.push.mockReset(); stub(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const user = () => userEvent.setup();
const accepted = (name: string) => screen.getByLabelText(`Accepted quantity of ${name}`) as HTMLInputElement;
const rejected = (name: string) => screen.getByLabelText(`Rejected quantity of ${name}`) as HTMLInputElement;

function mount(props: Partial<{ order: any; draft: any }> = {}) {
  return render(<ReceiveForm order={(props.order ?? order()) as any} draft={(props.draft ?? null) as any} />);
}

describe("Receive goods: preparing the receipt", () => {
  it("shows what is ordered, received and still receivable, and says nothing changes stock yet", () => {
    mount({ order: order({}, [
      orderLine(L_BOLT, BOLT, "BOLT-1", "Steel bolt", "pcs", "10.0000", { received_quantity: "3.0000", pending_quantity: "2.0000", remaining_quantity: "5.0000" }),
      orderLine(L_FLOUR, FLOUR, "FLOUR", "Flour", "kg", "5.0000"),
    ]) });
    const row = screen.getByTestId("row-BOLT-1");
    expect(within(row).getByText("Steel bolt")).toBeTruthy();
    expect(row.textContent).toContain("10");
    expect(row.textContent).toContain("5"); // remaining
    expect(screen.getByRole("note").textContent).toContain("does not change your stock");
    expect(calls).toHaveLength(0);
  });

  it("asks for no warehouse at all", () => {
    mount();
    expect(screen.queryByLabelText(/Warehouse for/)).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Warehouse" })).toBeNull();
  });

  it("refuses an empty receipt without calling the server", async () => {
    mount();
    await user().click(screen.getByRole("button", { name: "Review receipt" }));
    expect(screen.getByRole("alert").textContent).toContain("Enter the quantity that arrived");
    expect(calls).toHaveLength(0);
  });

  it("refuses more than the remaining quantity, exactly, without calling the server", async () => {
    mount();
    const u = user();
    await u.type(accepted("Steel bolt"), "11");
    await u.click(screen.getByRole("button", { name: "Review receipt" }));
    expect(screen.getByRole("alert").textContent).toContain("Only 10 pcs of Steel bolt can still be received.");
    expect(calls).toHaveLength(0);
    await u.clear(accepted("Steel bolt"));
    await u.type(accepted("Flour"), "5.0001");
    await u.click(screen.getByRole("button", { name: "Review receipt" }));
    expect(screen.getByRole("alert").textContent).toContain("Only 5 kg of Flour can still be received.");
    expect(calls).toHaveLength(0);
  });

  it.each(["abc", "-1", "1.00001", "1e3", "1,5"])("refuses the quantity %j", async (value) => {
    mount();
    const u = user();
    await u.type(accepted("Steel bolt"), value);
    await u.click(screen.getByRole("button", { name: "Review receipt" }));
    expect(screen.getByRole("alert").textContent).toContain("at most 4 decimals");
    expect(calls).toHaveLength(0);
  });

  it("a fully received product cannot be received again", () => {
    mount({ order: order({}, [
      orderLine(L_BOLT, BOLT, "BOLT-1", "Steel bolt", "pcs", "10.0000", { received_quantity: "10.0000", remaining_quantity: "0.0000" }),
      orderLine(L_FLOUR, FLOUR, "FLOUR", "Flour", "kg", "5.0000"),
    ]) });
    expect(accepted("Steel bolt").disabled).toBe(true);
    expect(accepted("Flour").disabled).toBe(false);
  });
});

describe("Receive goods: locating a product by SKU or barcode", () => {
  it("finds a product on the order, highlights its row and moves to its quantity", async () => {
    mount();
    const u = user();
    await u.type(screen.getByPlaceholderText(/Type, or scan into this box/), "bolt-1");
    await u.click(screen.getByRole("button", { name: "Find product" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Steel bolt (BOLT-1) located"));
    expect(document.activeElement).toBe(accepted("Steel bolt"));
    expect(screen.getByTestId("row-BOLT-1").className).toContain("bg-indigo-500/10");
    expect(calls.map((c) => c.url)).toEqual(["/api/scan/resolve?code=BOLT-1"]);
  });

  it("rejects a real product that is NOT on this order", async () => {
    mount();
    const u = user();
    await u.type(screen.getByPlaceholderText(/Type, or scan into this box/), "NAILS");
    await u.click(screen.getByRole("button", { name: "Find product" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Nails (NAILS) is not on PO-000001"));
    expect(screen.queryByLabelText("Accepted quantity of Nails")).toBeNull();
  });

  it("reports an unknown code, a link and a fully received product", async () => {
    mount({ order: order({}, [orderLine(L_BOLT, BOLT, "BOLT-1", "Steel bolt", "pcs", "10.0000", { received_quantity: "10.0000", remaining_quantity: "0.0000" })]) });
    const u = user();
    const box = screen.getByPlaceholderText(/Type, or scan into this box/);
    await u.type(box, "NOPE");
    await u.click(screen.getByRole("button", { name: "Find product" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("No product in your catalog"));
    await u.clear(box);
    await u.type(box, "https://evil.example/x");
    await u.click(screen.getByRole("button", { name: "Find product" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("web link"));
    await u.clear(box);
    await u.type(box, "BOLT-1");
    await u.click(screen.getByRole("button", { name: "Find product" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("already fully received"));
  });

  it("locating never changes anything", async () => {
    mount();
    const u = user();
    await u.type(screen.getByPlaceholderText(/Type, or scan into this box/), "FLOUR");
    await u.click(screen.getByRole("button", { name: "Find product" }));
    await waitFor(() => screen.getByRole("status"));
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});

describe("Receive goods: review and explicit confirmation", () => {
  async function fillAndReview(u = user()) {
    await u.type(accepted("Steel bolt"), "4");
    await u.type(rejected("Steel bolt"), "1");
    await u.click(screen.getByRole("button", { name: "Review receipt" }));
    await screen.findByRole("heading", { name: "Review GR-000001" });
    return u;
  }

  it("saves a DRAFT with the exact quantities and a stable key - and changes no stock", async () => {
    mount();
    await fillAndReview();
    const create = posts("/api/purchasing/goods-receipts");
    expect(create).toHaveLength(1);
    expect(create[0].headers["Idempotency-Key"]).toMatch(/^ui-[0-9a-f-]{36}$/);
    expect(create[0].body).toMatchObject({
      purchaseOrderId: ORDER, receivedDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      lines: [{ purchaseOrderLineId: L_BOLT, acceptedQuantity: "4", rejectedQuantity: "1" }],
    });
    expect(JSON.stringify(create[0].body)).not.toMatch(/organization|unit|status|price/i);
    expect(posts("/confirm")).toHaveLength(0);
    expect(stockCalls()).toHaveLength(0);
    expect(screen.getByRole("note").textContent).toContain("Nothing has been added to your stock yet");
  });

  it("only the Confirm button adds stock, once", async () => {
    mount();
    const u = await fillAndReview();
    await u.click(screen.getByRole("button", { name: "Confirm and add to stock" }));
    await screen.findByText("GR-000001 confirmed");
    expect(posts("/confirm")).toHaveLength(1);
    expect(stockCalls()).toHaveLength(0); // the browser never writes stock itself
    expect(screen.getByRole("link", { name: "View the receipt" }).getAttribute("href")).toBe(`/goods-receipts/${RECEIPT}`);
    expect(screen.getByRole("link", { name: /Back to PO-000001/ }).getAttribute("href")).toBe(`/purchase-orders/${ORDER}`);
  });

  it("a double click on Confirm sends one request", async () => {
    let release: () => void = () => undefined;
    server["POST /api/purchasing/goods-receipts/:id/confirm"] = () =>
      new Promise<Response>((resolve) => { release = () => resolve(json(200, { receipt: receiptFrom(lastLines, { status: "confirmed", editable: false }), confirmed: true })); });
    mount();
    const u = await fillAndReview();
    const button = screen.getByRole("button", { name: "Confirm and add to stock" });
    await u.dblClick(button);
    expect(posts("/confirm")).toHaveLength(1);
    expect((screen.getByRole("button", { name: /Adding to stock/ }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await screen.findByText("GR-000001 confirmed");
    expect(posts("/confirm")).toHaveLength(1);
  });

  it("an unverified posting shows a retry, and retrying finishes it", async () => {
    let attempt = 0;
    server["POST /api/purchasing/goods-receipts/:id/confirm"] = () => {
      attempt += 1;
      return attempt === 1
        ? json(202, { receipt: receiptFrom(lastLines, { status: "posting", editable: false, posting: { attempts: 1, started_at: now, last_attempt_at: now, last_error: "The inventory service did not answer (ReadTimeout)." } }), confirmed: false })
        : json(200, { receipt: receiptFrom(lastLines, { status: "confirmed", editable: false }), confirmed: true });
    };
    mount();
    const u = await fillAndReview();
    await u.click(screen.getByRole("button", { name: "Confirm and add to stock" }));
    await screen.findByText("GR-000001 is being added to stock");
    expect(screen.getByRole("alert").textContent).toContain("Nothing is lost and nothing will be added twice");
    expect(screen.getByRole("alert").textContent).toContain("did not answer");
    await u.click(screen.getByRole("button", { name: "Retry posting" }));
    await screen.findByText("GR-000001 confirmed");
    expect(posts("/confirm")).toHaveLength(2);
    expect(posts("/api/purchasing/goods-receipts")).toHaveLength(1); // the draft was created once
  });

  it("a definitive refusal explains itself and returns to editing the draft", async () => {
    server["POST /api/purchasing/goods-receipts/:id/confirm"] = () => json(409, { error: "The inventory service refused to add this receipt to stock: Steel bolt is archived. Nothing was added.", code: "inventory_rejected" });
    mount();
    const u = await fillAndReview();
    await u.click(screen.getByRole("button", { name: "Confirm and add to stock" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Steel bolt is archived. Nothing was added."));
    expect(screen.getByRole("button", { name: "Review receipt" })).toBeTruthy(); // back on the editing view, with the draft intact
    expect(accepted("Steel bolt").value).toBe("4");
  });

  it("going back and reviewing again updates the same draft instead of creating another", async () => {
    mount();
    const u = await fillAndReview();
    await u.click(screen.getByRole("button", { name: "Back to edit" }));
    expect(accepted("Steel bolt").value).toBe("4");
    await u.clear(accepted("Steel bolt"));
    await u.type(accepted("Steel bolt"), "6");
    await u.click(screen.getByRole("button", { name: "Review receipt" }));
    await screen.findByRole("heading", { name: "Review GR-000001" });
    expect(posts("/api/purchasing/goods-receipts")).toHaveLength(1);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(`/api/purchasing/goods-receipts/${RECEIPT}/lines`);
    expect(put.body.lines[0]).toMatchObject({ purchaseOrderLineId: L_BOLT, acceptedQuantity: "6" });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0); // the header did not change
  });

  it("a failed save can be retried with the SAME key", async () => {
    let first = true;
    server["POST /api/purchasing/goods-receipts"] = (body) => {
      if (first) { first = false; return json(503, { error: "The purchasing service is unavailable. Please try again shortly." }); }
      lastLines = body.lines;
      return json(201, { receipt: receiptFrom(body.lines), replayed: false });
    };
    mount();
    const u = user();
    await u.type(accepted("Steel bolt"), "2");
    await u.click(screen.getByRole("button", { name: "Review receipt" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("unavailable"));
    await u.click(screen.getByRole("button", { name: "Review receipt" }));
    await screen.findByRole("heading", { name: "Review GR-000001" });
    const keys = posts("/api/purchasing/goods-receipts").map((c) => c.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("an over-receipt caught by the server is shown and nothing is reviewed", async () => {
    server["POST /api/purchasing/goods-receipts"] = () => json(409, { error: "You cannot receive 4 pcs of Steel bolt: ordered 10, already received 8, so at most 2 can still be received.", code: "over_receipt" });
    mount();
    const u = user();
    await u.type(accepted("Steel bolt"), "4");
    await u.click(screen.getByRole("button", { name: "Review receipt" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("at most 2 can still be received"));
    expect(screen.queryByRole("heading", { name: /Review/ })).toBeNull();
  });

  it("discarding the draft cancels it and returns to the order", async () => {
    mount();
    const u = await fillAndReview();
    await u.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/purchase-orders/${ORDER}`));
    expect(posts("/cancel")).toHaveLength(1);
    expect(posts("/confirm")).toHaveLength(0);
  });

  it("an expired session goes to the sign-in page, from every step", async () => {
    server["POST /api/purchasing/goods-receipts"] = () => json(401, { error: "Your session has expired. Please sign in again." });
    mount();
    const u = user();
    await u.type(accepted("Steel bolt"), "1");
    await u.click(screen.getByRole("button", { name: "Review receipt" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("resuming a draft fills in what was saved and updates it (PUT), keeping its number", async () => {
    const draft = receiptFrom([{ purchaseOrderLineId: L_FLOUR, acceptedQuantity: "2.5000", rejectedQuantity: "0.5000", notes: "damp" }]);
    mount({ draft });
    expect(accepted("Flour").value).toBe("2.5");
    expect(rejected("Flour").value).toBe("0.5");
    expect(screen.getByRole("status").textContent).toContain("Editing the draft GR-000001");
    await user().click(screen.getByRole("button", { name: "Review receipt" }));
    await screen.findByRole("heading", { name: "Review GR-000001" });
    expect(posts("/api/purchasing/goods-receipts")).toHaveLength(0);
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
  });
});

// ---- one receipt --------------------------------------------------------------------------------------------------------------------
const detailOf = (extra: Record<string, unknown> = {}) => receiptFrom([{ purchaseOrderLineId: L_BOLT, acceptedQuantity: "4.0000", rejectedQuantity: "1.0000" }], extra) as any;

describe("a goods receipt page", () => {
  it("confirms a draft and updates in place", async () => {
    lastLines = [{ purchaseOrderLineId: L_BOLT, acceptedQuantity: "4.0000", rejectedQuantity: "1.0000" }];
    render(<ReceiptDetailView receipt={detailOf()} />);
    await user().click(screen.getByRole("button", { name: "Confirm and add to stock" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("is confirmed"));
    expect(screen.getByText("Confirmed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm and add to stock" })).toBeNull();
    expect(posts("/confirm")).toHaveLength(1);
  });

  it("a posting receipt offers Retry posting and explains the 202", async () => {
    server["POST /api/purchasing/goods-receipts/:id/confirm"] = () => json(202, { receipt: detailOf({ status: "posting", editable: false, posting: { attempts: 3, started_at: now, last_attempt_at: now, last_error: "x" } }), confirmed: false });
    render(<ReceiptDetailView receipt={detailOf({ status: "posting", editable: false, posting: { attempts: 2, started_at: now, last_attempt_at: now, last_error: "The inventory service failed (500)." } })} />);
    expect(screen.getByRole("status").textContent).toContain("Attempts: 2");
    expect(screen.queryByText("Edit receipt")).toBeNull();
    await user().click(screen.getByRole("button", { name: "Retry posting" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("has not confirmed the posting yet"));
    expect(screen.getByText("Attempts: 3", { exact: false })).toBeTruthy();
  });

  it("discarding needs a second click and shows what happened", async () => {
    render(<ReceiptDetailView receipt={detailOf()} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(posts("/cancel")).toHaveLength(0);
    expect(screen.getByRole("alertdialog").textContent).toContain("No stock is involved");
    await u.click(screen.getByRole("button", { name: "Yes, discard it" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("was cancelled"));
    expect(posts("/cancel")).toHaveLength(1);
  });

  it("a confirmed receipt has no actions, shows the movement and keeps rejected goods out of the stock column", () => {
    render(<ReceiptDetailView receipt={detailOf({ status: "confirmed", editable: false, confirmed_at: now, confirmed_by_email: "a@b.c", lines: detailOf().lines.map((l: any) => ({ ...l, inventory_movement_id: "c3c3c3c3-aaaa-4bbb-8ccc-123456789abc" })) })} />);
    expect(screen.queryByRole("group", { name: "Receipt actions" })?.children.length ?? 0).toBe(0);
    expect(screen.getByText("#c3c3c3c3")).toBeTruthy();
    expect(screen.getByText("Rejected")).toBeTruthy();
  });

  it("shows why a refused draft was returned to editing", () => {
    render(<ReceiptDetailView receipt={detailOf({ posting: { attempts: 1, started_at: null, last_attempt_at: now, last_error: "Steel bolt is archived." } })} />);
    expect(screen.getByRole("alert").textContent).toContain("nothing was added: Steel bolt is archived.");
  });
});

// ---- the list ---------------------------------------------------------------------------------------------------------------------------
describe("the goods receipts list", () => {
  const list = { ok: true as const, items: [{ ...(detailOf() as any), line_count: 1 }], total: 1, limit: 25, offset: 0 };
  const filters = { q: "", status: "" as const, supplierId: "", dateFrom: "", dateTo: "", page: 1 };

  it("changing a filter navigates with only whitelisted query parameters", async () => {
    render(<ReceiptIndex list={list} filters={filters} suppliers={[{ id: SUPPLIER, name: "Acme Supplies", is_active: true } as any]} />);
    const u = user();
    await u.selectOptions(screen.getByLabelText("Status"), "confirmed");
    expect(router.push).toHaveBeenLastCalledWith("/invoices/suppliers?status=confirmed");
    expect(screen.queryByLabelText("Warehouse")).toBeNull();
    await u.type(screen.getByLabelText("Search"), "dn-7{enter}");
    expect(router.push).toHaveBeenLastCalledWith("/invoices/suppliers?q=dn-7");
  });

  it("clears filters and shows the right empty state", async () => {
    render(<ReceiptIndex list={{ ok: true, items: [], total: 0, limit: 25, offset: 0 }} filters={{ ...filters, status: "draft" }} suppliers={[]} />);
    expect(screen.getByText("No goods receipts match these filters.")).toBeTruthy();
    await user().click(screen.getByRole("button", { name: "Clear filters" }));
    expect(router.push).toHaveBeenLastCalledWith("/invoices/suppliers");
  });
});
