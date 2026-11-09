// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import OrderDetail from "@/app/purchase-orders/[id]/order-detail";

// Buying: choose a product for a purchase order by SKU / barcode, by searching its name, or by registering it right there ("Add New Product"). Whichever way,
// the same form takes the quantity and the purchase price. Registering a product, and ordering it, never put anything in stock.

const now = "2026-11-09T10:00:00+00:00";
const O1 = "a0000000-0000-4000-8000-000000000001";
const S1 = "c0000000-0000-4000-8000-000000000001";
const BOLT = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const NEW = "9e1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";

const product = (id: string, sku: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, sku, name, description: null, unit: "pcs", unit_allows_fractions: false, unit_locked: false, hs_code: null, cost_price: "1.2500", selling_price: "2.5000", currency_code: "USD",
  is_active: true, created_at: now, updated_at: now, ...extra,
});
const order = (extra: Record<string, unknown> = {}) => ({
  id: O1, number: "PO-000001", supplier: { id: S1, name: "Acme Supplies", code: null, is_active: true }, supplier_reference: null, order_date: "2026-11-09", expected_delivery_date: null,
  currency_code: "USD", notes: null, status: "draft", line_count: 0, total_amount: "0.0000", created_by_email: "a@b.c", ordered_at: null, ordered_by_email: null,
  cancelled_at: null, cancelled_by_email: null, created_at: now, updated_at: now, lines: [], frozen: false,
  stock_notice: "A purchase order does not change your stock.", ...extra,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; body: any };
let calls: Call[];
let handlers: Record<string, (body: any) => Response>;

beforeEach(() => {
  calls = [];
  handlers = {};
  Object.values(router).forEach((fn) => fn.mockReset());
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const key = `${method} ${url.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")}`;
    if (handlers[key]) return handlers[key](body);
    if (method === "GET" && url.startsWith("/api/products?")) {
      const q = new URL(url, "http://x").searchParams.get("q")!.toLowerCase();
      const items = [product(BOLT, "BOLT-1", "Steel bolt"), product("7a1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6", "NUT-1", "Steel nut")].filter((p) => `${p.sku} ${p.name}`.toLowerCase().includes(q));
      return json(200, { items, total: items.length });
    }
    if (method === "POST" && url === "/api/products") return json(201, { product: product(NEW, body.sku, body.name, { cost_price: body.costPrice, selling_price: body.sellingPrice, currency_code: body.currencyCode, unit: body.unit }) });
    if (method === "POST" && /\/identifiers$/.test(url)) return json(201, { identifier: { id: "i1", kind: body.kind, value: body.value } });
    if (method === "POST" && /\/lines$/.test(url)) return json(201, { line: { id: "l1" }, line_count: 1, total_amount: "25.0000", currency_code: "USD" });
    return json(404, { error: "not found" });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const writes = () => calls.filter((c) => c.method !== "GET");
const stockCalls = () => calls.filter((c) => /\/api\/stock|\/movements|goods-receipts/.test(c.url));
async function open(user: ReturnType<typeof userEvent.setup>, props: Record<string, unknown> = {}) {
  render(<OrderDetail order={order(props) as any} suppliers={[] as any} />);
  await user.click(screen.getByRole("button", { name: /Find a product/ }));
}
const fillNewProduct = async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, over: Record<string, string> = {}) => {
  const v = { sku: "washer-1", name: "Washer M10", unit: "pcs", cost: "0.05", selling: "0.1", barcode: "", ...over };
  await user.type(within(dialog).getByLabelText("SKU or product code"), v.sku);
  await user.type(within(dialog).getByLabelText("Product name"), v.name);
  await user.type(within(dialog).getByLabelText("Unit of measurement"), v.unit);
  await user.type(within(dialog).getByLabelText("Cost price"), v.cost);
  await user.type(within(dialog).getByLabelText("Selling price"), v.selling);
  if (v.barcode) await user.type(within(dialog).getByLabelText(/^Barcode/), v.barcode);
};

describe("choosing an existing product by name", () => {
  it("searches the catalog while typing, lists the matches, and adds the chosen product with a quantity and a purchase price", async () => {
    const user = userEvent.setup();
    await open(user);
    await user.type(screen.getByLabelText("Search products by name"), "steel");
    const list = await screen.findByRole("list", { name: "Matching products" });
    expect(within(list).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Choose Steel bolt (BOLT-1)", "Choose Steel nut (NUT-1)"]);
    await user.click(within(list).getByRole("button", { name: "Choose Steel bolt (BOLT-1)" }));
    const form = await screen.findByRole("form", { name: "Add Steel bolt to PO-000001" });
    expect((within(form).getByLabelText(/^Unit purchase price/) as HTMLInputElement).value).toBe("1.25"); // the product's cost price, as a starting point
    await user.type(within(form).getByLabelText(/^Quantity to order/), "500");
    await user.click(within(form).getByRole("button", { name: "Add to order" }));
    await screen.findByText("Added 500 pcs of Steel bolt to PO-000001.");
    expect(writes()).toEqual([{ url: `/api/purchasing/purchase-orders/${O1}/lines`, method: "POST", body: { productId: BOLT, quantity: "500", unitPrice: "1.25", notes: "" } }]);
    expect(stockCalls()).toEqual([]); // ordering changes no stock
  });

  it("says so when nothing matches, and offers to register the product", async () => {
    const user = userEvent.setup();
    await open(user);
    await user.type(screen.getByLabelText("Search products by name"), "zzz");
    expect(await screen.findByText(/No active product matches “zzz”/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add New Product" }));
    const dialog = await screen.findByRole("dialog", { name: "Add New Product" });
    expect((within(dialog).getByLabelText("Product name") as HTMLInputElement).value).toBe("zzz"); // what was searched for is carried over
  });
});

describe("Add New Product inside the product selector", () => {
  it("registers the product (in the order's currency, with its barcode), then carries straight on to the quantity and the purchase price; no stock is added", async () => {
    const user = userEvent.setup();
    await open(user, { currency_code: "EUR" });
    await user.click(screen.getByRole("button", { name: "Add New Product" }));
    const dialog = await screen.findByRole("dialog", { name: "Add New Product" });
    expect(dialog.textContent).toContain("does not add stock");
    expect((within(dialog).getByLabelText("Currency") as HTMLInputElement).value).toBe("EUR");
    await fillNewProduct(user, dialog, { barcode: "5901234123457" });
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));

    const form = await screen.findByRole("form", { name: "Add Washer M10 to PO-000001" });
    expect(screen.getByRole("status").textContent).toContain("Added Washer M10 (WASHER-1).");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes().slice(0, 2)).toEqual([
      { url: "/api/products", method: "POST", body: { sku: "WASHER-1", name: "Washer M10", description: "", unit: "pcs", hsCode: "", costPrice: "0.05", sellingPrice: "0.1", currencyCode: "EUR" } },
      { url: `/api/products/${NEW}/identifiers`, method: "POST", body: { kind: "manufacturer", value: "5901234123457" } },
    ]);

    // the purchase price: its own number, separate from the product's cost and selling prices
    const price = within(form).getByLabelText(/^Unit purchase price/) as HTMLInputElement;
    expect(price.value).toBe("0.05");
    await user.clear(price);
    await user.type(price, "0.04");
    await user.type(within(form).getByLabelText(/^Quantity to order/), "500");
    expect(within(form).getByTestId("line-preview").textContent).toContain("20.00 EUR");
    await user.click(within(form).getByRole("button", { name: "Add to order" }));
    await screen.findByText("Added 500 pcs of Washer M10 to PO-000001.");
    expect(writes()[2]).toEqual({ url: `/api/purchasing/purchase-orders/${O1}/lines`, method: "POST", body: { productId: NEW, quantity: "500", unitPrice: "0.04", notes: "" } });
    expect(writes()).toHaveLength(3);
    expect(stockCalls()).toEqual([]); // registering and ordering never touch stock: only a confirmed goods receipt does
    expect(router.refresh).toHaveBeenCalled();
  });

  it("works without a barcode (it is optional)", async () => {
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Add New Product" }));
    const dialog = await screen.findByRole("dialog", { name: "Add New Product" });
    await fillNewProduct(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));
    await screen.findByRole("form", { name: "Add Washer M10 to PO-000001" });
    expect(writes().map((c) => c.url)).toEqual(["/api/products"]);
  });

  it("refuses a duplicate SKU on the form and registers nothing else", async () => {
    handlers["POST /api/products"] = () => json(409, { error: "A product with SKU 'WASHER-1' already exists in your catalog.", fieldErrors: { sku: "A product with SKU 'WASHER-1' already exists in your catalog." } });
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Add New Product" }));
    const dialog = await screen.findByRole("dialog", { name: "Add New Product" });
    await fillNewProduct(user, dialog, { barcode: "5901234123457" });
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));
    expect((await within(dialog).findAllByText(/already exists in your catalog/)).length).toBeGreaterThan(0);
    expect(writes().map((c) => c.url)).toEqual(["/api/products"]); // no barcode registered, no line added
    expect(screen.queryByRole("form", { name: /^Add Washer/ })).toBeNull();
  });

  it("keeps the new product when its barcode already identifies another one, and says so", async () => {
    handlers[`POST /api/products/:id/identifiers`] = () => json(409, { error: "This barcode already identifies another product." });
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Add New Product" }));
    const dialog = await screen.findByRole("dialog", { name: "Add New Product" });
    await fillNewProduct(user, dialog, { barcode: "5901234123457" });
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));
    await screen.findByRole("form", { name: "Add Washer M10 to PO-000001" });
    expect(screen.getByRole("status").textContent).toContain("The barcode was not registered: This barcode already identifies another product.");
  });

  it("checks the barcode before creating anything", async () => {
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Add New Product" }));
    const dialog = await screen.findByRole("dialog", { name: "Add New Product" });
    await fillNewProduct(user, dialog, { barcode: "https://evil.example/x" });
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));
    expect(await within(dialog).findByText(/web link, not a product code/)).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it("is only offered while the order is a draft: a placed order is frozen", () => {
    render(<OrderDetail order={order({ status: "ordered", frozen: true }) as any} suppliers={[] as any} />);
    expect(screen.queryByRole("button", { name: "Add New Product" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Find a product/ })).toBeNull();
  });
});
