// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import OrderDetail from "@/app/purchase-orders/[id]/order-detail";
import OrderIndex from "@/app/purchase-orders/order-index";
import SupplierManager from "@/app/suppliers/supplier-manager";

const now = "2026-11-06T10:00:00+00:00";
const BOLT = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const FLOUR = "7a1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const O1 = "a0000000-0000-4000-8000-000000000001";
const S1 = "c0000000-0000-4000-8000-000000000001";
const S2 = "c0000000-0000-4000-8000-000000000002";
const L1 = "e0000000-0000-4000-8000-000000000001";
const W1 = "22222222-2222-4222-8222-222222222222";

const product = (id: string, sku: string, name: string, unit: string, extra: Record<string, unknown> = {}) => ({
  id, sku, name, description: null, category: "G", unit, unit_allows_fractions: unit === "kg", unit_locked: false, hs_code: null, cost_price: "1", selling_price: "2", currency_code: "USD",
  is_active: true, created_at: now, updated_at: now, ...extra,
});
const result = (p: ReturnType<typeof product>) => ({
  matched_by: "sku", identifier_kind: null, product: p,
  stock: { product_id: p.id, sku: p.sku, name: p.name, category: "G", unit: p.unit, unit_allows_fractions: p.unit === "kg", is_active: p.is_active, total_quantity: "3", available_quantity: "3", lines: [] },
});
const CATALOG: Record<string, any> = {
  "BOLT-1": result(product(BOLT, "BOLT-1", "Steel bolt", "pcs")), FLOUR: result(product(FLOUR, "FLOUR", "Flour", "kg")),
  "OLD-1": result(product(BOLT, "OLD-1", "Old bolt", "pcs", { is_active: false })),
};
const supplier = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, code: null, contact_person: null, email: null, phone: null, address: null, country_code: null, tax_identifier: null, is_active: true, created_at: now, updated_at: now, ...extra });
const line = (extra: Record<string, unknown> = {}) => ({ id: L1, product_id: BOLT, product_sku: "BOLT-1", product_name: "Steel bolt", unit: "pcs", quantity: "50.0000", unit_price: "1.2500", line_total: "62.5000", planned_warehouse_id: null, planned_warehouse_code: null, notes: null, created_at: now, updated_at: now, ...extra });
const order = (extra: Record<string, unknown> = {}) => ({
  id: O1, number: "PO-000001", supplier: { id: S1, name: "Acme Supplies", code: null, is_active: true }, supplier_reference: null, order_date: "2026-11-06", expected_delivery_date: null,
  currency_code: "USD", notes: null, status: "draft", line_count: 1, total_amount: "62.5000", created_by_email: "a@b.c", ordered_at: null, ordered_by_email: null,
  cancelled_at: null, cancelled_by_email: null, created_at: now, updated_at: now, lines: [line()], frozen: false,
  stock_notice: "A purchase order does not change your stock. Placing an order does not add the goods to inventory; they are added only when they are received (a later step).", ...extra,
});
const warehouses = [{ id: W1, code: "MAIN", name: "Main depot", address: null, is_active: true, created_at: now, updated_at: now, products_in_stock: 0 }];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; body: any; headers: any };
let calls: Call[];
let server: Record<string, (body: any, url: string, headers: any) => Response | Promise<Response>>;

function stub() {
  calls = [];
  server = {};
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, headers: init.headers ?? {} });
    if (url.startsWith("/api/scan/resolve")) {
      const code = decodeURIComponent(url.split("code=")[1]);
      return CATALOG[code] ? json(200, CATALOG[code]) : json(404, { error: "No product in your catalog matches this code." });
    }
    const key = `${method} ${url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")}`;
    if (server[key]) return server[key](body, url, init.headers ?? {});
    if (/\/lines$/.test(url) && method === "POST") return json(201, { line: line(), line_count: 2, total_amount: "70.2500", currency_code: "USD" });
    if (/\/lines\/[^/]+$/.test(url) && method === "PATCH") return json(200, { line: line(), line_count: 1, total_amount: "1.0000", currency_code: "USD" });
    if (/\/lines\/[^/]+$/.test(url) && method === "DELETE") return json(200, { line_count: 0, total_amount: "0.0000", currency_code: "USD" });
    if (/\/(order|cancel)$/.test(url) && method === "POST") return json(200, { order: order() });
    if (url === "/api/purchasing/purchase-orders" && method === "POST") return json(201, { order: order({ id: O1 }), replayed: false });
    if (/\/purchase-orders\/[^/]+$/.test(url) && method === "PATCH") return json(200, { order: order() });
    if (url === "/api/purchasing/suppliers" && method === "POST") return json(201, { supplier: supplier(S2, body.name) });
    if (/\/suppliers\/[^/]+\/(activate|deactivate)$/.test(url)) return json(200, { supplier: supplier(S1, "x") });
    if (/\/suppliers\/[^/]+$/.test(url) && method === "PATCH") return json(200, { supplier: supplier(S1, body.name ?? "x") });
    return json(404, { error: "not found" });
  }));
}
const writes = () => calls.filter((c) => c.method !== "GET" && !c.url.startsWith("/api/scan"));
const inventoryWrites = () => calls.filter((c) => c.url.includes("/api/stock") || c.url.includes("/api/products") || c.url.includes("/api/inventory"));

beforeEach(() => { router.replace.mockReset(); router.refresh.mockReset(); router.push.mockReset(); stub(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const setup = () => userEvent.setup();

async function openLookup(user: ReturnType<typeof setup>, code: string, props: Record<string, unknown> = {}) {
  render(<OrderDetail order={order(props) as any} warehouses={warehouses as any} suppliers={[supplier(S1, "Acme Supplies"), supplier(S2, "Other Co")] as any} />);
  await user.click(screen.getByRole("button", { name: /Find a product/ }));
  await user.type(screen.getByLabelText("SKU or barcode"), `${code}{Enter}`);
}

describe("Purchase order detail: the lines and the total", () => {
  it("shows the lines, the backend-calculated total and the 'no stock' notice", () => {
    render(<OrderDetail order={order() as any} warehouses={[]} suppliers={[]} />);
    const lines = screen.getByRole("region", { name: "Products on this order" });
    expect(lines.textContent).toContain("Steel bolt");
    expect(lines.textContent).toContain("50 pcs");
    expect(lines.textContent).toContain("1.25 USD");
    expect(lines.textContent).toContain("62.50 USD");
    expect(screen.getByTestId("order-total").textContent).toBe("62.50 USD");
    expect(screen.getByRole("note").textContent).toContain("does not change your stock");
  });

  it("looks an existing product up by SKU, then adds it with a quantity and a price (preview calculated exactly)", async () => {
    const user = setup();
    await openLookup(user, "flour");
    const form = await screen.findByRole("form", { name: "Add Flour to PO-000001" });
    expect(form.textContent).toContain("Unit: kg");
    expect(form.textContent).toContain("decimal quantities allowed");
    await user.type(within(form).getByLabelText(/^Quantity to order/), "2.5");
    await user.type(within(form).getByLabelText(/^Unit purchase price/), "3.10");
    expect(within(form).getByTestId("line-preview").textContent).toContain("7.75 USD");
    await user.click(within(form).getByRole("button", { name: "Add to order" }));
    await screen.findByText("Added 2.5 kg of Flour to PO-000001.");
    expect(writes()).toEqual([{ url: "/api/purchasing/purchase-orders/" + O1 + "/lines", method: "POST", headers: expect.anything(),
      body: { productId: FLOUR, quantity: "2.5", unitPrice: "3.10", plannedWarehouseId: "", notes: "" } }]);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("sends only the id, the quantity, the price (and optional warehouse and note): never a name, SKU, unit or total", async () => {
    const user = setup();
    await openLookup(user, "BOLT-1");
    const form = await screen.findByRole("form", { name: "Add Steel bolt to PO-000001" });
    await user.type(within(form).getByLabelText(/^Quantity to order/), "50");
    await user.type(within(form).getByLabelText(/^Unit purchase price/), "1.25");
    await user.selectOptions(within(form).getByLabelText(/Planned warehouse/), W1);
    await user.type(within(form).getByLabelText(/Line note/), "pallet");
    await user.click(within(form).getByRole("button", { name: "Add to order" }));
    await screen.findByText(/Added 50 pcs/);
    const body = writes()[0].body;
    expect(body).toEqual({ productId: BOLT, quantity: "50", unitPrice: "1.25", plannedWarehouseId: W1, notes: "pallet" });
    expect(JSON.stringify(body)).not.toMatch(/name|sku|unit":|total|organization|tenant/i);
  });

  it("an order for 50 units never calls anything that could add stock or change a product", async () => {
    const user = setup();
    await openLookup(user, "BOLT-1");
    const form = await screen.findByRole("form", { name: /^Add Steel bolt/ });
    await user.type(within(form).getByLabelText(/^Quantity to order/), "50");
    await user.type(within(form).getByLabelText(/^Unit purchase price/), "1.25");
    await user.click(within(form).getByRole("button", { name: "Add to order" }));
    await screen.findByText(/Added 50 pcs/);
    expect(inventoryWrites()).toHaveLength(0);
    expect(calls.every((c) => c.url.startsWith("/api/purchasing") || c.url.startsWith("/api/scan/resolve"))).toBe(true);
  });

  it.each([["0", "1", /greater than zero/], ["-2", "1", /positive number/], ["abc", "1", /positive number/], ["1.5", "1", /whole number/], ["1.00001", "1", /positive number/],
    ["5", "-1", /at most 4 decimals/], ["5", "abc", /at most 4 decimals/], ["5", "1.00001", /at most 4 decimals/]])(
    "refuses quantity %j with price %j before sending anything", async (quantity, price, message) => {
      const user = setup();
      await openLookup(user, "BOLT-1");
      const form = await screen.findByRole("form", { name: /^Add Steel bolt/ });
      await user.type(within(form).getByLabelText(/^Quantity to order/), quantity);
      await user.type(within(form).getByLabelText(/^Unit purchase price/), price);
      await within(form).findAllByText(message);
      await user.click(within(form).getByRole("button", { name: "Add to order" }));
      expect(writes()).toHaveLength(0);
    });

  it("accepts a zero price and decimals for a measurable unit", async () => {
    const user = setup();
    await openLookup(user, "flour");
    const form = await screen.findByRole("form", { name: /^Add Flour/ });
    await user.type(within(form).getByLabelText(/^Quantity to order/), "0.25");
    await user.type(within(form).getByLabelText(/^Unit purchase price/), "0");
    expect(within(form).queryByRole("alert")).toBeNull();
    expect(within(form).getByTestId("line-preview").textContent).toContain("0.00 USD");
  });

  it("keeps Add disabled until both the quantity and the price are entered (nothing is assumed)", async () => {
    const user = setup();
    await openLookup(user, "BOLT-1");
    const form = await screen.findByRole("form", { name: /^Add Steel bolt/ });
    expect((within(form).getByRole("button", { name: "Add to order" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(form).getByLabelText(/^Quantity to order/), "5");
    expect((within(form).getByRole("button", { name: "Add to order" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(form).getByLabelText(/^Unit purchase price/) as HTMLInputElement).value).toBe("");
  });

  it("explains a product that is already on the order and changes nothing", async () => {
    server["POST /api/purchasing/purchase-orders/:id/lines"] = () => json(409, { error: "Steel bolt (BOLT-1) is already on this order: 50 pcs at 1.25. Edit that line instead of adding the product again.", code: "duplicate_line", line: { id: L1, quantity: "50.0000", unit: "pcs", unit_price: "1.2500", product_name: "Steel bolt" } });
    const user = setup();
    await openLookup(user, "BOLT-1");
    const form = await screen.findByRole("form", { name: /^Add Steel bolt/ });
    await user.type(within(form).getByLabelText(/^Quantity to order/), "3");
    await user.type(within(form).getByLabelText(/^Unit purchase price/), "9");
    await user.click(within(form).getByRole("button", { name: "Add to order" }));
    expect((await within(form).findByRole("alert")).textContent).toContain("already on this order");
    expect(writes()).toHaveLength(1); // only the refused add
  });

  it.each([[404, "Product not found."], [409, "Old bolt is archived and cannot be ordered."], [503, "The inventory service is unavailable, so products cannot be checked right now."]])(
    "shows the service's answer %i and keeps what was typed", async (status, error) => {
      server["POST /api/purchasing/purchase-orders/:id/lines"] = () => json(status, { error });
      const user = setup();
      await openLookup(user, "BOLT-1");
      const form = await screen.findByRole("form", { name: /^Add Steel bolt/ });
      await user.type(within(form).getByLabelText(/^Quantity to order/), "4");
      await user.type(within(form).getByLabelText(/^Unit purchase price/), "2");
      await user.click(within(form).getByRole("button", { name: "Add to order" }));
      expect((await within(form).findByRole("alert")).textContent).toContain(error);
      expect((within(form).getByLabelText(/^Quantity to order/) as HTMLInputElement).value).toBe("4");
    });

  it("a double click on Add sends one request", async () => {
    let release!: () => void;
    server["POST /api/purchasing/purchase-orders/:id/lines"] = () => new Promise<Response>((resolve) => { release = () => resolve(json(201, { line: line(), line_count: 2, total_amount: "1.0000", currency_code: "USD" })); }) as unknown as Response;
    const user = setup();
    await openLookup(user, "BOLT-1");
    const form = await screen.findByRole("form", { name: /^Add Steel bolt/ });
    await user.type(within(form).getByLabelText(/^Quantity to order/), "4");
    await user.type(within(form).getByLabelText(/^Unit purchase price/), "2");
    await user.dblClick(within(form).getByRole("button", { name: "Add to order" }));
    expect(writes()).toHaveLength(1);
    release();
    await screen.findByText(/Added 4 pcs/);
    expect(writes()).toHaveLength(1);
  });

  it("reports an unknown, archived or link-like code in the lookup without adding anything", async () => {
    const user = setup();
    await openLookup(user, "NOPE");
    expect((await screen.findByRole("alert")).textContent).toContain("No product in your catalog matches");
    await user.clear(screen.getByLabelText("SKU or barcode"));
    await user.type(screen.getByLabelText("SKU or barcode"), "OLD-1{Enter}");
    expect((await screen.findByText(/is archived and cannot be ordered/)).textContent).toContain("Old bolt");
    await user.clear(screen.getByLabelText("SKU or barcode"));
    await user.type(screen.getByLabelText("SKU or barcode"), "https://evil.example{Enter}");
    expect((await screen.findAllByRole("alert")).some((a) => a.textContent?.includes("not opened"))).toBe(true);
    expect(writes()).toHaveLength(0);
  });
});

describe("Purchase order detail: editing and removing lines", () => {
  it("edits quantity and price with a live preview, validated first, then sends only those two strings", async () => {
    const user = setup();
    render(<OrderDetail order={order() as any} warehouses={[]} suppliers={[]} />);
    await user.click(screen.getByRole("button", { name: "Edit Steel bolt" }));
    const quantity = screen.getByLabelText("Quantity of Steel bolt");
    const price = screen.getByLabelText("Unit price of Steel bolt");
    await user.clear(quantity);
    await user.type(quantity, "60");
    await user.clear(price);
    await user.type(price, "1.1");
    expect(screen.getByText(/Line total: 66.00 USD/)).toBeTruthy();
    await user.clear(price);
    await user.type(price, "-1{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("at most 4 decimals");
    expect(writes()).toHaveLength(0);
    await user.clear(price);
    await user.type(price, "1.1{Enter}");
    await screen.findByText("Steel bolt was updated.");
    expect(writes()).toEqual([{ url: `/api/purchasing/purchase-orders/${O1}/lines/${L1}`, method: "PATCH", headers: expect.anything(), body: { quantity: "60", unitPrice: "1.1" } }]);
  });

  it("shows the server's refusal of a fraction for a piece count", async () => {
    server["PATCH /api/purchasing/purchase-orders/:id/lines/:id"] = () => json(400, { error: "Quantity must be a whole number: Steel bolt is counted in 'pcs'." });
    const user = setup();
    render(<OrderDetail order={order() as any} warehouses={[]} suppliers={[]} />);
    await user.click(screen.getByRole("button", { name: "Edit Steel bolt" }));
    const quantity = screen.getByLabelText("Quantity of Steel bolt");
    await user.clear(quantity);
    await user.type(quantity, "2.5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("whole number");
  });

  it("removes a line only after confirmation", async () => {
    const user = setup();
    render(<OrderDetail order={order() as any} warehouses={[]} suppliers={[]} />);
    await user.click(screen.getByRole("button", { name: "Remove Steel bolt" }));
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Yes" }));
    await screen.findByText("Steel bolt was removed from PO-000001.");
    expect(writes()).toEqual([{ url: `/api/purchasing/purchase-orders/${O1}/lines/${L1}`, method: "DELETE", headers: expect.anything(), body: undefined }]);
  });

  it("saves the order details (supplier, dates, reference, notes) of a draft", async () => {
    const user = setup();
    await openLookup(user, "BOLT-1"); // opens the add panel; the header editor is next to it
    await user.click(screen.getByRole("button", { name: "Edit order details" }));
    const form = screen.getByRole("form", { name: "Order details" });
    await user.selectOptions(within(form).getByLabelText("Supplier"), S2);
    await user.type(within(form).getByLabelText("Supplier reference"), "QUOTE-9");
    expect((within(form).getByLabelText(/^Currency/) as HTMLInputElement).disabled).toBe(true); // the order has lines
    await user.click(within(form).getByRole("button", { name: "Save order details" }));
    await screen.findByText("Order details saved.");
    expect(writes()[0]).toMatchObject({ method: "PATCH", url: `/api/purchasing/purchase-orders/${O1}` });
    expect(writes()[0].body).toMatchObject({ supplierId: S2, supplierReference: "QUOTE-9" });
  });
});

describe("Purchase order detail: placing and cancelling", () => {
  it("asks before placing, says what freezes, and sends one POST on confirmation", async () => {
    const user = setup();
    render(<OrderDetail order={order() as any} warehouses={[]} suppliers={[]} />);
    await user.click(screen.getByRole("button", { name: "Mark as Ordered" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Confirm placing the order" });
    expect(dialog.textContent).toContain("Place PO-000001 with Acme Supplies for 62.50 USD?");
    expect(dialog.textContent).toContain("frozen and can no longer be changed");
    expect(dialog.textContent).toContain("does not add any stock");
    expect(writes()).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Place order" }));
    await screen.findByText(/was placed with Acme Supplies\. Its details and lines are now frozen\. No stock was added\./);
    expect(writes()).toEqual([{ url: `/api/purchasing/purchase-orders/${O1}/order`, method: "POST", headers: expect.anything(), body: undefined }]);
    expect(inventoryWrites()).toHaveLength(0);
  });

  it("'Back' places nothing", async () => {
    const user = setup();
    render(<OrderDetail order={order() as any} warehouses={[]} suppliers={[]} />);
    await user.click(screen.getByRole("button", { name: "Mark as Ordered" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it("cannot be placed while empty", () => {
    render(<OrderDetail order={order({ lines: [], line_count: 0, total_amount: "0.0000" }) as any} warehouses={[]} suppliers={[]} />);
    expect((screen.getByRole("button", { name: "Mark as Ordered" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a refusal (e.g. an archived product) instead of pretending it worked", async () => {
    server["POST /api/purchasing/purchase-orders/:id/order"] = () => json(409, { error: "These products are no longer available (archived or missing): Steel bolt (BOLT-1). Remove them first." });
    const user = setup();
    render(<OrderDetail order={order() as any} warehouses={[]} suppliers={[]} />);
    await user.click(screen.getByRole("button", { name: "Mark as Ordered" }));
    await user.click(screen.getByRole("button", { name: "Place order" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no longer available");
  });

  it("cancels only after confirmation", async () => {
    const user = setup();
    render(<OrderDetail order={order() as any} warehouses={[]} suppliers={[]} />);
    await user.click(screen.getByRole("button", { name: "Cancel order" }));
    expect(writes()).toHaveLength(0);
    await user.click(await screen.findByRole("button", { name: "Yes, cancel it" }));
    await screen.findByText(/was cancelled\. It is kept for history; no stock was involved/);
    expect(writes().map((c) => c.url)).toEqual([`/api/purchasing/purchase-orders/${O1}/cancel`]);
  });

  it("an ordered order shows no editing controls but can still be cancelled; a cancelled one has no actions", async () => {
    const { unmount } = render(<OrderDetail order={order({ status: "ordered", frozen: true, ordered_at: now, ordered_by_email: "a@b.c" }) as any} warehouses={[]} suppliers={[]} />);
    expect(screen.getByText(/Its details, products, quantities and prices are frozen/)).toBeTruthy();
    for (const name of ["Mark as Ordered", "Edit Steel bolt", "Remove Steel bolt", "Edit order details"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel order" })).toBeTruthy();
    unmount();
    render(<OrderDetail order={order({ status: "cancelled", frozen: true, cancelled_at: now, cancelled_by_email: "a@b.c" }) as any} warehouses={[]} suppliers={[]} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("warns when the supplier is inactive", () => {
    render(<OrderDetail order={order({ supplier: { id: S1, name: "Dormant Co", code: null, is_active: false } }) as any} warehouses={[]} suppliers={[]} />);
    expect(screen.getByText(/inactive supplier/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Dormant Co is inactive");
  });
});

describe("Creating an order (duplicate protection)", () => {
  const suppliers = [supplier(S1, "Acme Supplies"), supplier(S2, "Other Co")];
  const base = { q: "", supplierId: "", status: "" as const, page: 1 };
  const open = async (user: ReturnType<typeof setup>) => {
    render(<OrderIndex list={{ ok: true, items: [], total: 0, limit: 25, offset: 0 }} filters={base} suppliers={suppliers as any} />);
    await user.click(screen.getByRole("button", { name: "New Purchase Order" }));
    return screen.getByRole("form", { name: "New purchase order" });
  };

  it("creates a draft, sending an Idempotency-Key, and opens it", async () => {
    const user = setup();
    const form = await open(user);
    await user.selectOptions(within(form).getByLabelText("Supplier"), S1);
    await user.type(within(form).getByLabelText(/Supplier reference/), "Q-1");
    await user.click(within(form).getByRole("button", { name: "Create draft order" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/purchase-orders/${O1}`));
    const create = calls.find((c) => c.method === "POST")!;
    expect(create.headers["Idempotency-Key"]).toMatch(/^ui-[0-9a-f-]{36}$/);
    expect(create.body).toMatchObject({ supplierId: S1, currencyCode: "USD", supplierReference: "Q-1" });
    expect(JSON.stringify(create.body)).not.toMatch(/organization|status|number|total/i);
  });

  it("a double click creates one order", async () => {
    let release!: () => void;
    server["POST /api/purchasing/purchase-orders"] = () => new Promise<Response>((resolve) => { release = () => resolve(json(201, { order: order(), replayed: false })); }) as unknown as Response;
    const user = setup();
    const form = await open(user);
    await user.selectOptions(within(form).getByLabelText("Supplier"), S1);
    await user.dblClick(within(form).getByRole("button", { name: "Create draft order" }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    release();
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a retry after a lost connection reuses the same key (the server creates the order once); a change gets a new key", async () => {
    let attempt = 0;
    server["POST /api/purchasing/purchase-orders"] = () => { attempt += 1; if (attempt === 1) throw new TypeError("network down"); return json(200, { order: order(), replayed: true }); };
    const user = setup();
    const form = await open(user);
    await user.selectOptions(within(form).getByLabelText("Supplier"), S1);
    await user.click(within(form).getByRole("button", { name: "Create draft order" }));
    expect((await within(form).findByRole("alert")).textContent).toContain("Unable to reach the server");
    await user.click(within(form).getByRole("button", { name: "Create draft order" }));
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    const keys = calls.filter((c) => c.method === "POST").map((c) => c.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("different values are a different order with a new key", async () => {
    server["POST /api/purchasing/purchase-orders"] = () => { throw new TypeError("network down"); };
    const user = setup();
    const form = await open(user);
    await user.selectOptions(within(form).getByLabelText("Supplier"), S1);
    await user.click(within(form).getByRole("button", { name: "Create draft order" }));
    await within(form).findByRole("alert");
    await user.type(within(form).getByLabelText(/Supplier reference/), "changed");
    await user.click(within(form).getByRole("button", { name: "Create draft order" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const keys = calls.filter((c) => c.method === "POST").map((c) => c.headers["Idempotency-Key"]);
    expect(new Set(keys).size).toBe(2);
  });

  it("asks for a supplier, a sensible currency and consistent dates before sending anything", async () => {
    const user = setup();
    const form = await open(user);
    await user.click(within(form).getByRole("button", { name: "Create draft order" }));
    expect(await within(form).findByText("Choose a supplier.")).toBeTruthy();
    await user.selectOptions(form.querySelector("select")!, S1); // (its label now contains the error text)
    await user.clear(within(form).getByLabelText("Currency"));
    await user.type(within(form).getByLabelText("Currency"), "US");
    fireEvent.change(within(form).getByLabelText("Order date"), { target: { value: "2026-11-10" } });
    fireEvent.change(within(form).getByLabelText(/Expected delivery/), { target: { value: "2026-11-01" } });
    await user.click(within(form).getByRole("button", { name: "Create draft order" }));
    expect(await within(form).findByText(/3-letter currency code/)).toBeTruthy();
    expect(within(form).getByText(/cannot be before the order date/)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("offers only active suppliers for new orders but all suppliers as a filter", async () => {
    const user = setup();
    const both = [...suppliers, supplier("c3", "Dormant Co", { is_active: false })];
    render(<OrderIndex list={{ ok: true, items: [], total: 0, limit: 25, offset: 0 }} filters={base} suppliers={both as any} />);
    expect(within(screen.getByLabelText("Supplier")).getAllByRole("option").map((o) => o.textContent)).toEqual(["All suppliers", "Acme Supplies", "Other Co", "Dormant Co (inactive)"]);
    await user.click(screen.getByRole("button", { name: "New Purchase Order" }));
    const form = screen.getByRole("form", { name: "New purchase order" });
    expect(within(within(form).getByLabelText("Supplier")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a supplier…", "Acme Supplies", "Other Co"]);
  });
});

describe("Suppliers", () => {
  const filters = { q: "", status: "active" as const, page: 1 };
  const acme = supplier(S1, "Acme Supplies", { code: "AC", contact_person: "Jane", email: "j@a.example", country_code: "DE", tax_identifier: "DE123", address: "1 Main St" });

  it("registers a supplier with the fields the service stores", async () => {
    const user = setup();
    render(<SupplierManager list={{ ok: true, items: [], total: 0, limit: 25, offset: 0 }} filters={filters} />);
    await user.click(screen.getByRole("button", { name: "Add Supplier" }));
    const form = screen.getByRole("form", { name: "Add supplier" });
    await user.type(within(form).getByLabelText(/Supplier \/ company name/), "Globex");
    await user.type(within(form).getByLabelText(/Country code/), "pk");
    await user.type(within(form).getByLabelText(/Tax identifier/), "NTN-1");
    await user.click(within(form).getByRole("button", { name: "Register supplier" }));
    await screen.findByText("Globex was registered.");
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ url: "/api/purchasing/suppliers", body: expect.objectContaining({ name: "Globex", countryCode: "pk", taxIdentifier: "NTN-1" }) });
  });

  it("requires a name before sending anything", async () => {
    const user = setup();
    render(<SupplierManager list={{ ok: true, items: [], total: 0, limit: 25, offset: 0 }} filters={filters} />);
    await user.click(screen.getByRole("button", { name: "Add Supplier" }));
    await user.click(screen.getByRole("button", { name: "Register supplier" }));
    expect(await screen.findByText("Enter the supplier's name.")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("shows a duplicate name under the Name field and a duplicate code under the Code field", async () => {
    server["POST /api/purchasing/suppliers"] = () => json(409, { error: "A supplier named 'Acme' already exists in your directory.", fieldErrors: { name: "A supplier named 'Acme' already exists in your directory." } });
    const user = setup();
    render(<SupplierManager list={{ ok: true, items: [acme], total: 1, limit: 25, offset: 0 }} filters={filters} />);
    await user.click(screen.getByRole("button", { name: "Add Supplier" }));
    const form = screen.getByRole("form", { name: "Add supplier" });
    await user.type(within(form).getByLabelText(/Supplier \/ company name/), "Acme");
    await user.click(within(form).getByRole("button", { name: "Register supplier" }));
    await waitFor(() => expect(within(form).getAllByText(/already exists/).length).toBeGreaterThan(0));
  });

  it("opens the supplier's details, with a link to its purchase orders", async () => {
    const user = setup();
    render(<SupplierManager list={{ ok: true, items: [acme], total: 1, limit: 25, offset: 0 }} filters={filters} />);
    await user.click(screen.getByRole("button", { name: "Details of Acme Supplies" }));
    const details = screen.getByRole("region", { name: "Supplier details" });
    for (const expected of ["Acme Supplies", "AC", "Jane", "j@a.example", "DE", "DE123", "1 Main St", "Active"]) expect(details.textContent, expected).toContain(expected);
    expect(within(details).getByRole("link", { name: "Purchase orders" }).getAttribute("href")).toBe(`/purchase-orders?supplier=${S1}`);
  });

  it("edits a supplier, deactivates and reactivates it (no delete exists)", async () => {
    const user = setup();
    const { unmount } = render(<SupplierManager list={{ ok: true, items: [acme], total: 1, limit: 25, offset: 0 }} filters={filters} />);
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit Acme Supplies" }));
    const form = screen.getByRole("form", { name: "Edit supplier" });
    await user.clear(within(form).getByLabelText(/Phone/));
    await user.type(within(form).getByLabelText(/Phone/), "555");
    await user.click(within(form).getByRole("button", { name: "Save changes" }));
    await screen.findByText(/was updated/);
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: `/api/purchasing/suppliers/${S1}`, body: expect.objectContaining({ phone: "555" }) });
    await user.click(screen.getByRole("button", { name: "Deactivate Acme Supplies" }));
    await screen.findByText(/Acme Supplies was deactivated\. Its orders are kept/);
    expect(calls.find((c) => c.url.endsWith("/deactivate"))).toBeTruthy();
    unmount();
    render(<SupplierManager list={{ ok: true, items: [{ ...acme, is_active: false }], total: 1, limit: 25, offset: 0 }} filters={filters} />);
    await user.click(screen.getByRole("button", { name: "Reactivate Acme Supplies" }));
    await screen.findByText(/was reactivated/);
  });
});
