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

describe("the Stock page shows the product inventory", () => {
  it("lists name, SKU, unit, on hand, reserved, available, cost, price and status for each product", () => {
    mount([row(), row({ product_id: P2, sku: "NUT-1", name: "Steel nut", is_active: false, total_quantity: "0.0000", reserved_quantity: "0.0000", available_quantity: "0.0000", cost_price: "0.1000", selling_price: "0.2000" })]);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Product", "Unit", "On hand", "Reserved", "Available", "Cost", "Price", "Status", "Actions"]);
    const [bolt, nut] = within(table).getAllByRole("row").slice(1);
    expect(within(bolt).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Steel boltBOLT-1", "pcs", "500", "400", "100", "1.25 USD", "2.50 USD", "Active", expect.stringContaining("Details")]);
    expect(within(nut).getByText("Archived")).toBeTruthy();
    expect(within(nut).getAllByRole("cell")[5].textContent).toBe("0.10 USD");
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
  it("opens from Details with the product's information, and has no quantity field: stock is changed only by the stock forms", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Details: Steel bolt" }));
    const dialog = await screen.findByRole("dialog", { name: "Steel bolt" });
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
    await user.click(screen.getByRole("button", { name: "Details: Steel bolt" }));
    const dialog = await screen.findByRole("dialog", { name: "Steel bolt" });
    await user.click(await within(dialog).findByRole("button", { name: "Edit product" }));
    const form = within(dialog).getByRole("form", { name: "Edit product" });
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
    await user.click(screen.getByRole("button", { name: "Details: Steel bolt" }));
    const dialog = await screen.findByRole("dialog", { name: "Steel bolt" });
    expect(await within(dialog).findByText(/Locked: this product already has stock movements/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Edit product" }));
    expect((within(dialog).getByLabelText("Unit of measurement") as HTMLInputElement).disabled).toBe(true);
  });

  it("archives (after a confirmation) and restores a product; nothing is erased", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Details: Steel bolt" }));
    const dialog = await screen.findByRole("dialog", { name: "Steel bolt" });
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
    await user.click(screen.getByRole("button", { name: "Details: Steel bolt" }));
    const dialog = await screen.findByRole("dialog", { name: "Steel bolt" });
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
    await user.click(screen.getByRole("button", { name: "Details: Steel bolt" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Product not found.");
  });
});
