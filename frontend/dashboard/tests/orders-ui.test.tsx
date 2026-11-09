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
  { product_id: WATER, sku: "WATER", name: "Water bottle", category: "Drinks", unit: "pcs", unit_allows_fractions: false, is_active: true, total_quantity: "500.0000", reserved_quantity: "400.0000", available_quantity: "100.0000" },
  { product_id: FLOUR, sku: "FLOUR", name: "Flour", category: "Food", unit: "kg", unit_allows_fractions: true, is_active: true, total_quantity: "20.0000", reserved_quantity: "0.0000", available_quantity: "20.0000" },
];

const summary = (id: string, number: string, list: string, listNumber: string, extra: Record<string, unknown> = {}) => ({
  id, number, client: { id: C1, name: "Acme Ltd", is_active: true }, delivery_list: { id: list, number: listNumber, status: "ready" }, status: "active", reservation_status: "reserved",
  origin: "order", version: 1, product_count: 2, created_by_email: "a@b.c", created_at: now, updated_at: now, completed_at: null, cancelled_at: null, history_expires_at: null,
  pending_action: null, last_error: null, notes: null, ...extra,
});
const detail = (extra: Record<string, unknown> = {}) => ({
  ...summary(O1, "SO-000001", L1, "DL-000001"),
  lines: [
    { id: "l1", product_id: WATER, product_sku: "WATER", product_name: "Water bottle", unit: "pcs", unit_allows_fractions: false, ordered_quantity: "400.0000", dispatched_quantity: "150.0000", pending_quantity: "0.0000", remaining_quantity: "250.0000",
      stock: { total_quantity: "350.0000", reserved_quantity: "250.0000", available_quantity: "100.0000", reserved_for_order: "250.0000", product_active: true } },
    { id: "l2", product_id: FLOUR, product_sku: "FLOUR", product_name: "Flour", unit: "kg", unit_allows_fractions: true, ordered_quantity: "5.0000", dispatched_quantity: "0.0000", pending_quantity: "0.0000", remaining_quantity: "5.0000",
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
      const items = PRODUCTS.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
      return json(200, { items, total: items.length, limit: 20, offset: 0 });
    }
    if (url.startsWith("/api/scan/resolve")) {
      const code = (new URL(url, "http://x").searchParams.get("code") ?? "").toUpperCase();
      const stock = PRODUCTS.find((p) => p.sku === code);
      if (!stock) return json(404, { error: "No product" });
      return json(200, { matched_by: "sku", identifier_kind: null, product: { id: stock.product_id, sku: stock.sku, name: stock.name, category: stock.category, unit: stock.unit, is_active: stock.is_active }, stock });
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
    expect(orderLines(rows)).toEqual([{ productId: WATER, quantity: "5" }, { productId: FLOUR, quantity: "30" }]);
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
    await user.click(screen.getByRole("button", { name: "Save Order" }));
    expect((await screen.findAllByRole("alert"))[0].textContent).toContain("Choose the client"); // "Acme Ltdx" is not a selected client
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

  it("is ONE form: the client first, then Scan Products and the search bar, then the inventory, then Cancel / View List / Save Order", async () => {
    render(<CreateOrderForm clients={clients as any} />);
    expect(screen.getAllByRole("form")).toHaveLength(1);
    const form = screen.getByRole("form", { name: "Create order" });
    const order = [form.querySelector("#client-heading")!, screen.getByRole("button", { name: /Scan Products/ }), screen.getByRole("searchbox", { name: "Search products" }), await screen.findByRole("table", { name: "Inventory" }), screen.getByRole("link", { name: "Cancel" }), screen.getByRole("button", { name: /View List/ }), screen.getByRole("button", { name: "Save Order" })];
    order.slice(1).forEach((el, i) => expect(!!(order[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING), `${i}`).toBe(true));
  });

  it("opens with the organization's inventory listed in the Products-tab layout, with stock figures and an Add and a Drop button per row", async () => {
    render(<CreateOrderForm clients={clients as any} />);
    const table = await screen.findByRole("table", { name: "Inventory" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Product", "Category", "Unit", "On hand", "Booked", "Available", "Quantity", "Actions"]);
    const row = within(table).getByText("Water bottle").closest("tr")! as HTMLElement;
    expect(row.textContent).toContain("WATER");
    expect(row.textContent).toContain("Drinks");
    expect(row.textContent).toContain("500"); // on hand
    expect(row.textContent).toContain("400"); // booked
    expect(row.textContent).toContain("100"); // available
    expect(within(row).getAllByRole("button").map((b) => b.textContent).filter(Boolean)).toEqual(["Add", "Drop"]); // (the quantity selector's - and + have icons, no text)
    expect((within(row).getByRole("button", { name: "Drop Water bottle" }) as HTMLButtonElement).disabled).toBe(true); // nothing to drop yet
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
    expect(screen.getByRole("button", { name: /View List/ }).textContent).toContain("1");
    await user.click(screen.getByRole("button", { name: "Drop Water bottle" }));
    expect((screen.getByRole("button", { name: "Add Water bottle" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: /View List/ }).textContent).toContain("0");
  });

  it("View List shows exactly the selected products in a dialog in the middle of the page, where quantities can be changed and a product removed", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    await addProduct(user, "Water bottle", "40");
    await addProduct(user, "Flour", "2.5");
    await user.click(screen.getByRole("button", { name: /View List/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Selected products");
    expect(dialog.textContent).toContain("2 products");
    const table = within(dialog).getByRole("table", { name: "Products required" });
    expect(within(table).getAllByRole("row").slice(1).map((r) => r.querySelector("td")!.textContent)).toEqual(["Water bottleWATER", "FlourFLOUR"]);
    expect(within(dialog).queryByRole("combobox")).toBeNull(); // review only: products are chosen in the inventory list
    expect(dialog.className).toContain("rounded-[24px]"); // the platform's centered dialog
    expect(dialog.className).toContain("-translate-x-1/2");
    const input = within(dialog).getByLabelText("Quantity of Water bottle in pcs");
    await user.clear(input);
    await user.type(input, "60");
    await user.click(within(dialog).getByRole("button", { name: "Remove Flour" }));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((qtyBox("Water bottle", "pcs") as HTMLInputElement).value).toBe("60");
    expect((screen.getByRole("button", { name: "Add Flour" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("View List with nothing selected says so", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    await user.click(screen.getByRole("button", { name: /View List/ }));
    expect((await screen.findByRole("dialog")).textContent).toContain("No products selected yet");
  });

  describe("Scan Products", () => {
    const openScan = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole("button", { name: /Scan Products/ }));
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

  it("shows how much is available when more is asked for, and blocks saving", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    await pickClient(user);
    await addProduct(user, "Water bottle");
    await user.type(screen.getByLabelText("Order quantity of Water bottle in pcs"), "150");
    await user.click(screen.getByRole("button", { name: "Save Order" }));
    expect((await screen.findAllByRole("alert")).map((a) => a.textContent).join(" ")).toContain("Only 100 pcs available");
    expect(calls.some((c) => c.url === "/api/sales/orders")).toBe(false);
  });

  it("saves the order with the client, product ids and exact quantities, then opens Delivery Lists with a success message", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    await pickClient(user);
    await addProduct(user, "Water bottle");
    await addProduct(user, "Flour");
    await user.type(screen.getByLabelText("Order quantity of Water bottle in pcs"), "40");
    await user.type(screen.getByLabelText("Order quantity of Flour in kg"), "2.5");
    await user.click(screen.getByRole("button", { name: "Save Order" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/delivery-lists?created=SO-000001"));
    const post = calls.find((c) => c.url === "/api/sales/orders")!;
    expect(post.body).toEqual({ clientId: C1, lines: [{ productId: WATER, quantity: "40" }, { productId: FLOUR, quantity: "2.5" }] });
    expect(post.headers["Idempotency-Key"]).toMatch(/^ui-/);
  });

  it("requires a client and at least one product", async () => {
    const user = userEvent.setup();
    render(<CreateOrderForm clients={clients as any} />);
    await user.click(screen.getByRole("button", { name: "Save Order" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Choose the client");
    await pickClient(user);
    await user.click(screen.getByRole("button", { name: "Save Order" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Add at least one product");
    expect(calls.some((c) => c.url === "/api/sales/orders")).toBe(false);
  });

  it("saving twice sends the SAME key; changing the order sends a new one", async () => {
    const user = userEvent.setup();
    handlers["POST /api/sales/orders"] = () => json(409, { error: "Only 100 pcs of Water bottle are available." });
    render(<CreateOrderForm clients={clients as any} />);
    await pickClient(user);
    await addProduct(user, "Water bottle");
    await user.type(screen.getByLabelText("Order quantity of Water bottle in pcs"), "40");
    await user.click(screen.getByRole("button", { name: "Save Order" }));
    await screen.findByText("Only 100 pcs of Water bottle are available.");
    await user.click(screen.getByRole("button", { name: "Save Order" }));
    await user.type(screen.getByLabelText("Order quantity of Water bottle in pcs"), "{backspace}");
    await user.click(screen.getByRole("button", { name: "Save Order" }));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/sales/orders")).toHaveLength(3));
    const keys = calls.filter((c) => c.url === "/api/sales/orders").map((c) => c.headers["Idempotency-Key"]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("an unconfirmed booking (202) is said plainly and can be retried with the same key", async () => {
    const user = userEvent.setup();
    handlers["POST /api/sales/orders"] = () => json(202, { order: { id: O1, number: "SO-000007" }, pending: true });
    render(<CreateOrderForm clients={clients as any} />);
    await pickClient(user);
    await addProduct(user, "Water bottle");
    await user.type(screen.getByLabelText("Order quantity of Water bottle in pcs"), "10");
    await user.click(screen.getByRole("button", { name: "Save Order" }));
    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("SO-000007");
    expect(note.textContent).toContain("nothing is treated as booked");
    expect(router.push).not.toHaveBeenCalled();
    handlers["POST /api/sales/orders"] = () => json(200, { order: { id: O1, number: "SO-000007" }, replayed: true });
    await user.click(within(note).getByRole("button", { name: "Retry booking" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/delivery-lists?created=SO-000007"));
    const keys = calls.filter((c) => c.url === "/api/sales/orders").map((c) => c.headers["Idempotency-Key"]);
    expect(new Set(keys).size).toBe(1);
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
    for (const text of ["Acme Ltd", "SO-000001", "DL-000001", "2026-11-09 10:00 UTC", "Ready for dispatch", "Stock reserved"]) expect(card.textContent, text).toContain(text);
    expect(within(card).getAllByRole("button").map((b) => b.textContent)).toEqual(["Edit", "Remove", "View List"]);
    const partly = screen.getByText("SO-000002").closest("[data-order]") as HTMLElement;
    expect(partly.textContent).toContain("Partially delivered");
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

  it("Delivered History lists finished orders with their expiry and only a View List action, and says what the 24 hours mean", () => {
    const done = { ok: true as const, items: [summary(O1, "SO-000001", L1, "DL-000001", { status: "delivered", reservation_status: "consumed", delivery_list: { id: L1, number: "DL-000001", status: "dispatched" }, completed_at: "2026-11-09T12:00:00+00:00", history_expires_at: "2026-11-10T12:00:00+00:00" })], total: 1, limit: 100, offset: 0 };
    board({ view: "history", orders: done as any, others: null });
    const card = screen.getByText("SO-000001").closest("[data-order]") as HTMLElement;
    expect(within(card).getAllByRole("button").map((b) => b.textContent)).toEqual(["View List"]);
    expect(card.textContent).toContain("2026-11-10 12:00 UTC");
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
      expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ version: 1, lines: [{ productId: WATER, quantity: "250" }, { productId: FLOUR, quantity: "5" }] });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(router.refresh).toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toContain("SO-000001 was updated");
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
