// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import StockOverview from "@/app/stock/stock-overview";
import { IDEMPOTENCY_KEY_RE } from "@/lib/stock-validation";

// The Stock page's top-level "Add Stock" REGISTERS A NEW PRODUCT (and may record the quantity the organization already owns). Registering the product and
// recording its opening quantity are two separate operations; these tests pin that neither is ever pretended to be the other, that nothing is created or
// counted twice, and that stock changes of EXISTING products stay in their own, clearly named actions.

const now = "2026-11-10T10:00:00+00:00";
const P1 = "b0000000-0000-4000-8000-000000000001";
const NEW = "c0000000-0000-4000-8000-000000000009";
const row = (over: Record<string, unknown> = {}) => ({
  product_id: P1, sku: "BOLT-1", name: "Steel bolt", unit: "pcs", unit_allows_fractions: false, is_active: true,
  total_quantity: "500.0000", reserved_quantity: "400.0000", available_quantity: "100.0000", cost_price: "1.2500", selling_price: "2.5000", currency_code: "USD", ...over,
});
const product = (over: Record<string, unknown> = {}) => ({
  id: P1, sku: "BOLT-1", name: "Steel bolt", description: null, unit: "pcs", unit_allows_fractions: false, unit_locked: false, hs_code: null,
  cost_price: "1.2500", selling_price: "2.5000", currency_code: "USD", is_active: true, created_at: now, updated_at: now, ...over,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; body: any; headers: Record<string, string> };
let calls: Call[];
let onProduct: (body: any) => Response | Promise<Response>;
let onOpening: (body: any, headers: Record<string, string>) => Response | Promise<Response>;

beforeEach(() => {
  calls = [];
  Object.values(router).forEach((fn) => fn.mockReset());
  onProduct = (body) => json(201, { product: product({ id: NEW, sku: body.sku, name: body.name, unit: body.unit, cost_price: body.costPrice, selling_price: body.sellingPrice, currency_code: body.currencyCode }) });
  onOpening = () => json(201, { operation: { operation_id: "op-1", kind: "opening", replayed: false } });
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, body, headers });
    if (method === "POST" && url === "/api/products") return onProduct(body);
    if (method === "POST" && url === "/api/stock/opening") return onOpening(body, headers);
    if (method === "POST" && /\/api\/stock\/(in|out)$/.test(url)) return json(201, { operation: { operation_id: "op-x", replayed: false } });
    return json(404, { error: "not found" });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const filters = { q: "", inStockOnly: false, status: "active" as const, page: 1 };
const mount = (products = [product()]) =>
  render(<StockOverview list={{ ok: true, items: [row()], total: 1, limit: 25, offset: 0 } as any} filters={filters} products={products as any} />);
const writes = () => calls.filter((c) => c.method !== "GET");
const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Add Stock" }));
  return screen.findByRole("dialog", { name: "Add Product to Stock" });
};
async function fill(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, v: { sku?: string; name?: string; unit?: string; cost?: string; selling?: string; opening?: string } = {}) {
  const x = { sku: "dell-001", name: "Dell Latitude Laptop", unit: "pcs", cost: "620", selling: "799", ...v };
  await user.type(within(dialog).getByLabelText("SKU or product code"), x.sku);
  await user.type(within(dialog).getByLabelText("Product name"), x.name);
  await user.type(within(dialog).getByLabelText("Unit of measurement"), x.unit);
  await user.type(within(dialog).getByLabelText("Cost price"), x.cost);
  if (x.opening !== undefined) await user.type(within(dialog).getByLabelText(/^Opening quantity$/), x.opening);
}
const submit = (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) => user.click(within(dialog).getByRole("button", { name: "Add product" }));

describe("the buttons on the Stock page", () => {
  it("are Add Stock, Remove Stock and Opening Balance, in that order, and no redundant New product button", () => {
    mount();
    const top = screen.getAllByRole("button").map((b) => b.textContent).filter((t) => ["Add Stock", "Remove Stock", "Opening Balance", "New product"].includes(t ?? ""));
    expect(top).toEqual(["Add Stock", "Remove Stock", "Opening Balance"]);
  });

  it("a product's row has no Stock In / Stock Out buttons any more: its Actions are only the Edit and Delete icons", () => {
    mount();
    const rowOf = within(screen.getAllByRole("row")[1]);
    expect(rowOf.queryByRole("button", { name: /Stock In|Stock Out/ })).toBeNull();
    expect(rowOf.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Edit Steel bolt", "Delete Steel bolt"]);
  });
});

describe("Add Stock opens a form for a NEW product", () => {
  it("titled 'Add Product to Stock', with every field of the spec, no category and NO existing-product selector", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openDialog(user);
    for (const label of ["Product name", "SKU or product code", "Unit of measurement", "Cost price", "Currency", "HS code", "Description"]) expect(within(dialog).getByLabelText(new RegExp(`^${label}`)), label).toBeTruthy();
    expect(within(dialog).getByLabelText(/^Barcode/)).toBeTruthy();
    expect(within(dialog).getByLabelText(/^Opening quantity$/)).toBeTruthy();
    expect(within(dialog).queryByLabelText("Selling price")).toBeNull(); // retired: no universal selling price
    expect(dialog.querySelector("select")).toBeNull(); // no "choose a product" dropdown (the unit box is a text box with suggestions)
    expect(within(dialog).queryByRole("combobox", { name: /^Product$/ })).toBeNull();
    expect(within(dialog).queryByText(/Choose a product/i)).toBeNull();
    expect(within(dialog).queryByText(/categor/i)).toBeNull();
    expect((within(dialog).getByLabelText("Currency") as HTMLInputElement).value).toBe("USD");
  });

  it("explains the opening quantity section in the words of the spec", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openDialog(user);
    expect(within(dialog).getByRole("heading", { name: "Existing Stock / Opening Quantity" })).toBeTruthy();
    expect(dialog.textContent).toContain("Enter a quantity only if your organization already owns these goods. For new purchases, quantities are added when Goods Receipts are confirmed.");
  });

  it("validates the required fields inline and sends nothing until they are right", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openDialog(user);
    await submit(user, dialog);
    for (const text of ["Enter a SKU.", "Enter the product name.", "Enter the unit of measurement", "Enter the cost price."]) expect(dialog.textContent, text).toContain(text);
    expect(calls).toEqual([]);
    expect(screen.getByRole("dialog", { name: "Add Product to Stock" })).toBeTruthy(); // it stays open
  });

  it.each(["abc", "-5", "1.23456", "1,5"])("refuses the opening quantity %j beside the field and sends nothing", async (typed) => {
    const user = userEvent.setup();
    mount();
    const dialog = await openDialog(user);
    await fill(user, dialog, { opening: typed });
    await submit(user, dialog);
    expect((await within(dialog).findByText(/Use a positive number with at most 4 decimals/)).getAttribute("role")).toBe("alert");
    expect(calls).toEqual([]);
  });

  it("disables the submit button while saving, so a double click cannot register the product twice", async () => {
    const user = userEvent.setup();
    let release!: (r: Response) => void;
    onProduct = () => new Promise<Response>((resolve) => { release = resolve; });
    mount();
    const dialog = await openDialog(user);
    await fill(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));
    const saving = await within(dialog).findByRole("button", { name: "Saving…" });
    expect((saving as HTMLButtonElement).disabled).toBe(true);
    await user.click(saving);
    expect(calls.filter((c) => c.url === "/api/products")).toHaveLength(1);
    release(json(201, { product: product({ id: NEW, sku: "DELL-001", name: "Dell Latitude Laptop" }) }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Cancel closes it without sending anything", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toEqual([]);
  });
});

describe("Scenario A: a new product with no existing stock", () => {
  it.each([[undefined], ["0"], ["0.00"]])("opening quantity %j: the product is created and NO stock movement is recorded", async (opening) => {
    const user = userEvent.setup();
    mount();
    const dialog = await openDialog(user);
    await fill(user, dialog, { sku: "cisco-001", name: "Cisco Router", ...(opening !== undefined ? { opening } : {}) });
    await submit(user, dialog);
    await screen.findByText("Added Cisco Router (CISCO-001).");
    expect(writes().map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/products"]); // no /api/stock call at all: no artificial movement
    expect(writes()[0].body).toMatchObject({ sku: "CISCO-001", name: "Cisco Router", unit: "pcs", costPrice: "620", currencyCode: "USD" }); // no selling price: it is agreed per sales order
    expect(Object.keys(writes()[0].body)).not.toContain("quantity");
    expect(router.refresh).toHaveBeenCalled(); // the Stock table re-reads, so the new product shows at once (with 0 on hand)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("Scenario B: a new product the organization already owns", () => {
  it("creates the product, then records the quantity through the existing Opening Balance endpoint exactly once, with an idempotency key", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openDialog(user);
    await fill(user, dialog, { sku: "dell-001", name: "Dell Latitude Laptop", opening: "35" });
    await submit(user, dialog);
    await screen.findByText(/Added Dell Latitude Laptop \(DELL-001\)\. 35 pcs recorded as the opening balance\./);
    expect(writes().map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/products", "POST /api/stock/opening"]);
    expect(writes()[1].body).toEqual({ product_id: NEW, quantity: "35" }); // the id the product was just given; no organization, no extra mechanism
    expect(writes()[1].headers["Idempotency-Key"]).toMatch(IDEMPOTENCY_KEY_RE);
    expect(router.refresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("allows a decimal quantity (the service decides, per unit, whether that unit may have one)", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openDialog(user);
    await fill(user, dialog, { sku: "cable-1", name: "Copper cable", unit: "m", opening: "12.5" });
    await submit(user, dialog);
    await screen.findByText(/12\.5 m recorded as the opening balance/);
    expect(writes()[1].body).toEqual({ product_id: NEW, quantity: "12.5" });
  });

  it("a duplicate SKU is refused on the SKU field: nothing is created and no quantity is recorded", async () => {
    onProduct = () => json(409, { error: "A product with SKU 'DELL-001' already exists in your catalog.", fieldErrors: { sku: "A product with SKU 'DELL-001' already exists in your catalog." } });
    const user = userEvent.setup();
    mount();
    const dialog = await openDialog(user);
    await fill(user, dialog, { opening: "35" });
    await submit(user, dialog);
    expect((await within(dialog).findAllByText(/already exists in your catalog/)).length).toBeGreaterThan(0);
    expect(writes().map((c) => c.url)).toEqual(["/api/products"]); // the opening balance was never attempted
    expect((within(dialog).getByLabelText("Product name") as HTMLInputElement).value).toBe("Dell Latitude Laptop"); // what was typed is kept
    expect((within(dialog).getByLabelText(/^Opening quantity$/) as HTMLInputElement).value).toBe("35");
  });
});

describe("when the product is created but recording the quantity fails (partial success)", () => {
  const fail = (user: ReturnType<typeof userEvent.setup>) => async () => {
    mount();
    const dialog = await openDialog(user);
    await fill(user, dialog, { opening: "35" });
    await submit(user, dialog);
    return dialog;
  };

  it("says so plainly (not 'success'), keeps the product, and offers a retry of the quantity only", async () => {
    onOpening = () => json(503, { error: "The inventory service is unavailable. Please try again shortly." });
    const user = userEvent.setup();
    const dialog = await fail(user)();
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Dell Latitude Laptop (DELL-001) was registered, but its opening quantity was not recorded.");
    expect(alert.textContent).toContain("The inventory service is unavailable");
    expect(alert.textContent).toContain("will not be created again");
    expect(alert.textContent).toContain("can never count the quantity twice");
    expect(screen.queryByText(/recorded as the opening balance/)).toBeNull(); // no success message
    expect(within(dialog).queryByLabelText("SKU or product code")).toBeNull(); // the product form is gone: it cannot be submitted again
    expect((within(dialog).getByLabelText(/^Opening quantity$/) as HTMLInputElement).value).toBe("35");
    expect(router.refresh).toHaveBeenCalled(); // the table behind already shows the new product
    expect(calls.filter((c) => c.url === "/api/products")).toHaveLength(1);
  });

  it("retrying the same quantity reuses the SAME idempotency key and never creates the product again", async () => {
    let attempts = 0;
    onOpening = () => (++attempts === 1 ? json(503, { error: "down" }) : json(200, { operation: { operation_id: "op-1", replayed: false } }));
    const user = userEvent.setup();
    const dialog = await fail(user)();
    await within(dialog).findByRole("alert");
    await user.click(within(dialog).getByRole("button", { name: "Record opening quantity" }));
    await screen.findByText(/Added Dell Latitude Laptop \(DELL-001\)\. 35 pcs recorded as the opening balance\./);
    const openings = writes().filter((c) => c.url === "/api/stock/opening");
    expect(openings).toHaveLength(2);
    expect(openings[1].headers["Idempotency-Key"]).toBe(openings[0].headers["Idempotency-Key"]); // the service applies it once, however often it is sent
    expect(openings[1].body).toEqual(openings[0].body);
    expect(writes().filter((c) => c.url === "/api/products")).toHaveLength(1); // the product was created ONCE
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("tells the administrator when the service replays an already-applied request (nothing counted twice)", async () => {
    let attempts = 0;
    onOpening = () => (++attempts === 1 ? json(0 || 500, { error: "lost" }) : json(200, { operation: { operation_id: "op-1", replayed: true } }));
    const user = userEvent.setup();
    const dialog = await fail(user)();
    await within(dialog).findByRole("alert");
    await user.click(within(dialog).getByRole("button", { name: "Record opening quantity" }));
    await screen.findByText(/That quantity had already been recorded; nothing was counted twice\./);
  });

  it("a lost connection is handled the same way: partial success, then a safe retry", async () => {
    let attempts = 0;
    onOpening = () => { if (++attempts === 1) throw new Error("network down"); return json(201, { operation: { replayed: false } }); };
    const user = userEvent.setup();
    const dialog = await fail(user)();
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Unable to reach the server");
    await user.click(within(dialog).getByRole("button", { name: "Record opening quantity" }));
    await screen.findByText(/35 pcs recorded as the opening balance/);
    expect(writes().filter((c) => c.url === "/api/products")).toHaveLength(1);
  });

  it("a DIFFERENT quantity is a different request and gets a new key", async () => {
    let attempts = 0;
    onOpening = () => (++attempts === 1 ? json(503, { error: "down" }) : json(201, { operation: { replayed: false } }));
    const user = userEvent.setup();
    const dialog = await fail(user)();
    await within(dialog).findByRole("alert");
    const box = within(dialog).getByLabelText(/^Opening quantity$/);
    await user.clear(box);
    await user.type(box, "36");
    await user.click(within(dialog).getByRole("button", { name: "Record opening quantity" }));
    await screen.findByText(/36 pcs recorded as the opening balance/);
    const openings = writes().filter((c) => c.url === "/api/stock/opening");
    expect(openings[1].body.quantity).toBe("36");
    expect(openings[1].headers["Idempotency-Key"]).not.toBe(openings[0].headers["Idempotency-Key"]);
  });

  it("the service refusing because the product already has stock history stops the retry (it may already be recorded)", async () => {
    onOpening = () => json(409, { error: "Dell Latitude Laptop already has stock history. An opening balance can only be recorded before any other movement; use Stock In or Stock Out on the product instead." });
    const user = userEvent.setup();
    const dialog = await fail(user)();
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("already has stock history");
    expect(alert.textContent).toContain("may already be recorded");
    expect(within(dialog).queryByRole("button", { name: "Record opening quantity" })).toBeNull(); // no way to push it again
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("a refused quantity (for example a fraction of a counted unit) can be corrected and retried", async () => {
    let attempts = 0;
    onOpening = (body) => (++attempts === 1 ? json(422, { error: "Use a whole number: this product is counted in 'pcs'." }) : json(201, { operation: { replayed: false, q: body.quantity } }));
    const user = userEvent.setup();
    mount();
    const dialog = await openDialog(user);
    await fill(user, dialog, { opening: "2.5" });
    await submit(user, dialog);
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Use a whole number");
    const box = within(dialog).getByLabelText(/^Opening quantity$/);
    await user.clear(box);
    await user.type(box, "3");
    await user.click(within(dialog).getByRole("button", { name: "Record opening quantity" }));
    await screen.findByText(/3 pcs recorded as the opening balance/);
    expect(writes().filter((c) => c.url === "/api/products")).toHaveLength(1);
  });

  it("'Record it later' (or closing the dialog) leaves the product with no stock and points to Opening Balance; no stock call is made", async () => {
    onOpening = () => json(503, { error: "down" });
    const user = userEvent.setup();
    const dialog = await fail(user)();
    await within(dialog).findByRole("alert");
    await user.click(within(dialog).getByRole("button", { name: "Record it later" }));
    await screen.findByText(/Added Dell Latitude Laptop \(DELL-001\) with no stock yet\. Use Opening Balance to record its starting quantity\./);
    expect(writes().filter((c) => c.url === "/api/stock/opening")).toHaveLength(1); // only the first attempt
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a quantity that is empty, malformed or zero on retry is refused beside the field and sends nothing", async () => {
    onOpening = () => json(503, { error: "down" });
    const user = userEvent.setup();
    const dialog = await fail(user)();
    await within(dialog).findByRole("alert");
    const box = within(dialog).getByLabelText(/^Opening quantity$/);
    await user.clear(box);
    await user.click(within(dialog).getByRole("button", { name: "Record opening quantity" }));
    expect(await within(dialog).findByText(/Enter the quantity you already own/)).toBeTruthy();
    expect(writes().filter((c) => c.url === "/api/stock/opening")).toHaveLength(1);
  });
});

describe("Opening Balance and the existing-product actions stay separate", () => {
  it("Opening Balance still lets the administrator select an existing product (and offers only Remove Stock / Opening Balance)", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Opening Balance" }));
    const form = await screen.findByRole("form", { name: "Opening Balance" });
    expect(within(form).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Remove Stock", "Opening Balance"]);
    expect(within(form).getByRole("combobox", { name: "Product" })).toBeTruthy(); // select an existing product here, unlike Add Stock
    expect(form.textContent).toContain("Only possible before any other movement");
  });

  it("Remove Stock (the button above the table) takes available stock out of an existing product the administrator selects, and posts to the existing endpoint", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Remove Stock" }));
    const form = await screen.findByRole("form", { name: "Remove Stock" });
    expect(form.textContent).toContain("stock reserved for customer orders cannot be taken");
    await user.selectOptions(within(form).getByRole("combobox", { name: "Product" }), P1);
    await user.type(within(form).getByLabelText(/^Quantity/), "5");
    await user.click(within(form).getByRole("button", { name: "Remove stock" }));
    await screen.findByText(/Stock removed\./);
    expect(writes()[0]).toMatchObject({ url: "/api/stock/out", body: { product_id: P1, quantity: "5" } });
  });
});
