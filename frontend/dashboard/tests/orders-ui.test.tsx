// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import DeliveryBoard from "@/app/delivery-lists/delivery-board";
import CreateOrderForm from "@/app/sales-orders/new/create-order-form";
import { keyFor, normalizeName, orderLines, rowErrors, rowFromProduct, signatureOf, validateRow } from "@/lib/order-form";

const now = "2026-11-09T10:00:00+00:00";
const WATER = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const FLOUR = "7a1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const C1 = "c0000000-0000-4000-8000-000000000001";
const O1 = "d0000000-0000-4000-8000-000000000001";
const O2 = "d0000000-0000-4000-8000-000000000002";
const L1 = "a0000000-0000-4000-8000-000000000001";
const L2 = "a0000000-0000-4000-8000-000000000002";

const clients = [
  { id: C1, name: "Acme Ltd", contact_person: "Jane", email: "jane@acme.example", phone: null, address: null, is_active: true, created_at: now, updated_at: now },
  { id: "c2", name: "Beta Trading", contact_person: null, email: null, phone: null, address: null, is_active: true, created_at: now, updated_at: now },
];
const PRODUCTS = [
  { product_id: WATER, sku: "WATER", name: "Water bottle", unit: "pcs", unit_allows_fractions: false, is_active: true, total_quantity: "500.0000", reserved_quantity: "400.0000", available_quantity: "100.0000" },
  { product_id: FLOUR, sku: "FLOUR", name: "Flour", unit: "kg", unit_allows_fractions: true, is_active: true, total_quantity: "20.0000", reserved_quantity: "0.0000", available_quantity: "20.0000" },
];

const summary = (id: string, number: string, list: string, listNumber: string, extra: Record<string, unknown> = {}) => ({
  id, number, client: { id: C1, name: "Acme Ltd", is_active: true }, delivery_list: { id: list, number: listNumber, status: "ready" }, status: "active", reservation_status: "reserved",
  origin: "order", version: 1, product_count: 2, total_amount: "1250.0000", currency_code: "USD", created_by_email: "a@b.c", created_at: now, updated_at: now, completed_at: null, cancelled_at: null, history_expires_at: null,
  pending_action: null, last_error: null, notes: null, ...extra,
});
const detail = (extra: Record<string, unknown> = {}) => ({
  ...summary(O1, "SO-000001", L1, "DL-000001"),
  prices_recorded: true,
  lines: [
    { id: "l1", product_id: WATER, product_sku: "WATER", product_name: "Water bottle", unit: "pcs", unit_allows_fractions: false, ordered_quantity: "400.0000", dispatched_quantity: "150.0000", pending_quantity: "0.0000", remaining_quantity: "250.0000", unit_price: "3.0000", line_total: "1200.0000",
      stock: { total_quantity: "350.0000", reserved_quantity: "250.0000", available_quantity: "100.0000", reserved_for_order: "250.0000", product_active: true } },
    { id: "l2", product_id: FLOUR, product_sku: "FLOUR", product_name: "Flour", unit: "kg", unit_allows_fractions: true, ordered_quantity: "5.0000", dispatched_quantity: "0.0000", pending_quantity: "0.0000", remaining_quantity: "5.0000", unit_price: "10.0000", line_total: "50.0000",
      stock: { total_quantity: "20.0000", reserved_quantity: "5.0000", available_quantity: "15.0000", reserved_for_order: "5.0000", product_active: true } },
  ],
  stock_status: "ok", dispatches: [], can_edit: true, edit_blocked_reason: null, can_cancel: false, can_cancel_remaining: true, cancel_blocked_reason: "Goods were already dispatched", can_dispatch: true, message: null, ...extra,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; body: any; headers: Record<string, string> };
let calls: Call[];
let handlers: Record<string, (body: any, init: any) => Response>;

beforeEach(() => {
  calls = [];
  handlers = {};
  Object.values(router).forEach((fn) => fn.mockReset());
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method ?? "GET", body, headers: init.headers ?? {} });
    const key = `${init.method ?? "GET"} ${url.split("?")[0]}`;
    if (handlers[key]) return handlers[key](body, init);
    if (url.startsWith("/api/sales/order-products")) {
      const q = (new URL(url, "http://x").searchParams.get("q") ?? "").toLowerCase();
      const items = PRODUCTS.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
      return json(200, { items, total: items.length, limit: 20, offset: 0 });
    }
    if (url.startsWith("/api/scan/resolve")) {
      const code = (new URL(url, "http://x").searchParams.get("code") ?? "").toUpperCase();
      const stock = PRODUCTS.find((p) => p.sku === code);
      if (!stock) return json(404, { error: "No product" });
      return json(200, { matched_by: "sku", identifier_kind: null, product: { id: stock.product_id, sku: stock.sku, name: stock.name, unit: stock.unit, is_active: stock.is_active }, stock });
    }
    if (url === "/api/sales/clients" && init.method === "POST") return json(201, { client: { id: "c-new", name: body.name, is_active: true, contact_person: null, email: null } });
    if (url === "/api/sales/orders" && init.method === "POST") return json(201, { order: { id: O1, number: "SO-000001" }, pending: false, replayed: false });
    if (url === `/api/sales/orders/${O1}` && (init.method ?? "GET") === "GET") return json(200, { order: detail() });
    return json(404, { error: "not found" });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

// =====================================================================================================================================
describe("the order form's rules (lib/order-form)", () => {
  const row = (q: string, extra: Record<string, unknown> = {}) => ({ ...rowFromProduct(PRODUCTS[0]), quantity: q, ...extra });

  it("takes physical, reserved and available stock from the product", () => {
    const r = rowFromProduct(PRODUCTS[0]);
    expect([r.onHand, r.reserved, r.available, r.min]).toEqual(["500.0000", "400.0000", "100.0000", "0"]);
  });

  it("accepts a quantity up to what is AVAILABLE (not what is on hand) and explains the rest", () => {
    expect(validateRow(row("100"))).toBeUndefined();
    expect(validateRow(row("100.0000"))).toBeUndefined();
    expect(validateRow(row("150"))).toContain("Only 100 pcs available");
    expect(validateRow(row("150"))).toContain("400 reserved for orders");
    expect(validateRow(row("150"))).toContain("500 on hand");
  });

  it("applies the unit rules: whole numbers for pieces, decimals for kilograms, never zero or text", () => {
    expect(validateRow(row("2.5"))).toContain("whole number");
    expect(validateRow({ ...rowFromProduct(PRODUCTS[1]), quantity: "2.5" })).toBeUndefined();
    expect(validateRow(row("0"))).toBeTruthy();
    expect(validateRow(row(""))).toBeTruthy();
    expect(validateRow(row("abc"))).toBeTruthy();
    expect(validateRow(row("1.00001"))).toBeTruthy();
  });

  it("when editing, the limit is what is ordered now plus what is still free, and never below what was dispatched", () => {
    const editing = row("400", { available: "100", max: "500", min: "150" });
    expect(validateRow({ ...editing, quantity: "500" })).toBeUndefined();
    expect(validateRow({ ...editing, quantity: "600" })).toBe("Cannot increase to 600: only 100 more pcs are currently available.");
    expect(validateRow({ ...editing, quantity: "100" })).toContain("150 pcs was already dispatched");
  });

  it("collects the errors per product and sends only ids and exact quantity strings", () => {
    const rows = [row("5"), { ...rowFromProduct(PRODUCTS[1]), quantity: "30" }];
    expect(Object.keys(rowErrors(rows))).toEqual([FLOUR]);
    expect(orderLines(rows)).toEqual([{ productId: WATER, quantity: "5" }, { productId: FLOUR, quantity: "30" }]); // no price typed yet: none is sent (never a zero)
    expect(orderLines([{ ...rows[0], unitPrice: " 120000 " }])).toEqual([{ productId: WATER, quantity: "5", unitPrice: "120000" }]);
    expect(orderLines([{ ...rows[0], unitPrice: "120000" }], false)).toEqual([{ productId: WATER, quantity: "5" }]); // an order without agreed prices sends none
  });

  it("keeps ONE idempotency key per intended order and makes a new one when the order changes", () => {
    const a = keyFor("x", null);
    expect(keyFor("x", a)).toBe(a);
    expect(keyFor("y", a).key).not.toBe(a.key);
    expect(signatureOf("c", [row("5")])).not.toBe(signatureOf("c", [row("6")]));
  });

  it("recognises an existing client regardless of case and spacing", () => {
    expect(normalizeName("  ACME   ltd ")).toBe(normalizeName("Acme Ltd"));
  });
});

// =====================================================================================================================================
describe("Create Order", () => {
  // The client box is a dropdown: clicking it lists the clients, a click on one selects it.
  async function pickClient(user: ReturnType<typeof userEvent.setup>, name: RegExp = /Acme Ltd/) {
    await user.click(screen.getByRole("combobox", { name: "Select client" }));
    await user.click(within(screen.getByRole("listbox", { name: "Matching clients" })).getByRole("button", { name }));
  }
  // The inventory list loads on its own; "Add <product>" is the row's button.
  async function addProduct(user: ReturnType<typeof userEvent.setup>, name: string, quantity?: string) {
    if ((screen.getByRole("combobox", { name: "Select client" }) as HTMLInputElement).value === "") await pickClient(user);
    const button = await screen.findByRole("button", { name: `Add ${name}` });
    if (quantity !== undefined) await user.type(screen.getByLabelText(new RegExp(`^Order quantity of ${name} in`)), quantity);
    await user.click(button);
  }
  const qtyBox = (name: string, unit: string) => screen.getByLabelText(`Order quantity of ${name} in ${unit}`);

  it("shows none of the helper texts the page used to have, and the boxes say 'Select Client' and 'Search product'", async () => {
    const user = userEvent.setup();
    const { container } = render(<CreateOrderForm clients={clients as any} />);
    await screen.findByRole("table", { name: "Inventory" });
    await user.click(screen.getByRole("combobox", { name: "Select client" }));
    const text = container.textContent ?? "";
    for (const gone of [
      "Add the products the client needs", "Saving the order reserves these quantities at once", "is the physical stock",
      "No clients yet: type a name to register the first one.", "Search your registered clients, or register a new one", "A client that already exists is never created twice",
      "Search products", "Client name",
    ]) expect(text, gone).not.toContain(gone);
    expect((screen.getByRole("combobox", { name: "Select client" }) as HTMLInputElement).placeholder).toBe("Select Client");
    expect((screen.getByRole("searchbox", { name: "Search products" }) as HTMLInputElement).placeholder).toBe("Search product");
  });

  it("the client box opens a dropdown wherever you click, narrows it as you type, and selects the one you pick", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    const box = screen.getByRole("combobox", { name: "Select client" }) as HTMLInputElement;
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(box);
    const all = within(screen.getByRole("listbox", { name: "Matching clients" }));
    expect(all.getAllByRole("button").map((b) => b.textContent)).toEqual(["Acme Ltdjane@acme.example", "Beta Trading"]);
    await user.type(box, "bet");
    // only Beta Trading matches; the second row is the offer to register "bet" as a new client
    expect(within(screen.getByRole("listbox")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Beta Trading", "+ Register “bet” as a new client"]);
    await user.click(within(screen.getByRole("listbox")).getByRole("button", { name: /Beta Trading/ }));
    expect(box.value).toBe("Beta Trading");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(box); // clicking again lists everyone again, with the chosen one marked
    expect(within(screen.getByRole("listbox")).getAllByRole("button")).toHaveLength(2);
    expect(within(screen.getByRole("listbox")).getByText("Beta Trading").closest("li")!.getAttribute("aria-selected")).toBe("true");
  });

  it("typing something else un-selects the client, and Enter in the client box picks the highlighted one without saving the order", async () => {
    const user = userEvent.setup();
    handlers["POST /api/sales/orders"] = () => json(201, { order: { id: O1, number: "SO-000001" } });
    render(<CreateOrderForm clients={clients as any} />);
    const box = screen.getByRole("combobox", { name: "Select client" }) as HTMLInputElement;
    await user.type(box, "acme{Enter}");
    expect(box.value).toBe("Acme Ltd");
    expect(calls.some((c) => c.url === "/api/sales/orders")).toBe(false);
    await user.type(box, "x");
    expect((screen.getByRole("button", { name: "Checkout" }) as HTMLButtonElement).disabled).toBe(true); // "Acme Ltdx" is not a selected client
  });

  it("offers to register a NEW client inside the dropdown, but never one that already exists", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    const box = screen.getByRole("combobox", { name: "Select client" }) as HTMLInputElement;
    await user.type(box, "acme  LTD");
    expect(screen.queryByRole("button", { name: /Register/ })).toBeNull();
    await user.clear(box);
    await user.type(box, "Fresh Customer GmbH");
    await user.click(screen.getByRole("button", { name: /Register “Fresh Customer GmbH” as a new client/ }));
    await waitFor(() => expect(box.value).toBe("Fresh Customer GmbH"));
    expect(calls.find((c) => c.url === "/api/sales/clients")!.body).toEqual({ name: "Fresh Customer GmbH" });
    await user.click(screen.getByRole("combobox", { name: "Select client" }));
    expect(within(screen.getByRole("listbox")).getAllByRole("button").map((b) => b.textContent)).toContain("Fresh Customer GmbH"); // it is a client now
  });

  it("the quantity boxes are minus / number / plus selectors that start at zero and jump by 10, and the number can still be typed", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    await addProduct(user, "Flour");
    const box = qtyBox("Flour", "kg") as HTMLInputElement;
    expect(box.value).toBe("");
    expect(box.placeholder).toBe("0");
    const minus = screen.getByRole("button", { name: "Decrease order quantity of Flour in kg" }) as HTMLButtonElement;
    const plus = screen.getByRole("button", { name: "Increase order quantity of Flour in kg" });
    expect(minus.disabled).toBe(true); // nothing to take away at zero
    await user.click(plus);
    expect(box.value).toBe("10");
    await user.click(plus);
    expect(box.value).toBe("20");
    await user.click(minus);
    expect(box.value).toBe("10");
    await user.click(minus);
    await user.click(minus); // never below zero
    expect(box.value).toBe("0");
    await user.type(box, "{backspace}2.5");
    expect(box.value).toBe("2.5");
    await user.click(plus);
    expect(box.value).toBe("12.5"); // exact decimals
    await user.clear(box);
    await user.type(box, "40");
    expect(box.value).toBe("40");
    expect(box.closest(".ix-qty")!.className).not.toMatch(/bg-/); // no fill of its own: it sits on the page background
  });

  it("Step 1 is ONE form: the client first, then Scan Product and the search bar, then the inventory, then ONLY Cancel and Checkout (no View List, no Save Order)", async () => {
    render(<CreateOrderForm clients={clients as any} />);
    expect(screen.getAllByRole("form")).toHaveLength(1);
    const form = screen.getByRole("form", { name: "Create order" });
    expect(screen.queryByRole("button", { name: /View List/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Order" })).toBeNull();
    const order = [form.querySelector("#client-heading")!, screen.getByRole("button", { name: /Scan Product/ }), screen.getByRole("searchbox", { name: "Search products" }), await screen.findByRole("table", { name: "Inventory" }), screen.getByRole("link", { name: "Cancel" }), screen.getByRole("button", { name: "Checkout" })];
    order.slice(1).forEach((el, i) => expect(!!(order[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING), `${i}`).toBe(true));
  });

  it("opens with the organization's inventory listed in the Products-tab layout, with stock figures and an Add and a Drop button per row", async () => {
    render(<CreateOrderForm clients={clients as any} />);
    const table = await screen.findByRole("table", { name: "Inventory" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Product", "Unit", "On hand", "Booked", "Available", "Quantity", "Actions"]);
    const row = within(table).getByText("Water bottle").closest("tr")! as HTMLElement;
    expect(row.textContent).toContain("WATER");
    expect(row.textContent).not.toContain("Drinks"); // products have no category
    expect(row.textContent).toContain("500"); // on hand
    expect(row.textContent).toContain("400"); // booked
    expect(row.textContent).toContain("100"); // available
    expect(within(row).getAllByRole("button").map((b) => b.textContent).filter(Boolean)).toEqual(["Add", "Drop"]); // (the quantity selector's - and + have icons, no text)
    expect((within(row).getByRole("button", { name: "Drop Water bottle" }) as HTMLButtonElement).disabled).toBe(true); // nothing to drop yet
  });

  it("no product can be added or given a quantity until a client is selected", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    const add = (await screen.findByRole("button", { name: "Add Water bottle" })) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title).toBe("Select a client first");
    expect((qtyBox("Water bottle", "pcs") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Increase order quantity of Water bottle in pcs" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(add);
    expect((screen.getByRole("button", { name: "Checkout" }) as HTMLButtonElement).disabled).toBe(true); // nothing was added
    await user.type(screen.getByRole("searchbox", { name: "Search products" }), "flo"); // the inventory can still be searched
    expect(await screen.findByRole("button", { name: "Add Flour" })).toBeTruthy();
    await user.clear(screen.getByRole("searchbox", { name: "Search products" }));
    await pickClient(user);
    await waitFor(() => expect((screen.getByRole("button", { name: "Add Water bottle" }) as HTMLButtonElement).disabled).toBe(false));
    expect((qtyBox("Water bottle", "pcs") as HTMLInputElement).disabled).toBe(false);
  });

  it("searches the inventory", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    await screen.findByRole("button", { name: "Add Flour" });
    await user.type(screen.getByRole("searchbox", { name: "Search products" }), "flo");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add Water bottle" })).toBeNull());
    expect(screen.getByRole("button", { name: "Add Flour" })).toBeTruthy();
    expect(calls.some((c) => c.url.includes("q=flo"))).toBe(true);
    await user.clear(screen.getByRole("searchbox", { name: "Search products" }));
    await user.type(screen.getByRole("searchbox", { name: "Search products" }), "zzz");
    expect(await screen.findByText("No active products match your search.")).toBeTruthy();
  });

  it("Enter in the search bar or a quantity box does not save the order", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    await pickClient(user);
    await addProduct(user, "Water bottle", "5");
    await user.type(screen.getByRole("searchbox", { name: "Search products" }), "water{Enter}");
    await user.type(qtyBox("Water bottle", "pcs"), "{Enter}");
    expect(calls.some((c) => c.url === "/api/sales/orders")).toBe(false);
  });

  it("Add puts the product on the order (keeping a quantity typed first), refuses it twice, and Drop takes it off", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    await addProduct(user, "Water bottle", "40");
    const add = screen.getByRole("button", { name: "Add Water bottle" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.textContent).toBe("Added");
    expect((qtyBox("Water bottle", "pcs") as HTMLInputElement).value).toBe("40");
    expect((screen.getByRole("button", { name: "Checkout" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Drop Water bottle" }));
    expect((screen.getByRole("button", { name: "Add Water bottle" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Checkout" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Checkout stays off until a client is chosen AND at least one product has a valid quantity", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    const checkout = () => screen.getByRole("button", { name: "Checkout" }) as HTMLButtonElement;
    expect(checkout().disabled).toBe(true); // nothing at all
    await pickClient(user);
    expect(checkout().disabled).toBe(true); // a client but no product
    await addProduct(user, "Water bottle");
    expect(checkout().disabled).toBe(true); // a product without a quantity
    await user.type(screen.getByLabelText("Order quantity of Water bottle in pcs"), "40");
    expect(checkout().disabled).toBe(false);
    await user.clear(screen.getByLabelText("Order quantity of Water bottle in pcs"));
    await user.type(screen.getByLabelText("Order quantity of Water bottle in pcs"), "150"); // more than is available
    expect(checkout().disabled).toBe(true);
  });

  it("Cancel is the neutral secondary button (not red) and returns to Delivery Lists; Checkout is the primary accent button", () => {
    render(<CreateOrderForm clients={clients as any} />);
    const cancel = screen.getByRole("link", { name: "Cancel" });
    expect(cancel.getAttribute("href")).toBe("/delivery-lists");
    expect(cancel.className).toContain("bg-ix-mist/5");
    expect(cancel.className).not.toMatch(/red|destructive/);
    const checkout = screen.getByRole("button", { name: "Checkout" });
    expect(checkout.className).toContain("bg-ix-butter"); // the user's accent, never a hard-coded colour
    expect(checkout.className).not.toMatch(/indigo|yellow|amber/);
  });

  it("starts the order in the organization's default currency, which can be chosen from every currency; it is sent with the order", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} defaultCurrency="PKR" />);
    const select = screen.getByLabelText("Order currency") as HTMLSelectElement;
    expect(select.value).toBe("PKR");
    expect(within(select).getAllByRole("option").length).toBeGreaterThan(140);
    await user.selectOptions(select, "EUR");
    expect(select.value).toBe("EUR");
  });

  describe("Scan Products", () => {
    const openScan = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole("button", { name: /Scan Product/ }));
      return screen.findByRole("dialog");
    };

    it("finds a product from a scanned or typed code and shows it in the inventory list, ready to add", async () => {
      const user = userEvent.setup();
      render(<CreateOrderForm clients={clients as any} />);
      await screen.findByRole("button", { name: "Add Flour" });
      const dialog = await openScan(user);
      await user.type(within(dialog).getByLabelText(/Scan or type/), "flour{Enter}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(calls.some((c) => c.url === "/api/scan/resolve?code=FLOUR")).toBe(true);
      expect(screen.getByRole("status").textContent).toContain("Flour");
      expect(screen.queryByRole("button", { name: "Add Water bottle" })).toBeNull(); // only the scanned product is shown
      expect((screen.getByRole("button", { name: "Add Flour" }) as HTMLButtonElement).disabled).toBe(true); // still no client
      await pickClient(user);
      await user.click(screen.getByRole("button", { name: "Add Flour" }));
      expect((screen.getByRole("button", { name: "Add Flour" }) as HTMLButtonElement).textContent).toBe("Added");
      await user.click(screen.getByRole("button", { name: "Show all products" }));
      expect(await screen.findByRole("button", { name: "Add Water bottle" })).toBeTruthy();
      expect(calls.some((c) => c.url === "/api/sales/orders")).toBe(false); // a scanner's Enter never saves the order
    });

    it("says plainly when no product has that code, and changes nothing", async () => {
      const user = userEvent.setup();
      render(<CreateOrderForm clients={clients as any} />);
      await screen.findByRole("button", { name: "Add Flour" });
      const dialog = await openScan(user);
      await user.type(within(dialog).getByLabelText(/Scan or type/), "NOPE{Enter}");
      expect((await within(dialog).findByRole("alert")).textContent).toContain("No product in your catalog matches this code.");
      expect(screen.getByRole("dialog")).toBeTruthy();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByRole("button", { name: "Add Water bottle" })).toBeTruthy(); // the list is untouched
    });

    it("offers the camera too (it only starts when asked)", async () => {
      const user = userEvent.setup();
      render(<CreateOrderForm clients={clients as any} />);
      const dialog = await openScan(user);
      await user.click(within(dialog).getByRole("button", { name: "Use the camera" }));
      expect(within(dialog).getByRole("region", { name: "Camera scanner" })).toBeTruthy();
      expect(within(dialog).getByRole("button", { name: "Start camera" })).toBeTruthy();
    });
  });

  it("shows how much is available when more is asked for, beside the quantity, and Checkout stays off", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    await pickClient(user);
    await addProduct(user, "Water bottle");
    await user.type(screen.getByLabelText("Order quantity of Water bottle in pcs"), "150");
    expect((await screen.findAllByRole("alert")).map((a) => a.textContent).join(" ")).toContain("Only 100 pcs available");
    expect((screen.getByRole("button", { name: "Checkout" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.url === "/api/sales/orders")).toBe(false);
  });

  // ---- Step 2: Order Checkout --------------------------------------------------------------------------------------------------------------------
  async function toCheckout(user: ReturnType<typeof userEvent.setup>, lines: [string, string][] = [["Water bottle", "40"], ["Flour", "2.5"]], props: Record<string, unknown> = {}) {
    render(<CreateOrderForm clients={clients as any} {...props} />);
    await pickClient(user);
    for (const [name] of lines) await screen.findByRole("button", { name: `Add ${name}` });
    for (const [name, quantity] of lines) await addProduct(user, name, quantity);
    await user.click(screen.getByRole("button", { name: "Checkout" }));
    await screen.findByRole("heading", { name: "Order Checkout" });
  }
  const priceBox = (name: string, currency = "USD") => screen.getByLabelText(`Per piece price of ${name} in ${currency}`) as HTMLInputElement;
  const saveButton = () => screen.getByRole("button", { name: "Save Order" }) as HTMLButtonElement;
  const priceAll = async (user: ReturnType<typeof userEvent.setup>, prices: Record<string, string>) => { for (const [name, price] of Object.entries(prices)) await user.type(priceBox(name), price); };

  describe("Checkout", () => {
    it("Checkout creates nothing: no order is saved, nothing is reserved, no request is made", async () => {
      const user = userEvent.setup();
      await toCheckout(user);
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
      expect(router.push).not.toHaveBeenCalled();
    });

    it("shows 'Order Checkout', its subtitle and the client's name, with the selected products and quantities", async () => {
      const user = userEvent.setup();
      await toCheckout(user);
      expect(screen.getByText("Review your selected products and enter the selling price for each item.")).toBeTruthy();
      expect(screen.getByTestId("checkout-client").textContent).toBe("Acme Ltd");
      const table = screen.getByRole("table");
      expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Product", "SKU", "Quantity", "Unit", "Per Piece Price", "Line Total"]);
      const rows = within(table).getAllByRole("row").slice(1);
      expect(rows).toHaveLength(2);
      expect(rows[0].textContent).toContain("Water bottle");
      expect(screen.getByTestId("qty-WATER").textContent).toBe("40");
      expect(screen.getByTestId("qty-FLOUR").textContent).toBe("2.5");
      expect(rows[0].textContent).toContain("pcs");
      expect(rows[1].textContent).toContain("kg");
    });

    it("the ONLY editable things are the per piece price fields: no quantity box, no remove button, no product search, no client box", async () => {
      const user = userEvent.setup();
      await toCheckout(user);
      const inputs = [...document.querySelectorAll("input, select, textarea")] as HTMLInputElement[];
      expect(inputs.map((i) => i.getAttribute("aria-label"))).toEqual(["Per piece price of Water bottle in USD", "Per piece price of Flour in USD"]);
      expect(screen.queryByRole("combobox")).toBeNull();
      expect(screen.queryByRole("searchbox")).toBeNull();
      expect(screen.queryByLabelText(/Order quantity|Quantity of/)).toBeNull();
      expect(screen.queryByRole("button", { name: /Remove|Drop|Add |Increase|Decrease/ })).toBeNull();
      expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Back to Products", "Save Order"]);
    });

    it("Save Order is off until EVERY product has a valid price (one price is not enough), and on once the last one is entered", async () => {
      const user = userEvent.setup();
      await toCheckout(user, [["Water bottle", "20"], ["Flour", "10"]]);
      expect(saveButton().disabled).toBe(true);
      await user.type(priceBox("Water bottle"), "120000");
      expect(saveButton().disabled).toBe(true); // Flour has no price yet
      await user.type(priceBox("Flour"), "35000");
      expect(saveButton().disabled).toBe(false);
      await user.clear(priceBox("Flour"));
      expect(saveButton().disabled).toBe(true); // an empty price is "not entered", never zero
    });

    it("an empty price is never zero, but an explicitly typed zero is a price", async () => {
      const user = userEvent.setup();
      await toCheckout(user, [["Water bottle", "5"]]);
      expect(saveButton().disabled).toBe(true);
      expect(screen.getByTestId("order-total").textContent).toBe("—");
      await user.type(priceBox("Water bottle"), "0");
      expect(saveButton().disabled).toBe(false);
      expect(screen.getByTestId("order-total").textContent).toBe("0.00 USD");
    });

    it.each([
      ["-5", "A price cannot be negative."],
      ["abc", "Enter a number such as 120000 or 49.99."],
      ["1,5", "Enter a number such as 120000 or 49.99."],
      ["1e3", "Enter a number such as 120000 or 49.99."],
      ["12.34567", "Use at most 4 decimal places."],
      ["123456789012345", "That price is too large."],
    ])("the price %j is refused beside its field and Save Order stays off", async (typed, message) => {
      const user = userEvent.setup();
      await toCheckout(user, [["Water bottle", "5"]]);
      await user.type(priceBox("Water bottle"), typed);
      expect((await screen.findByRole("alert")).textContent).toBe(message);
      expect(priceBox("Water bottle").getAttribute("aria-invalid")).toBe("true");
      expect(saveButton().disabled).toBe(true);
    });

    it("accepts up to 14 whole digits and 4 decimals", async () => {
      const user = userEvent.setup();
      await toCheckout(user, [["Water bottle", "1"]]);
      await user.type(priceBox("Water bottle"), "99999999999999.9999");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(saveButton().disabled).toBe(false);
    });

    it("an empty price is pointed at once the field was left, with the instruction to enter it", async () => {
      const user = userEvent.setup();
      await toCheckout(user, [["Water bottle", "5"], ["Flour", "1"]]);
      await user.click(priceBox("Water bottle"));
      await user.tab();
      expect((await screen.findByRole("alert")).textContent).toBe("Enter the price per pcs.");
      expect(screen.getByRole("status").textContent).toContain("Enter the price per piece for every product");
    });

    it("line totals and the order total follow every keystroke, in exact decimals with the currency (20 x 120,000 + 10 x 35,000 = 2,750,000)", async () => {
      const user = userEvent.setup();
      await toCheckout(user, [["Water bottle", "20"], ["Flour", "10"]], { defaultCurrency: "PKR" });
      await user.type(screen.getByLabelText("Per piece price of Water bottle in PKR"), "120000");
      expect(screen.getByTestId("line-WATER").textContent).toBe("2,400,000.00 PKR");
      expect(screen.getByTestId("order-total").textContent).toBe("—"); // one line is still unpriced: no half total
      await user.type(screen.getByLabelText("Per piece price of Flour in PKR"), "35000");
      expect(screen.getByTestId("line-FLOUR").textContent).toBe("350,000.00 PKR");
      expect(screen.getByTestId("order-total").textContent).toBe("2,750,000.00 PKR");
      await user.clear(screen.getByLabelText("Per piece price of Flour in PKR"));
      await user.type(screen.getByLabelText("Per piece price of Flour in PKR"), "34999.99");
      expect(screen.getByTestId("order-total").textContent).toBe("2,749,999.90 PKR");
    });

    it("never goes through floating point: 3 x 0.1 is exactly 0.30 and 0.3333 x 3 is 0.9999", async () => {
      const user = userEvent.setup();
      await toCheckout(user, [["Water bottle", "3"], ["Flour", "3"]]);
      await user.type(priceBox("Water bottle"), "0.1");
      await user.type(priceBox("Flour"), "0.3333");
      expect(screen.getByTestId("line-WATER").textContent).toBe("0.30 USD");
      expect(screen.getByTestId("line-FLOUR").textContent).toBe("0.9999 USD");
      expect(screen.getByTestId("order-total").textContent).toBe("1.2999 USD");
    });

    it("shows the currency clearly: in the heading badge, beside each price and in every total", async () => {
      const user = userEvent.setup();
      await toCheckout(user, [["Water bottle", "2"]], { defaultCurrency: "EUR" });
      expect(screen.getByTestId("checkout-currency").textContent).toBe("Prices in EUR");
      expect(screen.getByLabelText("Per piece price of Water bottle in EUR").parentElement!.textContent).toContain("EUR");
      await user.type(priceBox("Water bottle", "EUR"), "5");
      expect(screen.getByTestId("order-total").textContent).toBe("10.00 EUR");
    });

    it("the currency chosen on Step 1 is the one used at Checkout", async () => {
      const user = userEvent.setup();
      render(<CreateOrderForm clients={clients as any} defaultCurrency="USD" />);
      await pickClient(user);
      await user.selectOptions(screen.getByLabelText("Order currency"), "GBP");
      await addProduct(user, "Water bottle", "4");
      await user.click(screen.getByRole("button", { name: "Checkout" }));
      expect((await screen.findByTestId("checkout-currency")).textContent).toBe("Prices in GBP");
    });

    it("Back to Products returns to Step 1 with the client, products and quantities (and any prices) still there", async () => {
      const user = userEvent.setup();
      await toCheckout(user, [["Water bottle", "20"], ["Flour", "10"]]);
      await user.type(priceBox("Water bottle"), "120000");
      await user.click(screen.getByRole("button", { name: "Back to Products" }));
      expect(screen.getByRole("button", { name: "Checkout" })).toBeTruthy();
      expect((screen.getByRole("combobox", { name: "Select client" }) as HTMLInputElement).value).toBe("Acme Ltd");
      expect(((await screen.findByLabelText("Order quantity of Water bottle in pcs")) as HTMLInputElement).value).toBe("20");
      expect((qtyBox("Flour", "kg") as HTMLInputElement).value).toBe("10");
      await user.click(screen.getByRole("button", { name: "Checkout" }));
      expect(priceBox("Water bottle").value).toBe("120000"); // the price typed before is kept
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]); // and still nothing was saved
    });

    it("a product dropped on Step 1 is gone from Checkout, and one added later needs its own price", async () => {
      const user = userEvent.setup();
      await toCheckout(user, [["Water bottle", "20"], ["Flour", "10"]]);
      await user.type(priceBox("Water bottle"), "5");
      await user.type(priceBox("Flour"), "7");
      await user.click(screen.getByRole("button", { name: "Back to Products" }));
      await user.click(await screen.findByRole("button", { name: "Drop Flour" }));
      await user.click(screen.getByRole("button", { name: "Checkout" }));
      expect(screen.queryByLabelText(/Per piece price of Flour/)).toBeNull();
      expect(saveButton().disabled).toBe(false);
      expect(screen.getByTestId("order-total").textContent).toBe("100.00 USD");
    });

    it("Save Order sends the client, the currency and, for every product, the exact quantity and the price agreed for ONE piece; then opens Delivery Lists", async () => {
      const user = userEvent.setup();
      await toCheckout(user, [["Water bottle", "20"], ["Flour", "2.5"]], { defaultCurrency: "PKR" });
      await user.type(screen.getByLabelText("Per piece price of Water bottle in PKR"), "120000");
      await user.type(screen.getByLabelText("Per piece price of Flour in PKR"), "49.99");
      await user.click(saveButton());
      await waitFor(() => expect(router.push).toHaveBeenCalledWith("/delivery-lists?created=SO-000001"));
      const post = calls.find((c) => c.url === "/api/sales/orders")!;
      expect(post.body).toEqual({ clientId: C1, currencyCode: "PKR", lines: [{ productId: WATER, quantity: "20", unitPrice: "120000" }, { productId: FLOUR, quantity: "2.5", unitPrice: "49.99" }] });
      expect(post.headers["Idempotency-Key"]).toMatch(/^ui-/);
    });

    it("the same product for another client is priced on its own order: nothing is remembered between orders", async () => {
      const user = userEvent.setup();
      await toCheckout(user, [["Water bottle", "20"]]);
      expect(priceBox("Water bottle").value).toBe(""); // no catalog price, no earlier price
    });

    it("saving twice sends the SAME key; changing a price sends a new one", async () => {
      const user = userEvent.setup();
      handlers["POST /api/sales/orders"] = () => json(409, { error: "Only 100 pcs of Water bottle are available." });
      await toCheckout(user, [["Water bottle", "40"]]);
      await user.type(priceBox("Water bottle"), "9");
      await user.click(saveButton());
      await screen.findByText("Only 100 pcs of Water bottle are available.");
      await user.click(saveButton());
      await user.type(priceBox("Water bottle"), "5"); // the order is not the same order any more
      await user.click(saveButton());
      await waitFor(() => expect(calls.filter((c) => c.url === "/api/sales/orders")).toHaveLength(3));
      const keys = calls.filter((c) => c.url === "/api/sales/orders").map((c) => c.headers["Idempotency-Key"]);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
    });

    it("a double click saves once, and the buttons are disabled while it is being saved", async () => {
      const user = userEvent.setup();
      let release: (r: Response) => void = () => undefined;
      handlers["POST /api/sales/orders"] = () => new Promise<Response>((resolve) => { release = resolve; }) as unknown as Response;
      await toCheckout(user, [["Water bottle", "10"]]);
      await user.type(priceBox("Water bottle"), "3");
      const save = saveButton();
      await user.dblClick(save);
      expect(calls.filter((c) => c.url === "/api/sales/orders")).toHaveLength(1);
      expect(save.disabled).toBe(true);
      expect(save.textContent).toBe("Saving…");
      expect((screen.getByRole("button", { name: "Back to Products" }) as HTMLButtonElement).disabled).toBe(true);
      expect(priceBox("Water bottle").disabled).toBe(true);
      release(json(201, { order: { id: O1, number: "SO-000001" } }));
      await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    });

    it("an unconfirmed booking (202) is said plainly at Checkout and can be retried with the same key", async () => {
      const user = userEvent.setup();
      handlers["POST /api/sales/orders"] = () => json(202, { order: { id: O1, number: "SO-000007" }, pending: true });
      await toCheckout(user, [["Water bottle", "10"]]);
      await user.type(priceBox("Water bottle"), "3");
      await user.click(saveButton());
      await screen.findByText(/nothing is treated as booked/);
      expect(document.body.textContent).toContain("SO-000007");
      expect(router.push).not.toHaveBeenCalled();
      handlers["POST /api/sales/orders"] = () => json(200, { order: { id: O1, number: "SO-000007" }, replayed: true });
      await user.click(screen.getByRole("button", { name: "Retry booking" }));
      await waitFor(() => expect(router.push).toHaveBeenCalledWith("/delivery-lists?created=SO-000007"));
      const keys = calls.filter((c) => c.url === "/api/sales/orders").map((c) => c.headers["Idempotency-Key"]);
      expect(new Set(keys).size).toBe(1);
    });

    it("the server's refusal is shown and Checkout stays as it was", async () => {
      const user = userEvent.setup();
      handlers["POST /api/sales/orders"] = () => json(409, { error: "Only 100 pcs of Water bottle are available." });
      await toCheckout(user, [["Water bottle", "40"]]);
      await user.type(priceBox("Water bottle"), "9");
      await user.click(saveButton());
      expect((await screen.findAllByRole("alert")).map((a) => a.textContent).join(" ")).toContain("Only 100 pcs of Water bottle are available.");
      expect(priceBox("Water bottle").value).toBe("9");
    });
  });
});

// =====================================================================================================================================
describe("Delivery Lists board", () => {
  const empty = { ok: true as const, items: [], total: 0, limit: 100, offset: 0 };
  const two = { ok: true as const, items: [summary(O1, "SO-000001", L1, "DL-000001"), summary(O2, "SO-000002", L2, "DL-000002", { client: { id: "c2", name: "Beta Trading", is_active: true }, delivery_list: { id: L2, number: "DL-000002", status: "partially_dispatched" } })], total: 2, limit: 100, offset: 0 };
  const board = (over: Partial<Parameters<typeof DeliveryBoard>[0]> = {}) => render(<DeliveryBoard view="active" orders={two as any} others={empty as any} clients={clients as any} created={null} {...over} />);

  it("shows each active order as a card with client, number, date, product count, fulfilment and reservation, and EXACTLY Edit, Remove, View List", () => {
    board();
    const card = screen.getByText("SO-000001").closest("[data-order]") as HTMLElement;
    for (const text of ["Acme Ltd", "SO-000001", "DL-000001", "2026-11-09 10:00 UTC", "Ready for dispatch", "No. of items", "Cost", "1,250.00 USD"]) expect(card.textContent, text).toContain(text);
    expect(card.textContent).not.toContain("Reservation"); // replaced by the cost
    expect(card.textContent).not.toContain("Stock reserved");
    expect(card.textContent).not.toMatch(/Products\d/); // "Products" became "No. of items"
    // top right: a pencil and a red bin, as bare icons (no text, no circle or border); bottom left View List; bottom right Dispatch
    expect(within(card).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Edit SO-000001", "Remove SO-000001", "View list SO-000001", "Dispatch SO-000001"]);
    const header = card.firstElementChild as HTMLElement;
    const edit = within(header).getByRole("button", { name: "Edit SO-000001" });
    const bin = within(header).getByRole("button", { name: "Remove SO-000001" });
    for (const icon of [edit, bin]) {
      expect(icon.textContent).toBe("");
      expect(icon.querySelector("svg")).toBeTruthy();
      expect(icon.className).not.toMatch(/\b(border|rounded\S*|bg-\S+)\b/);
    }
    expect(bin.className).toContain("text-red-400");
    expect(header.textContent).not.toContain("Ready for dispatch"); // the status badge is gone from the corner
    const footer = card.lastElementChild as HTMLElement;
    const view = footer.firstElementChild as HTMLElement;
    expect(view.getAttribute("aria-label")).toBe("View list SO-000001");
    expect(view.className).toContain("border-ix-mist/20"); // the same calm look as the Cancel buttons
    expect(view.className).not.toContain("bg-ix-butter");
    const dispatch = footer.lastElementChild as HTMLElement;
    expect(dispatch.textContent).toBe("Dispatch");
    expect(dispatch.className).toContain("bg-ix-butter"); // the golden theme
    const partly = screen.getByText("SO-000002").closest("[data-order]") as HTMLElement;
    expect(partly.textContent).toContain("Partially delivered");
  });

  it("shows the number of items and the order's cost on each card, and a dash when the order cannot be totalled", () => {
    const mixed = { ok: true as const, items: [summary(O1, "SO-000001", L1, "DL-000001", { product_count: 3, total_amount: "58.33325", currency_code: "EUR" }), summary(O2, "SO-000002", L2, "DL-000002", { total_amount: null, currency_code: null })], total: 2, limit: 100, offset: 0 };
    board({ orders: mixed as any });
    const one = screen.getByText("SO-000001").closest("[data-order]") as HTMLElement;
    const fact = (card: HTMLElement, label: string) => within(card).getByText(label).parentElement!.textContent;
    expect(fact(one, "No. of items")).toBe("No. of items3"); // the number of products on the order, as before
    expect(fact(one, "Cost")).toBe("Cost58.33325 EUR"); // exact: nothing is rounded again in the browser
    expect(fact(screen.getByText("SO-000002").closest("[data-order]") as HTMLElement, "Cost")).toBe("Cost—");
  });

  it("an order dispatched on this page keeps its cost", async () => {
    const user = userEvent.setup();
    handlers["POST /api/sales/orders/" + O1 + "/dispatch"] = () => json(200, { dispatch: { status: "confirmed" }, confirmed: true, dispatchedOn: "2026-11-09" });
    board();
    await user.click(screen.getByRole("button", { name: "Dispatch SO-000001" }));
    const card = screen.getByText("SO-000001").closest("[data-order]") as HTMLElement;
    await waitFor(() => expect(card.textContent).toContain("Dispatched on 2026-11-09"));
    expect(card.textContent).toContain("1,250.00 USD");
  });

  it("has no Scan products button at the top: only Create Order", () => {
    board();
    expect(screen.queryByRole("link", { name: /scan products/i })).toBeNull();
    expect(screen.getByRole("link", { name: "Create Order" })).toBeTruthy();
  });

  it("has Active and Delivered History views, a Create Order button, and a success message for a just-saved order", () => {
    board({ created: "SO-000009" });
    expect(screen.getByRole("link", { name: "Create Order" }).getAttribute("href")).toBe("/sales-orders/new");
    expect(screen.getByRole("link", { name: "Active" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Delivered History" }).getAttribute("href")).toBe("/delivery-lists?view=history");
    expect(screen.getByRole("status").textContent).toContain("SO-000009 was saved");
  });

  it("Delivered History lists finished orders with their expiry, View List at the top and Generate Invoice at the bottom, and says what the 24 hours mean", () => {
    const done = { ok: true as const, items: [summary(O1, "SO-000001", L1, "DL-000001", { status: "delivered", reservation_status: "consumed", delivery_list: { id: L1, number: "DL-000001", status: "dispatched" }, completed_at: "2026-11-09T12:00:00+00:00", history_expires_at: "2026-11-10T12:00:00+00:00" })], total: 1, limit: 100, offset: 0 };
    board({ view: "history", orders: done as any, others: null });
    const card = screen.getByText("SO-000001").closest("[data-order]") as HTMLElement;
    expect(within(card).getAllByRole("button").map((b) => b.textContent)).toEqual(["View List", "Generate Invoice"]);
    expect(card.textContent).toContain("2026-11-10 12:00 UTC");
    expect(card.textContent).toContain("Dispatched on 2026-11-09");
    expect(screen.getByText(/stay here for 24 hours/)).toBeTruthy();
    expect(screen.queryByText("Draft and older lists")).toBeNull();
  });

  it("an empty history and an empty active list each say something helpful", () => {
    const { unmount } = board({ view: "history", orders: empty as any, others: null });
    expect(screen.getByText("Nothing was fully delivered in the last 24 hours.")).toBeTruthy();
    unmount();
    board({ orders: empty as any });
    expect(screen.getByText(/No active orders yet/)).toBeTruthy();
  });

  it("View List opens a centered dialog with the order, never a page: client, numbers, status, products, dispatched and remaining", async () => {
    const user = userEvent.setup();
    board();
    await user.click(screen.getByRole("button", { name: "View list SO-000001" }));
    const dialog = await screen.findByRole("dialog");
    expect(router.push).not.toHaveBeenCalled(); // no navigation
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    await within(dialog).findByText("Products and quantities");
    for (const text of ["SO-000001 · Acme Ltd", "Delivery list DL-000001", "Sales order", "Delivery list", "Created", "Order status", "Reservation", "Water bottle", "WATER", "400 pcs", "150", "250", "Ordered", "Dispatched", "Remaining"]) {
      expect(dialog.textContent, text).toContain(text);
    }
    expect(dialog.className).toContain("rounded-[24px]");
    expect(dialog.className).toContain("max-h-[85vh]"); // never taller than the viewport
    expect(dialog.querySelector("[data-modal-body]")!.className).toContain("overflow-y-auto"); // the list scrolls INSIDE the dialog
    expect(document.body.style.overflow).toBe("hidden"); // the page behind does not scroll
    expect(within(dialog).getByRole("link", { name: "Prepare dispatch" }).getAttribute("href")).toBe(`/delivery-lists/${L1}/dispatch`);
  });

  it("View List shows each product's agreed price per piece, its line total and the order total; an older order says its price was not recorded", async () => {
    const user = userEvent.setup();
    board();
    await user.click(screen.getByRole("button", { name: "View list SO-000001" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Products and quantities");
    expect(within(dialog).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Product", "Ordered", "Dispatched", "Remaining", "Price per piece", "Line total"]);
    expect(dialog.textContent).toContain("3.00 USD");
    expect(dialog.textContent).toContain("1,200.00 USD");
    expect(within(dialog).getByTestId("view-order-total").textContent).toBe("1,250.00 USD");
  });

  it("View List of an order made before prices were recorded shows no price columns and 'Price not recorded'", async () => {
    const user = userEvent.setup();
    handlers["GET /api/sales/orders/" + O1] = () => json(200, { order: detail({ currency_code: null, total_amount: null, prices_recorded: false, lines: detail().lines.map((l: any) => ({ ...l, unit_price: null, line_total: null })) }) });
    board();
    await user.click(screen.getByRole("button", { name: "View list SO-000001" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Products and quantities");
    expect(within(dialog).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Product", "Ordered", "Dispatched", "Remaining"]);
    expect(dialog.textContent).toContain("Price not recorded");
  });

  it("closes with the close button, Escape and a backdrop click, and gives the page its scrolling back", async () => {
    const user = userEvent.setup();
    board();
    const open = () => user.click(screen.getByRole("button", { name: "View list SO-000001" }));
    await open();
    const dialog = await screen.findByRole("dialog");
    fireEvent(dialog, new Event("cancel", { cancelable: true })); // Escape
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.style.overflow).toBe("");
    await open();
    const again = await screen.findByRole("dialog");
    fireEvent.click(again); // a click on the backdrop is a click on the dialog element itself
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await open();
    await screen.findByRole("dialog");
    await user.click(within(screen.getByRole("dialog")).getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a click INSIDE the dialog does not close it", async () => {
    const user = userEvent.setup();
    board();
    await user.click(screen.getByRole("button", { name: "View list SO-000001" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByText("Products and quantities"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  describe("Dispatch", () => {
    const dispatchUrl = `/api/sales/orders/${O1}/dispatch`;
    const cardOf = (number = "SO-000001") => screen.getByText(number).closest("[data-order]") as HTMLElement;

    it("asks for a confirmation first, and Cancel changes nothing", async () => {
      const user = userEvent.setup();
      (window.confirm as any).mockReturnValue(false);
      board();
      await user.click(screen.getByRole("button", { name: "Dispatch SO-000001" }));
      expect((window.confirm as any)).toHaveBeenCalledWith(expect.stringContaining("taken out of your inventory"));
      expect(calls.some((c) => c.url === dispatchUrl)).toBe(false);
      expect(within(cardOf()).getByRole("button", { name: "Edit SO-000001" })).toBeTruthy();
      expect(cardOf().textContent).not.toContain("Dispatched on");
    });

    it("Confirm dispatches the order: the card says 'Dispatched on <date>' and loses Edit, Remove and Dispatch", async () => {
      const user = userEvent.setup();
      handlers["POST " + dispatchUrl] = () => json(200, { dispatch: { status: "confirmed" }, confirmed: true, dispatchedOn: "2026-11-09" });
      board();
      await user.click(screen.getByRole("button", { name: "Dispatch SO-000001" }));
      const card = cardOf();
      await waitFor(() => expect(card.textContent).toContain("Dispatched on 2026-11-09"));
      expect(calls.filter((c) => c.url === dispatchUrl && c.method === "POST")).toHaveLength(1);
      expect(calls.find((c) => c.url === dispatchUrl)!.body).toBeUndefined(); // the browser sends nothing but the order in the address
      for (const gone of ["Edit SO-000001", "Remove SO-000001", "Dispatch SO-000001"]) expect(within(card).queryByRole("button", { name: gone })).toBeNull();
      expect(within(card).getByRole("button", { name: "View list SO-000001" })).toBeTruthy(); // the list can still be looked at
      expect(card.textContent).toContain("Delivered"); // fulfilment and reservation now say it left
      expect(card.textContent).not.toContain("Ready for dispatch");
      expect((await screen.findByRole("status")).textContent).toContain("SO-000001 was dispatched on 2026-11-09. Its items were taken out of your inventory.");
      // the other order is untouched
      expect(within(cardOf("SO-000002")).getByRole("button", { name: "Dispatch SO-000002" })).toBeTruthy();
    });

    describe("after the dispatch: View List moves to the top and the one button at the bottom is Generate Invoice", () => {
      const dispatched = () => {
        handlers["POST " + dispatchUrl] = () => json(200, { dispatch: { status: "confirmed" }, confirmed: true, dispatchedOn: "2026-11-09" });
      };
      const afterDispatch = async (user: ReturnType<typeof userEvent.setup>) => {
        dispatched();
        board();
        await user.click(screen.getByRole("button", { name: "Dispatch SO-000001" }));
        const card = cardOf();
        await waitFor(() => expect(card.textContent).toContain("Dispatched on 2026-11-09"));
        return card;
      };
      const invoiceUrl = `/api/sales/orders/${O1}/invoice`;
      const INV = "9f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";

      it("View List is in the top corner where Edit and Remove were; they are gone; the bottom has exactly one button", async () => {
        const card = await afterDispatch(userEvent.setup());
        const header = card.firstElementChild as HTMLElement;
        const top = within(header).getAllByRole("button").map((b) => b.textContent);
        expect(top).toEqual(["View List"]);
        for (const gone of ["Edit SO-000001", "Remove SO-000001", "Dispatch SO-000001"]) expect(within(card).queryByRole("button", { name: gone })).toBeNull();
        const footer = card.lastElementChild as HTMLElement;
        expect(within(footer).getAllByRole("button").map((b) => b.textContent)).toEqual(["Generate Invoice"]);
        expect(within(card).getAllByRole("button")).toHaveLength(2); // nothing else on the card
        expect(footer.querySelector("button")!.className).toContain("bg-ix-butter");
      });

      it("a card that was not dispatched keeps Edit, Remove, View List and Dispatch, and has no Generate Invoice", () => {
        board();
        const card = cardOf();
        expect(within(card).queryByRole("button", { name: /generate invoice/i })).toBeNull();
        for (const name of ["Edit SO-000001", "Remove SO-000001", "View list SO-000001", "Dispatch SO-000001"]) expect(within(card).getByRole("button", { name })).toBeTruthy();
      });

      it("the moved View List still opens the list", async () => {
        const user = userEvent.setup();
        const card = await afterDispatch(user);
        await user.click(within(card).getByRole("button", { name: "View list SO-000001" }));
        expect(await screen.findByRole("dialog")).toBeTruthy();
      });

      it("Generate Invoice asks the Sales Service to make the invoice from the order, then goes to the Sales Invoice page that shows it", async () => {
        const user = userEvent.setup();
        handlers["POST " + invoiceUrl] = () => json(201, { invoice: { id: INV, number: null, status: "draft" }, created: true });
        const card = await afterDispatch(user);
        await user.click(within(card).getByRole("button", { name: "Generate invoice for SO-000001" }));
        await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/invoices/sales?generated=${INV}`));
        const calls_ = calls.filter((c) => c.url === invoiceUrl);
        expect(calls_).toHaveLength(1);
        expect(calls_[0].method).toBe("POST");
        expect(calls_[0].body).toBeUndefined(); // the browser sends nothing but the order in the address
      });

      it("an order that already has an invoice is sent to that invoice, marked as existing", async () => {
        const user = userEvent.setup();
        handlers["POST " + invoiceUrl] = () => json(200, { invoice: { id: INV, number: "INV-000004", status: "issued" }, created: false });
        const card = await afterDispatch(user);
        await user.click(within(card).getByRole("button", { name: "Generate invoice for SO-000001" }));
        await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/invoices/sales?generated=${INV}&existing=1`));
      });

      it("a double click makes one request, and the button stays disabled while the browser moves on", async () => {
        const user = userEvent.setup();
        let release: (r: Response) => void = () => undefined;
        handlers["POST " + invoiceUrl] = () => new Promise<Response>((resolve) => { release = resolve; });
        const card = await afterDispatch(user);
        const button = within(card).getByRole("button", { name: "Generate invoice for SO-000001" });
        await user.dblClick(button);
        expect(calls.filter((c) => c.url === invoiceUrl)).toHaveLength(1);
        expect((within(card).getByRole("button", { name: "Generate invoice for SO-000001" }) as HTMLButtonElement).disabled).toBe(true);
        expect(within(card).getByRole("button", { name: "Generate invoice for SO-000001" }).textContent).toBe("Generating…");
        release(json(201, { invoice: { id: INV, number: null, status: "draft" }, created: true }));
        await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
        expect((within(card).getByRole("button", { name: "Generate invoice for SO-000001" }) as HTMLButtonElement).disabled).toBe(true); // still disabled: we are leaving
      });

      it.each([
        ["no price", 422, "No selling price is set for Water bottle. Set it in Stock, or create this invoice by hand on the Sales Invoice page."],
        ["mixed currencies", 422, "The products of this order are priced in different currencies (EUR, USD), and nothing is converted. Create the invoice by hand on the Sales Invoice page."],
        ["the service is down", 503, "The product prices could not be read just now, so the invoice was not made. Please try again in a moment."],
      ])("when it cannot be made (%s) the reason is shown, the page stays, and the button works again", async (_name, status, error) => {
        const user = userEvent.setup();
        handlers["POST " + invoiceUrl] = () => json(status, { error });
        const card = await afterDispatch(user);
        await user.click(within(card).getByRole("button", { name: "Generate invoice for SO-000001" }));
        expect((await screen.findAllByRole("alert")).some((a) => a.textContent === error)).toBe(true);
        expect(router.push).not.toHaveBeenCalled();
        const again = within(card).getByRole("button", { name: "Generate invoice for SO-000001" }) as HTMLButtonElement;
        expect(again.disabled).toBe(false);
        expect(again.textContent).toBe("Generate Invoice");
      });

      it("an expired session goes to the login page", async () => {
        const user = userEvent.setup();
        handlers["POST " + invoiceUrl] = () => json(401, { error: "Your session has expired. Please sign in again." });
        const card = await afterDispatch(user);
        await user.click(within(card).getByRole("button", { name: "Generate invoice for SO-000001" }));
        await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
      });

      it("the other order on the page is untouched", async () => {
        const card = await afterDispatch(userEvent.setup());
        expect(card).toBeTruthy();
        expect(within(cardOf("SO-000002")).queryByRole("button", { name: /generate invoice/i })).toBeNull();
        expect(within(cardOf("SO-000002")).getByRole("button", { name: "Dispatch SO-000002" })).toBeTruthy();
      });
    });

    it("an order that was only partly delivered is dispatched too (what is left)", async () => {
      const user = userEvent.setup();
      handlers["POST " + `/api/sales/orders/${O2}/dispatch`] = () => json(200, { dispatch: {}, confirmed: true, dispatchedOn: "2026-11-09" });
      board();
      await user.click(screen.getByRole("button", { name: "Dispatch SO-000002" }));
      await waitFor(() => expect(cardOf("SO-000002").textContent).toContain("Dispatched on 2026-11-09"));
    });

    it("shows the server's reason (for example not enough stock) and keeps every button", async () => {
      const user = userEvent.setup();
      handlers["POST " + dispatchUrl] = () => json(409, { error: "Only 10 pcs of Water bottle are on hand." });
      board();
      await user.click(screen.getByRole("button", { name: "Dispatch SO-000001" }));
      expect((await screen.findByRole("alert")).textContent).toContain("Only 10 pcs of Water bottle are on hand.");
      expect(cardOf().textContent).not.toContain("Dispatched on");
      expect(within(cardOf()).getByRole("button", { name: "Edit SO-000001" })).toBeTruthy();
      expect((within(cardOf()).getByRole("button", { name: "Dispatch SO-000001" }) as HTMLButtonElement).disabled).toBe(false); // can be tried again
    });

    it("an unconfirmed posting (202) is said plainly; the order is NOT shown as dispatched", async () => {
      const user = userEvent.setup();
      handlers["POST " + dispatchUrl] = () => json(202, { dispatch: { status: "posting" }, confirmed: false, dispatchedOn: "2026-11-09" });
      board();
      await user.click(screen.getByRole("button", { name: "Dispatch SO-000001" }));
      expect((await screen.findByRole("alert")).textContent).toContain("Press Dispatch again to finish it");
      expect(cardOf().textContent).not.toContain("Dispatched on");
    });

    it("cannot be pressed while the booking is unconfirmed or twice at once", async () => {
      const user = userEvent.setup();
      let release: (r: Response) => void = () => undefined;
      handlers["POST " + dispatchUrl] = () => { throw new Error("unused"); };
      (fetch as any).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      board();
      const button = screen.getByRole("button", { name: "Dispatch SO-000001" }) as HTMLButtonElement;
      await user.click(button);
      await waitFor(() => expect(button.disabled).toBe(true));
      expect(button.textContent).toBe("Dispatching…");
      await user.click(button);
      expect(calls.filter((c) => c.url === dispatchUrl)).toHaveLength(0); // the stubbed request is still pending and no second one was sent
      release(json(200, { dispatchedOn: "2026-11-09", confirmed: true }));
      await waitFor(() => expect(cardOf().textContent).toContain("Dispatched on 2026-11-09"));
    });
  });

  it("Remove asks first, then cancels the order and says its stock was released", async () => {
    const user = userEvent.setup();
    handlers["POST /api/sales/orders/" + O1 + "/cancel"] = () => json(200, { order: detail({ status: "cancelled" }), pending: false });
    board();
    await user.click(screen.getByRole("button", { name: "Remove SO-000001" }));
    expect((window.confirm as any)).toHaveBeenCalledWith(expect.stringContaining("all the stock reserved for them is released"));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/sales/orders/${O1}/cancel` && c.method === "POST")).toBe(true));
    expect((await screen.findByRole("status")).textContent).toContain("SO-000001 was removed and its stock released.");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("Remove changes nothing when the question is declined", async () => {
    const user = userEvent.setup();
    (window.confirm as any).mockReturnValue(false);
    board();
    await user.click(screen.getByRole("button", { name: "Remove SO-000001" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("for a PARTLY delivered order, Remove becomes 'cancel the remaining quantity' and says what is kept", async () => {
    const user = userEvent.setup();
    handlers["POST /api/sales/orders/" + O2 + "/cancel-remaining"] = () => json(200, { order: detail({ status: "closed" }), pending: false });
    board();
    await user.click(screen.getByRole("button", { name: "Remove SO-000002" }));
    expect((window.confirm as any)).toHaveBeenCalledWith(expect.stringContaining("what was dispatched stays exactly as it is"));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/sales/orders/${O2}/cancel-remaining`)).toBe(true));
    expect((await screen.findByRole("status")).textContent).toContain("undelivered quantity was cancelled");
  });

  it("shows the server's reason when an order cannot be removed", async () => {
    const user = userEvent.setup();
    handlers["POST /api/sales/orders/" + O1 + "/cancel"] = () => json(409, { error: "A dispatch of SO-000001 is being posted to stock right now." });
    board();
    await user.click(screen.getByRole("button", { name: "Remove SO-000001" }));
    expect((await screen.findByRole("alert")).textContent).toContain("being posted to stock");
  });

  it("an order whose booking is not confirmed yet says so, offers a retry, and cannot be edited or removed", async () => {
    const user = userEvent.setup();
    const pending = { ok: true as const, items: [summary(O1, "SO-000001", L1, "DL-000001", { status: "pending_reservation", reservation_status: "pending", delivery_list: { id: L1, number: "DL-000001", status: "draft" } })], total: 1, limit: 100, offset: 0 };
    handlers["POST /api/sales/orders/" + O1 + "/reconcile"] = () => json(200, { order: detail(), pending: false });
    board({ orders: pending as any });
    const card = screen.getByText("SO-000001").closest("[data-order]") as HTMLElement;
    expect(card.textContent).toContain("not confirmed yet");
    expect((within(card).getByRole("button", { name: "Edit SO-000001" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(card).getByRole("button", { name: "Remove SO-000001" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(card).getByRole("button", { name: "Dispatch SO-000001" }) as HTMLButtonElement).disabled).toBe(true); // an unbooked order cannot be dispatched
    await user.click(within(card).getByRole("button", { name: "Retry booking" }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/sales/orders/${O1}/reconcile`)).toBe(true));
  });

  describe("Edit", () => {
    async function openEdit(user: ReturnType<typeof userEvent.setup>) {
      board();
      await user.click(screen.getByRole("button", { name: "Edit SO-000001" }));
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByText("Water bottle");
      return dialog;
    }

    it("loads the order's lines with their limits, shows what was dispatched and does not let a dispatched line be removed", async () => {
      const user = userEvent.setup();
      const dialog = await openEdit(user);
      expect(dialog.textContent).toContain("Edit SO-000001");
      expect((within(dialog).getByLabelText("Quantity of Water bottle in pcs") as HTMLInputElement).value).toBe("400");
      expect((within(dialog).getByRole("button", { name: "Remove Water bottle" }) as HTMLButtonElement).disabled).toBe(true); // 150 already dispatched
      expect((within(dialog).getByRole("button", { name: "Remove Flour" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("saves the new quantities with the order's version, then closes and refreshes", async () => {
      const user = userEvent.setup();
      handlers["PATCH /api/sales/orders/" + O1] = () => json(200, { order: detail(), pending: false });
      const dialog = await openEdit(user);
      const input = within(dialog).getByLabelText("Quantity of Water bottle in pcs");
      await user.clear(input);
      await user.type(input, "250");
      await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
      // each line keeps its saved agreed price (the quantity changes, the price does not): the totals follow quantity x that price
      expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ version: 1, lines: [{ productId: WATER, quantity: "250", unitPrice: "3.00" }, { productId: FLOUR, quantity: "5", unitPrice: "10.00" }] });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(router.refresh).toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toContain("SO-000001 was updated");
    });

    it("shows each line's saved agreed price and the order total; a dispatched line's price is frozen, an undispatched one can still be corrected", async () => {
      const user = userEvent.setup();
      const dialog = await openEdit(user);
      expect((within(dialog).getByLabelText("Per piece price of Water bottle in USD") as HTMLInputElement).value).toBe("3.00");
      expect((within(dialog).getByLabelText("Per piece price of Water bottle in USD") as HTMLInputElement).disabled).toBe(true); // 150 already dispatched
      expect((within(dialog).getByLabelText("Per piece price of Flour in USD") as HTMLInputElement).disabled).toBe(false);
      expect(within(dialog).getByTestId("edit-order-total").textContent).toBe("1,250.00 USD");
      const input = within(dialog).getByLabelText("Quantity of Water bottle in pcs");
      await user.clear(input);
      await user.type(input, "300");
      expect(within(dialog).getByTestId("edit-order-total").textContent).toBe("950.00 USD"); // 300 x 3 + 5 x 10, the same saved prices
    });

    it("a product added in the dialog must be given its agreed price before the change can be saved", async () => {
      const user = userEvent.setup();
      handlers["GET /api/sales/order-products"] = () => json(200, { items: [{ product_id: "9a1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6", sku: "SALT", name: "Salt", unit: "kg", unit_allows_fractions: true, is_active: true, total_quantity: "50.0000", reserved_quantity: "0.0000", available_quantity: "50.0000" }], total: 1, limit: 20, offset: 0 });
      const dialog = await openEdit(user);
      await user.click(within(dialog).getByRole("combobox", { name: /Add a product/ }));
      await user.click(await screen.findByRole("button", { name: /Salt/ }));
      await user.type(within(dialog).getByLabelText("Quantity of Salt in kg"), "4");
      await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
      expect(dialog.textContent).toContain("Enter a valid price per piece for every product");
      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
      await user.type(within(dialog).getByLabelText("Per piece price of Salt in USD"), "2.5");
      expect(within(dialog).getByTestId("edit-order-total").textContent).toBe("1,260.00 USD");
    });

    it("an order made before prices were recorded shows no price column and sends no prices", async () => {
      const user = userEvent.setup();
      handlers["GET /api/sales/orders/" + O1] = () => json(200, { order: detail({ currency_code: null, total_amount: null, prices_recorded: false, lines: detail().lines.map((l: any) => ({ ...l, unit_price: null, line_total: null })) }) });
      handlers["PATCH /api/sales/orders/" + O1] = () => json(200, { order: detail(), pending: false });
      board();
      await user.click(screen.getByRole("button", { name: "Edit SO-000001" }));
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByText("Water bottle");
      expect(within(dialog).queryByLabelText(/Per piece price/)).toBeNull();
      expect(within(dialog).queryByTestId("edit-order-total")).toBeNull();
      const input = within(dialog).getByLabelText("Quantity of Water bottle in pcs");
      await user.clear(input);
      await user.type(input, "250");
      await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
      expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ version: 1, lines: [{ productId: WATER, quantity: "250" }, { productId: FLOUR, quantity: "5" }] });
    });

    it("refuses a quantity below what was dispatched, and above what is available, before asking the server", async () => {
      const user = userEvent.setup();
      const dialog = await openEdit(user);
      const input = within(dialog).getByLabelText("Quantity of Water bottle in pcs");
      await user.clear(input);
      await user.type(input, "100");
      await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
      expect((await within(dialog).findAllByRole("alert")).map((a) => a.textContent).join(" ")).toContain("150 pcs was already dispatched");
      await user.clear(input);
      await user.type(input, "600");
      await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
      expect(dialog.textContent).toContain("Cannot increase to 600: only 100 more pcs are currently available.");
      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    });

    it("shows the server's refusal and keeps the dialog open", async () => {
      const user = userEvent.setup();
      handlers["PATCH /api/sales/orders/" + O1] = () => json(409, { error: "Cannot increase Water bottle to 450. Only 20 additional pcs are currently available." });
      const dialog = await openEdit(user);
      const input = within(dialog).getByLabelText("Quantity of Water bottle in pcs");
      await user.clear(input);
      await user.type(input, "450");
      await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
      expect((await within(dialog).findByText(/Only 20 additional pcs/)).textContent).toBeTruthy();
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("explains why an order cannot be edited and disables saving", async () => {
      const user = userEvent.setup();
      handlers["GET /api/sales/orders/" + O1] = () => json(200, { order: detail({ can_edit: false, edit_blocked_reason: "A dispatch is being posted to stock. Finish it (confirm it again) first." }) });
      board();
      await user.click(screen.getByRole("button", { name: "Edit SO-000001" }));
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByRole("note");
      expect(dialog.textContent).toContain("A dispatch is being posted to stock");
      expect((within(dialog).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("Draft and older lists", () => {
    const others = { ok: true as const, total: 3, limit: 100, offset: 0, items: [
      { id: L1, number: "DL-000010", client: { id: C1, name: "Acme Ltd", is_active: true }, external_reference: null, status: "draft", notes: null, item_count: 2, created_by_email: "a", created_at: now, updated_at: now, booking_state: "draft" },
      { id: L2, number: "DL-000011", client: { id: C1, name: "Old Co", is_active: true }, external_reference: null, status: "ready", notes: null, item_count: 1, created_by_email: "a", created_at: now, updated_at: now, booking_state: "unbooked" },
      { id: "x3", number: "DL-000012", client: { id: C1, name: "Half Co", is_active: true }, external_reference: null, status: "partially_dispatched", notes: null, item_count: 1, created_by_email: "a", created_at: now, updated_at: now, booking_state: "unbooked_partial" },
    ] };

    it("labels drafts, older unbooked lists and lists that need reconciliation, and books an older list on request", async () => {
      const user = userEvent.setup();
      handlers["POST /api/sales/delivery-lists/" + L2 + "/book"] = () => json(200, { order: { number: "SO-000020" }, pending: false });
      board({ orders: empty as any, others: others as any });
      const table = screen.getByRole("table", { name: "Draft and older delivery lists" });
      expect(within(table).getByText("Draft: nothing reserved")).toBeTruthy();
      expect(within(table).getByText("Not booked (older list)")).toBeTruthy();
      expect(within(table).getByText("Needs reconciliation")).toBeTruthy();
      expect(within(table).queryAllByRole("button", { name: "Book stock" })).toHaveLength(1); // not for a draft, not for one with goods already dispatched
      await user.click(within(table).getByRole("button", { name: "Book stock" }));
      await waitFor(() => expect(calls.some((c) => c.url === `/api/sales/delivery-lists/${L2}/book`)).toBe(true));
      expect((await screen.findByRole("status")).textContent).toContain("DL-000011 is booked as SO-000020");
    });

    it("puts a red bin in FRONT of every list; it asks first, then cancels the list and says so", async () => {
      const user = userEvent.setup();
      handlers["POST /api/sales/delivery-lists/" + L1 + "/cancel"] = () => json(200, { list: { id: L1, status: "cancelled" } });
      board({ orders: empty as any, others: others as any });
      const table = screen.getByRole("table", { name: "Draft and older delivery lists" });
      const row = within(table).getByText("DL-000010").closest("tr") as HTMLElement;
      const bin = within(row).getByRole("button", { name: "Remove DL-000010" });
      expect(row.querySelector("td")!.contains(bin)).toBe(true); // the first cell of the row
      expect(bin.className).toContain("text-red-300");
      expect(bin.querySelector("svg")).toBeTruthy();
      await user.click(bin);
      expect((window.confirm as any)).toHaveBeenCalledWith(expect.stringContaining("No stock was reserved"));
      await waitFor(() => expect(calls.some((c) => c.url === `/api/sales/delivery-lists/${L1}/cancel` && c.method === "POST")).toBe(true));
      expect((await screen.findByRole("status")).textContent).toContain("DL-000010 was removed.");
      expect(router.refresh).toHaveBeenCalled();
    });

    it("the bin changes nothing when the question is declined, and is disabled once goods were dispatched", async () => {
      const user = userEvent.setup();
      (window.confirm as any).mockReturnValue(false);
      board({ orders: empty as any, others: others as any });
      await user.click(screen.getByRole("button", { name: "Remove DL-000010" }));
      expect(calls.some((c) => c.method === "POST")).toBe(false);
      expect((screen.getByRole("button", { name: "Remove DL-000012" }) as HTMLButtonElement).disabled).toBe(true); // partially dispatched
      expect((screen.getByRole("button", { name: "Remove DL-000011" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("shows the server's reason when a list cannot be removed", async () => {
      const user = userEvent.setup();
      handlers["POST /api/sales/delivery-lists/" + L2 + "/cancel"] = () => json(409, { error: "DL-000011 cannot be cancelled right now." });
      board({ orders: empty as any, others: others as any });
      await user.click(screen.getByRole("button", { name: "Remove DL-000011" }));
      expect((await screen.findByRole("alert")).textContent).toContain("cannot be cancelled right now");
    });
  });
});
