// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import StockOverview from "@/app/stock/stock-overview";

// The Stock page is the product inventory now that the Products tab is gone: figures, prices and status per product, and a dialog for the product's
// information (details, editing, barcodes, status) that is kept apart from the forms that change quantities.

const now = "2026-11-09T10:00:00+00:00";
const P1 = "b0000000-0000-4000-8000-000000000001";
const P2 = "b0000000-0000-4000-8000-000000000002";
const row = (over: Record<string, unknown> = {}) => ({
  product_id: P1, sku: "BOLT-1", name: "Steel bolt", unit: "pcs", unit_allows_fractions: false, is_active: true,
  total_quantity: "500.0000", reserved_quantity: "400.0000", available_quantity: "100.0000", cost_price: "1.2500", selling_price: "2.5000", currency_code: "USD", ...over,
});
const product = (over: Record<string, unknown> = {}) => ({
  id: P1, sku: "BOLT-1", name: "Steel bolt", description: "M10 hex bolt", unit: "pcs", unit_allows_fractions: false, unit_locked: false, hs_code: "7318.15",
  cost_price: "1.2500", selling_price: "2.5000", currency_code: "USD", is_active: true, created_at: now, updated_at: now, ...over,
});
const identifier = { id: "i1", product_id: P1, kind: "manufacturer", value: "5901234123457", label: null, is_active: true, created_at: now };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; body: any };
let calls: Call[];
let current: ReturnType<typeof product>;
let identifiers: unknown[];

beforeEach(() => {
  calls = [];
  current = product();
  identifiers = [identifier];
  Object.values(router).forEach((fn) => fn.mockReset());
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (method === "GET" && url === `/api/products/${P1}`) return json(200, { product: current, identifiers, label: null });
    if (method === "PATCH" && url === `/api/products/${P1}`) { current = { ...current, ...(body.name ? { name: body.name } : {}) }; return json(200, { product: current }); }
    if (method === "POST" && url === `/api/products/${P1}/archive`) { current = { ...current, is_active: false }; return json(200, { product: current }); }
    if (method === "POST" && url === `/api/products/${P1}/restore`) { current = { ...current, is_active: true }; return json(200, { product: current }); }
    if (method === "POST" && url === `/api/products/${P1}/identifiers`) { identifiers = [...identifiers, { ...identifier, id: "i2", value: body.value, kind: body.kind }]; return json(201, { identifier: identifiers[identifiers.length - 1] }); }
    if (method === "POST" && url === "/api/products") return json(201, { product: product({ id: P2, sku: body.sku, name: body.name }) });
    return json(404, { error: "not found" });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const filters = { q: "", inStockOnly: false, status: "active" as const, page: 1 };
const mount = (items = [row()]) => render(<StockOverview list={{ ok: true, items, total: items.length, limit: 25, offset: 0 } as any} filters={filters} products={[product()] as any} />);
const writes = () => calls.filter((c) => c.method !== "GET");
/** The row's Edit icon opens the product dialog on its edit form; Cancel there shows the product's details (barcodes, archive, restore). */
const openEdit = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Edit Steel bolt" }));
  return screen.findByRole("dialog", { name: "Steel bolt" });
};
const openDetails = async (user: ReturnType<typeof userEvent.setup>) => {
  const dialog = await openEdit(user);
  await user.click(await within(dialog).findByRole("button", { name: "Cancel" }));
  return dialog;
};

describe("the Stock page shows the product inventory", () => {
  it("lists name, SKU, unit, reserved, available, cost, price, the Total (on hand x price) and status for each product; there is no On hand column", () => {
    mount([row(), row({ product_id: P2, sku: "NUT-1", name: "Steel nut", is_active: false, total_quantity: "0.0000", reserved_quantity: "0.0000", available_quantity: "0.0000", cost_price: "0.1000", selling_price: "0.2000" })]);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Product", "Unit", "Reserved", "Available", "Cost", "Price", "Total", "Status", "Actions"]);
    const [bolt, nut] = within(table).getAllByRole("row").slice(1);
    expect(within(bolt).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Steel boltBOLT-1", "pcs", "400", "100", "1.25 USD", "2.50 USD", "1,250.00 USD", "Active", ""]);
    expect(within(nut).getByText("Archived")).toBeTruthy();
    expect(within(nut).getAllByRole("cell")[4].textContent).toBe("0.10 USD");
    expect(within(nut).getAllByRole("cell")[6].textContent).toBe("0.00 USD"); // nothing on hand: nothing is worth anything
  });

  it("the Total is the quantity on hand times the selling price, exactly, and a dash when there is no price", () => {
    mount([
      row({ product_id: P1, sku: "A", total_quantity: "500.0000", selling_price: "2.5000" }),
      row({ product_id: P2, sku: "B", total_quantity: "0.3333", selling_price: "10.0000", currency_code: "EUR" }),
      row({ product_id: "b0000000-0000-4000-8000-000000000003", sku: "C", total_quantity: "12.5000", selling_price: null, currency_code: null }),
      row({ product_id: "b0000000-0000-4000-8000-000000000004", sku: "D", total_quantity: "1234567.0000", selling_price: "1999.9999" }),
    ]);
    expect(screen.getByTestId("total-A").textContent).toBe("1,250.00 USD");
    expect(screen.getByTestId("total-B").textContent).toBe("3.333 EUR"); // 0.3333 x 10.00 = 3.333: never rounded away
    expect(screen.getByTestId("total-C").textContent).toBe("—");
    expect(screen.getByTestId("total-D").textContent).toBe("2,469,133,876.5433 USD"); // exact, no floating point
    expect(screen.queryByTestId("onhand-A")).toBeNull();
  });

  it("has exactly three actions at the top (Add Stock, Remove Stock, Opening Balance); no standalone Products link or category", () => {
    mount();
    for (const name of ["Add Stock", "Remove Stock", "Opening Balance"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New product" })).toBeNull(); // the old, redundant button is gone
    expect(screen.queryByRole("link", { name: /products/i })).toBeNull();
    expect(screen.queryByText(/categor/i)).toBeNull();
  });
});

describe("the product dialog (view and edit a product without leaving Stock)", () => {
  it("the Edit icon opens the dialog on the edit form; Cancel shows the product's information, and there is no quantity field: stock is changed only by the stock forms", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openEdit(user);
    expect(await within(dialog).findByRole("form", { name: "Edit product" })).toBeTruthy();
    expect(within(dialog).queryByLabelText(/quantity/i)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await within(dialog).findByText("M10 hex bolt");
    for (const text of ["BOLT-1", "pcs", "1.25 USD", "2.50 USD", "7318.15", "Active"]) expect(dialog.textContent, text).toContain(text);
    expect(within(dialog).queryByLabelText(/quantity/i)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /add stock|remove stock|opening/i })).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET /api/products/${P1}`]); // opening it changes nothing
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("edits the name and description and sends only what changed; the page behind re-reads its figures", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openEdit(user);
    const form = await within(dialog).findByRole("form", { name: "Edit product" });
    const name = within(form).getByLabelText("Product name");
    await user.clear(name);
    await user.type(name, "Steel bolt M10");
    await user.click(within(form).getByRole("button", { name: "Save changes" }));
    await within(dialog).findByText("Saved changes to Steel bolt M10.");
    expect(writes()).toEqual([{ url: `/api/products/${P1}`, method: "PATCH", body: { name: "Steel bolt M10" } }]);
    expect(router.refresh).toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Steel bolt M10" })).toBeTruthy(); // reloaded from the server
  });

  it("locks the unit of a product that already has stock movements", async () => {
    current = product({ unit_locked: true });
    const user = userEvent.setup();
    mount();
    const dialog = await openEdit(user);
    expect(await within(dialog).findByText(/Locked: this product already has stock movements/)).toBeTruthy();
    expect((within(dialog).getByLabelText("Unit of measurement") as HTMLInputElement).disabled).toBe(true);
  });

  it("archives (after a confirmation) and restores a product; nothing is erased", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openDetails(user);
    await user.click(await within(dialog).findByRole("button", { name: "Archive" }));
    expect(writes()).toEqual([]); // asked first
    await user.click(within(dialog).getByRole("button", { name: "Yes, archive" }));
    await within(dialog).findByText(/Steel bolt was archived/);
    expect(writes()).toEqual([{ url: `/api/products/${P1}/archive`, method: "POST", body: undefined }]);
    await user.click(await within(dialog).findByRole("button", { name: "Restore" }));
    await within(dialog).findByText("Steel bolt was restored.");
    expect(writes().map((c) => c.url)).toEqual([`/api/products/${P1}/archive`, `/api/products/${P1}/restore`]);
  });

  it("shows the registered barcodes and registers an additional one", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openDetails(user);
    await user.click(await within(dialog).findByRole("tab", { name: "Barcodes & labels" }));
    expect(within(dialog).getByText("5901234123457")).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/^Barcode \(type it/), "4006381333931");
    await user.click(within(dialog).getByRole("button", { name: /Register|Add barcode/ }));
    await within(dialog).findByText("4006381333931", { selector: "span.font-mono" });
    expect(writes()).toEqual([{ url: `/api/products/${P1}/identifiers`, method: "POST", body: { kind: "manufacturer", value: "4006381333931", label: "" } }]);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("explains a failure instead of showing a broken dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { error: "Product not found." })));
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Edit Steel bolt" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Product not found.");
  });
});

describe("the Delete icon (always asks first)", () => {
  // jsdom has no <dialog>.showModal, so the confirmation falls back to window.confirm (the same question, asked the same way)
  const answer = (yes: boolean) => { const confirm = vi.fn(() => yes); vi.stubGlobal("confirm", confirm); return confirm; };

  it("asks before anything happens, and saying no changes nothing", async () => {
    const confirm = answer(false);
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Delete Steel bolt" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toContain("Nothing is erased");
    expect(writes()).toEqual([]);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("after the confirmation the product is archived (nothing is erased), the page re-reads its figures and says so", async () => {
    answer(true);
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Delete Steel bolt" }));
    await waitFor(() => expect(writes()).toEqual([{ url: `/api/products/${P1}/archive`, method: "POST", body: undefined }]));
    expect((await screen.findByRole("status")).textContent).toContain("Steel bolt was deleted");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("a refusal from the service is shown and the row stays", async () => {
    answer(true);
    vi.stubGlobal("fetch", vi.fn(async () => json(409, { error: "This product still has stock reserved for customer orders." })));
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Delete Steel bolt" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This product still has stock reserved for customer orders.");
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete Steel bolt" })).toBeTruthy();
  });

  it("an archived (already deleted) product cannot be deleted again, but can still be edited and restored", () => {
    mount([row({ is_active: false })]);
    expect((screen.getByRole("button", { name: "Delete Steel bolt" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Edit Steel bolt" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("has a tooltip on each icon", async () => {
    const user = userEvent.setup();
    mount();
    await user.hover(screen.getByRole("button", { name: "Edit Steel bolt" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Edit");
  });
});
