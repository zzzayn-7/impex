// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));
vi.mock("@/lib/camera", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/camera")>()),
  createBrowserDecoder: async () => ({ name: "fake", decode: async () => null }),
}));

import DeliveryListDetail from "@/app/delivery-lists/[id]/delivery-list-detail";
import DeliveryListIndex from "@/app/delivery-lists/delivery-list-index";
import ClientManager from "@/app/clients/client-manager";
import ScanProduct from "@/app/scan/scan-product";

const now = "2026-11-05T10:00:00+00:00";
const BOLT = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const FLOUR = "7a1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const L1 = "a0000000-0000-4000-8000-000000000001";
const L2 = "a0000000-0000-4000-8000-000000000002";
const C1 = "c0000000-0000-4000-8000-000000000001";
const ITEM1 = "e0000000-0000-4000-8000-000000000001";

const product = (id: string, sku: string, name: string, unit: string, extra: Record<string, unknown> = {}) => ({
  id, sku, name, description: null, category: "G", unit, unit_allows_fractions: unit === "kg", unit_locked: true, hs_code: null, cost_price: "1", selling_price: "2", currency_code: "USD",
  is_active: true, created_at: now, updated_at: now, ...extra,
});
const result = (p: ReturnType<typeof product>, total: string) => ({
  matched_by: "sku", identifier_kind: null, product: p,
  stock: { product_id: p.id, sku: p.sku, name: p.name, category: "G", unit: p.unit, unit_allows_fractions: p.unit === "kg", is_active: p.is_active, total_quantity: total },
});
const CATALOG: Record<string, any> = {
  "BOLT-1": result(product(BOLT, "BOLT-1", "Steel bolt", "pcs"), "50.0000"),
  FLOUR: result(product(FLOUR, "FLOUR", "Flour", "kg"), "2.5000"),
  "OLD-1": result(product(BOLT, "OLD-1", "Old bolt", "pcs", { is_active: false }), "0"),
};
const summary = (id: string, number: string, client: string, count: number, extra: Record<string, unknown> = {}) => ({
  id, number, client: { id: C1, name: client, is_active: true }, external_reference: null, status: "draft", notes: null, item_count: count,
  created_by_email: "a@b.c", created_at: now, updated_at: now, ...extra,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; body: any };
let calls: Call[];
let server: { drafts: any[]; clients: any[]; addItem: (listId: string, body: any) => Response; patchItem: (body: any) => Response; increase: (body: any) => Response; createList?: (body: any) => Response; createClient?: (body: any) => Response };

function stub() {
  calls = [];
  server = {
    drafts: [summary(L1, "DL-000001", "Acme Ltd", 2), summary(L2, "DL-000002", "Beta GmbH", 0)],
    clients: [{ id: C1, name: "Acme Ltd", is_active: true }],
    addItem: () => json(201, { item: { id: ITEM1, quantity: "12.0000" }, item_count: 3 }),
    patchItem: () => json(200, { item: { id: ITEM1, quantity: "3.0000" }, item_count: 2 }),
    increase: () => json(200, { item: { id: ITEM1, quantity: "8.0000" }, item_count: 2 }),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method ?? "GET", body });
    if (url.startsWith("/api/scan/resolve")) {
      const code = decodeURIComponent(url.split("code=")[1]);
      return CATALOG[code] ? json(200, CATALOG[code]) : json(404, { error: "No product in your catalog matches this code." });
    }
    if (url.startsWith("/api/sales/delivery-lists?")) return json(200, { items: server.drafts, total: server.drafts.length, limit: 100, offset: 0 });
    if (url.startsWith("/api/sales/clients?")) return json(200, { items: server.clients, total: server.clients.length, limit: 200, offset: 0 });
    if (url === "/api/sales/clients" && init.method === "POST") return server.createClient ? server.createClient(body) : json(201, { client: { id: "c-new", name: body.name, is_active: true } });
    if (url === "/api/sales/delivery-lists" && init.method === "POST") return server.createList ? server.createList(body) : json(201, { list: summary("a0000000-0000-4000-8000-0000000000ff", "DL-000003", "Acme Ltd", 0) });
    if (/\/clients\/[^/]+\/(activate|deactivate)$/.test(url)) return json(200, { client: {} });
    if (/\/items\/[^/]+\/increase$/.test(url)) return server.increase(body);
    if (/\/items\/[^/]+$/.test(url) && init.method === "PATCH") return server.patchItem(body);
    if (/\/items\/[^/]+$/.test(url) && init.method === "DELETE") return json(200, { removed: true });
    if (/\/items$/.test(url) && init.method === "POST") return server.addItem(url.split("/")[4], body);
    if (/\/(ready|cancel|reopen)$/.test(url)) return json(200, { list: {} });
    if (url.startsWith("/api/sales/delivery-lists/") && init.method === "PATCH") return json(200, { list: {} });
    return json(404, { error: "not found" });
  }));
}
const itemCalls = () => calls.filter((c) => /\/items/.test(c.url) && c.method !== "GET");
const stockCalls = () => calls.filter((c) => c.url.startsWith("/api/stock/"));
const scanBox = () => screen.getByLabelText(/Scan or type a barcode/i) as HTMLInputElement;

beforeEach(() => {
  router.replace.mockReset(); router.refresh.mockReset(); router.push.mockReset();
  stub();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function scan(user: ReturnType<typeof userEvent.setup>, code: string) {
  await user.type(scanBox(), `${code}{Enter}`);
}
async function openDeliverables(user: ReturnType<typeof userEvent.setup>, code = "BOLT-1", props: Partial<React.ComponentProps<typeof ScanProduct>> = {}) {
  render(<ScanProduct {...props} />);
  await scan(user, code);
  await screen.findByRole("region", { name: "Scanned product" });
  await user.click(screen.getByRole("button", { name: "Add to Deliverables" }));
  return screen.findByRole("region", { name: "Add to Deliverables" });
}

describe("Scan Product: actions", () => {
  it("prioritises Stock In, Stock Out, Add to Deliverables and Prepare Dispatch; there are no transfers", async () => {
    const user = userEvent.setup();
    render(<ScanProduct />);
    await scan(user, "BOLT-1");
    const group = await screen.findByRole("group", { name: "Actions" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Stock In", "Stock Out", "Add to Deliverables", "Prepare Dispatch"]);
    expect(screen.queryByRole("button", { name: "Transfer" })).toBeNull();
  });

  it("Add to Deliverables is not offered for an archived product", async () => {
    const user = userEvent.setup();
    render(<ScanProduct />);
    await scan(user, "OLD-1");
    await screen.findByText(/This product is archived/);
    expect(screen.queryByRole("button", { name: "Add to Deliverables" })).toBeNull();
  });

  it("every action is available straight away: nothing waits for a warehouse", async () => {
    const user = userEvent.setup();
    render(<ScanProduct />);
    await scan(user, "BOLT-1");
    await screen.findByRole("region", { name: "Scanned product" });
    expect((screen.getByRole("button", { name: "Add to Deliverables" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Stock In" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Scan Product: Add to Deliverables", () => {
  it("loads the administrator's draft lists and makes them choose one (nothing is assumed)", async () => {
    const user = userEvent.setup();
    const panel = await openDeliverables(user);
    const select = await within(panel).findByLabelText("Delivery list");
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
      "Choose a draft list…", "DL-000001 · Acme Ltd · 2 items", "DL-000002 · Beta GmbH · 0 items", "＋ Create a new delivery list…",
    ]);
    expect((select as HTMLSelectElement).value).toBe("");
    expect(within(panel).queryByRole("form", { name: /^Add Steel bolt/ })).toBeNull(); // no list yet, no quantity form
    expect(calls.map((c) => c.url).filter((u) => u.startsWith("/api/sales"))).toEqual(["/api/sales/delivery-lists?status=draft&limit=100", "/api/sales/clients?status=active&limit=200"]);
  });

  it("shows the product, its unit and the CURRENT stock, and the 'not reserved' explanation", async () => {
    const user = userEvent.setup();
    const panel = await openDeliverables(user);
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), L1);
    const form = within(panel).getByRole("form", { name: "Add Steel bolt to DL-000001" });
    expect(form.textContent).toContain("Steel bolt");
    expect(form.textContent).toContain("BOLT-1");
    expect(form.textContent).toContain("Unit: pcs");
    expect(form.textContent).toContain("whole numbers only");
    expect(within(form).getByTestId("availability").textContent).toContain("In stock now: 50 pcs");
    expect(form.textContent).toContain("Stock is not reserved");
    expect(form.textContent).toContain("never changes inventory");
  });

  it("adds the product with the typed quantity: one request, exactly the id and the quantity, nothing for stock", async () => {
    const user = userEvent.setup();
    const panel = await openDeliverables(user);
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), L1);
    const form = within(panel).getByRole("form", { name: /^Add Steel bolt/ });
    await user.type(within(form).getByLabelText(/^Quantity to deliver/), "12");
    await user.click(within(form).getByRole("button", { name: "Add to delivery list" }));
    await screen.findByText("Added 12 pcs of Steel bolt to DL-000001.");
    expect(itemCalls()).toEqual([{ url: `/api/sales/delivery-lists/${L1}/items`, method: "POST", body: { productId: BOLT, quantity: "12" } }]);
    expect(stockCalls()).toHaveLength(0); // inventory was never asked to change
    expect(JSON.stringify(itemCalls()[0].body)).not.toMatch(/name|sku|unit|stock|organization|tenant/i);
  });

  it("remembers the list for the next product (the bar), and preselects it", async () => {
    const user = userEvent.setup();
    let panel = await openDeliverables(user);
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), L1);
    await user.type(within(panel).getByLabelText(/^Quantity to deliver/), "12");
    await user.click(within(panel).getByRole("button", { name: "Add to delivery list" }));
    const bar = await screen.findByRole("status", { name: "Active delivery list" });
    expect(bar.textContent).toContain("DL-000001");
    expect(bar.textContent).toContain("Acme Ltd");
    expect(bar.textContent).toContain("3 items");

    await scan(user, "FLOUR");
    await screen.findByText("Flour");
    await user.click(screen.getByRole("button", { name: "Add to Deliverables" }));
    panel = await screen.findByRole("region", { name: "Add to Deliverables" });
    await waitFor(() => expect((within(panel).getByLabelText("Delivery list") as HTMLSelectElement).value).toBe(L1));
    expect(within(panel).getByRole("form", { name: "Add Flour to DL-000001" })).toBeTruthy();
  });

  it("several products can be added to one list by scanning one after another", async () => {
    const user = userEvent.setup();
    let panel = await openDeliverables(user);
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), L1);
    await user.type(within(panel).getByLabelText(/^Quantity to deliver/), "12");
    await user.click(within(panel).getByRole("button", { name: "Add to delivery list" }));
    await screen.findByText(/Added 12 pcs of Steel bolt/);
    await scan(user, "FLOUR");
    await screen.findByText("Flour");
    await user.click(screen.getByRole("button", { name: "Add to Deliverables" }));
    panel = await screen.findByRole("region", { name: "Add to Deliverables" });
    await waitFor(() => within(panel).getByRole("form", { name: /^Add Flour/ }));
    await user.type(within(panel).getByLabelText(/^Quantity to deliver/), "1.5");
    await user.click(within(panel).getByRole("button", { name: "Add to delivery list" }));
    await screen.findByText("Added 1.5 kg of Flour to DL-000001.");
    expect(itemCalls().map((c) => c.body)).toEqual([{ productId: BOLT, quantity: "12" }, { productId: FLOUR, quantity: "1.5" }]);
  });

  it("preselects the list it was opened for (?list=)", async () => {
    const user = userEvent.setup();
    const panel = await openDeliverables(user, "BOLT-1", { initialListId: L2 });
    await waitFor(() => expect((within(panel).getByLabelText("Delivery list") as HTMLSelectElement).value).toBe(L2));
  });

  it("is the user who types the quantity: nothing is added until they do, and 'Add' stays disabled while empty", async () => {
    const user = userEvent.setup();
    const panel = await openDeliverables(user);
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), L1);
    expect((within(panel).getByRole("button", { name: "Add to delivery list" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(panel).getByLabelText(/^Quantity to deliver/) as HTMLInputElement).value).toBe(""); // no default of 1
    expect(itemCalls()).toHaveLength(0);
  });

  it.each([["1.5", /whole number/], ["0", /greater than zero/], ["-2", /positive number/], ["abc", /positive number/], ["1.00001", /positive number/]])(
    "refuses the quantity %j before sending anything", async (value, message) => {
      const user = userEvent.setup();
      const panel = await openDeliverables(user);
      await user.selectOptions(await within(panel).findByLabelText("Delivery list"), L1);
      await user.type(within(panel).getByLabelText(/^Quantity to deliver/), value);
      await within(panel).findAllByText(message);
      await user.click(within(panel).getByRole("button", { name: "Add to delivery list" }));
      expect(itemCalls()).toHaveLength(0);
    });

  it("accepts decimals for a measurable unit", async () => {
    const user = userEvent.setup();
    const panel = await openDeliverables(user, "FLOUR");
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), L1);
    await user.type(within(panel).getByLabelText(/^Quantity to deliver/), "0.25");
    expect(within(panel).queryByRole("alert")).toBeNull();
  });

  it("warns when the quantity exceeds what is in stock, but still lets it be added", async () => {
    const user = userEvent.setup();
    const panel = await openDeliverables(user);
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), L1);
    await user.type(within(panel).getByLabelText(/^Quantity to deliver/), "100");
    const warning = await within(panel).findByText(/is more than the 50 pcs available/);
    expect(warning.textContent).toContain("short by 50");
    expect(warning.textContent).toContain("not reserved");
    await user.click(within(panel).getByRole("button", { name: "Add to delivery list" }));
    await screen.findByText(/Added 100 pcs of Steel bolt/);
  });

  it("does not warn when it fits (exactly the amount in stock)", async () => {
    const user = userEvent.setup();
    const panel = await openDeliverables(user);
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), L1);
    await user.type(within(panel).getByLabelText(/^Quantity to deliver/), "50");
    expect(within(panel).queryByText(/is more than/)).toBeNull();
  });

  it("creates a new list for an existing client, then adds the product to it", async () => {
    const user = userEvent.setup();
    const panel = await openDeliverables(user);
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), "__new__");
    const form = within(panel).getByRole("form", { name: "New delivery list" });
    await user.selectOptions(within(form).getByLabelText("Client"), C1);
    await user.type(within(form).getByLabelText(/order reference/), "PO-77");
    server.drafts = [...server.drafts, summary("a0000000-0000-4000-8000-0000000000ff", "DL-000003", "Acme Ltd", 0)];
    await user.click(within(form).getByRole("button", { name: "Create list" }));
    const addForm = await within(panel).findByRole("form", { name: "Add Steel bolt to DL-000003" });
    expect(calls.find((c) => c.url === "/api/sales/delivery-lists" && c.method === "POST")!.body).toEqual({ clientId: C1, externalReference: "PO-77" });
    expect(itemCalls()).toHaveLength(0); // creating a list adds nothing yet
    await user.type(within(addForm).getByLabelText(/^Quantity to deliver/), "5");
    await user.click(within(addForm).getByRole("button", { name: "Add to delivery list" }));
    await screen.findByText("Added 5 pcs of Steel bolt to DL-000003.");
    expect(itemCalls()[0].url).toBe("/api/sales/delivery-lists/a0000000-0000-4000-8000-0000000000ff/items");
  });

  it("registers a new client on the spot when creating a list", async () => {
    const user = userEvent.setup();
    server.drafts = [];
    const panel = await openDeliverables(user);
    const form = await within(panel).findByRole("form", { name: "New delivery list" }); // no drafts: it goes straight to creating one
    await user.type(within(form).getByLabelText(/register a new client/), "Brand New GmbH");
    server.drafts = [summary("a0000000-0000-4000-8000-0000000000ff", "DL-000003", "Brand New GmbH", 0)];
    await user.click(within(form).getByRole("button", { name: "Create list" }));
    await within(panel).findByRole("form", { name: "Add Steel bolt to DL-000003" });
    const sales = calls.filter((c) => c.method === "POST").map((c) => [c.url, c.body]);
    expect(sales).toEqual([["/api/sales/clients", { name: "Brand New GmbH" }], ["/api/sales/delivery-lists", { clientId: "c-new", externalReference: "" }]]);
  });

  it("asks for a client when creating a list", async () => {
    const user = userEvent.setup();
    const panel = await openDeliverables(user);
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), "__new__");
    await user.click(within(panel).getByRole("button", { name: "Create list" }));
    expect((await within(panel).findByRole("alert")).textContent).toContain("Choose the client");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("shows the server's message when the client is inactive", async () => {
    server.createList = () => json(409, { error: "Acme Ltd is inactive. Reactivate the client before creating a delivery list for them." });
    const user = userEvent.setup();
    const panel = await openDeliverables(user);
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), "__new__");
    await user.selectOptions(within(panel).getByLabelText("Client"), C1);
    await user.click(within(panel).getByRole("button", { name: "Create list" }));
    expect((await within(panel).findByRole("alert")).textContent).toContain("inactive");
  });

  describe("a product that is already on the list", () => {
    const dup = { id: ITEM1, quantity: "5.0000", unit: "pcs", product_name: "Steel bolt" };
    beforeEach(() => {
      server.addItem = () => json(409, { error: "Steel bolt is already on this list.", code: "duplicate_item", item: dup });
    });
    async function reach(user: ReturnType<typeof userEvent.setup>, quantity = "3") {
      const panel = await openDeliverables(user);
      await user.selectOptions(await within(panel).findByLabelText("Delivery list"), L1);
      await user.type(within(panel).getByLabelText(/^Quantity to deliver/), quantity);
      await user.click(within(panel).getByRole("button", { name: "Add to delivery list" }));
      return { panel, dialog: await within(panel).findByRole("alertdialog", { name: "Already on this list" }) };
    }

    it("does NOT create a duplicate line or change the quantity: it explains and offers explicit choices", async () => {
      const { dialog } = await reach(userEvent.setup());
      expect(dialog.textContent).toContain("already on DL-000001 with 5 pcs");
      expect(dialog.textContent).toContain("Nothing was changed");
      expect(within(dialog).getByRole("button", { name: "Set quantity to 3 pcs" })).toBeTruthy();
      expect(within(dialog).getByRole("button", { name: "Increase by 3 (to 8 pcs)" })).toBeTruthy();
      expect(within(dialog).getByRole("button", { name: "Leave it as it is" })).toBeTruthy();
      expect(itemCalls()).toHaveLength(1); // only the refused add; no PATCH, no increase
    });

    it("'Set quantity' sets it explicitly", async () => {
      const user = userEvent.setup();
      const { dialog } = await reach(user);
      await user.click(within(dialog).getByRole("button", { name: "Set quantity to 3 pcs" }));
      await screen.findByText(/is now 3 pcs/);
      expect(itemCalls().slice(1)).toEqual([{ url: `/api/sales/delivery-lists/${L1}/items/${ITEM1}`, method: "PATCH", body: { quantity: "3" } }]);
    });

    it("'Increase by' adds the typed amount explicitly", async () => {
      const user = userEvent.setup();
      const { dialog } = await reach(user);
      await user.click(within(dialog).getByRole("button", { name: "Increase by 3 (to 8 pcs)" }));
      await screen.findByText(/is now 8 pcs/);
      expect(itemCalls().slice(1)).toEqual([{ url: `/api/sales/delivery-lists/${L1}/items/${ITEM1}/increase`, method: "POST", body: { quantity: "3" } }]);
    });

    it("'Leave it as it is' changes nothing", async () => {
      const user = userEvent.setup();
      const { panel, dialog } = await reach(user);
      await user.click(within(dialog).getByRole("button", { name: "Leave it as it is" }));
      expect(within(panel).queryByRole("alertdialog")).toBeNull();
      expect(itemCalls()).toHaveLength(1);
    });

    it("scanning the same product again and pressing Add again still never increments anything by itself", async () => {
      const user = userEvent.setup();
      const { panel } = await reach(user);
      await user.click(within(panel).getByRole("button", { name: "Leave it as it is" }));
      await user.click(within(panel).getByRole("button", { name: "Add to delivery list" }));
      await within(panel).findByRole("alertdialog");
      expect(itemCalls().every((c) => c.method === "POST" && c.url.endsWith("/items"))).toBe(true); // only refused adds
    });
  });

  it("repeated scans of the same label add nothing to any list", async () => {
    const user = userEvent.setup();
    const panel = await openDeliverables(user);
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), L1);
    await scan(user, "BOLT-1");
    await scan(user, "BOLT-1");
    await scan(user, "BOLT-1");
    expect(itemCalls()).toHaveLength(0);
    expect(stockCalls()).toHaveLength(0);
  });

  it.each([
    [404, "Product not found.", /Product not found/], [409, "Steel bolt is archived and cannot be added to a delivery list.", /archived/],
    [503, "The inventory service is unavailable, so products cannot be checked right now.", /inventory service is unavailable/], [403, "Your organization is not active.", /not active/],
  ])("shows the service's answer %i and keeps the quantity", async (status, error, pattern) => {
    server.addItem = () => json(status, { error });
    const user = userEvent.setup();
    const panel = await openDeliverables(user);
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), L1);
    await user.type(within(panel).getByLabelText(/^Quantity to deliver/), "4");
    await user.click(within(panel).getByRole("button", { name: "Add to delivery list" }));
    expect((await within(panel).findByRole("alert")).textContent).toMatch(pattern);
    expect((within(panel).getByLabelText(/^Quantity to deliver/) as HTMLInputElement).value).toBe("4");
  });

  it("a double click on Add sends one request", async () => {
    let release!: () => void;
    server.addItem = () => new Promise<Response>((resolve) => { release = () => resolve(json(201, { item: {}, item_count: 3 })); }) as unknown as Response;
    const user = userEvent.setup();
    const panel = await openDeliverables(user);
    await user.selectOptions(await within(panel).findByLabelText("Delivery list"), L1);
    await user.type(within(panel).getByLabelText(/^Quantity to deliver/), "4");
    await user.dblClick(within(panel).getByRole("button", { name: "Add to delivery list" }));
    expect(itemCalls()).toHaveLength(1);
    release();
    await screen.findByText(/Added 4 pcs/);
    expect(itemCalls()).toHaveLength(1);
  });

  it("goes to sign-in again if the session has ended while loading the lists", async () => {
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any) => (String(input).startsWith("/api/sales/delivery-lists?") ? json(401, { error: "Your session has expired. Please sign in again." }) : (original as any)(input, init))));
    const user = userEvent.setup();
    render(<ScanProduct />);
    await scan(user, "BOLT-1");
    await screen.findByRole("region", { name: "Scanned product" });
    await user.click(screen.getByRole("button", { name: "Add to Deliverables" }));
    expect((await screen.findByRole("alert")).textContent).toContain("session has expired");
  });
});

// =============================================================================================================
describe("Delivery list detail", () => {
  const item = (extra: Record<string, unknown> = {}) => ({
    id: ITEM1, product_id: BOLT, product_sku: "BOLT-1", product_name: "Steel bolt", quantity: "12.0000", unit: "pcs",
    created_at: now, updated_at: now,
    stock: { total_quantity: "40.0000", product_active: true, unit_allows_fractions: false, exceeds_available: false, shortfall: "0" }, ...extra,
  });
  const list = (extra: Record<string, unknown> = {}) => ({ ...summary(L1, "DL-000001", "Acme Ltd", 1), items: [item()], stock_status: "ok", items_exceeding_stock: 0, stock_notice: "Stock is not reserved by a delivery list.", ...extra });

  it("shows the list, its products and quantities, available stock, and the notice", () => {
    render(<DeliveryListDetail list={list() as any} />);
    expect(screen.getByText("DL-000001")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("Stock is not reserved");
    const products = screen.getByRole("region", { name: "Products on this list" });
    expect(products.textContent).toContain("Steel bolt");
    expect(products.textContent).toContain("12 pcs");
    expect(products.textContent).toContain("40 pcs");
  });

  it("warns about lines that exceed availability, without blocking anything", () => {
    const l = list({ items: [item({ stock: { total_quantity: "5.0000", product_active: true, unit_allows_fractions: false, exceeds_available: true, shortfall: "7.0000" } })], items_exceeding_stock: 1 });
    render(<DeliveryListDetail list={l as any} />);
    expect(screen.getByText(/short by 7/)).toBeTruthy();
    expect(screen.getByText(/asks for more than is available/).textContent).toContain("nothing is reserved");
    expect((screen.getByRole("button", { name: "Mark Ready" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says so when stock cannot be loaded, while still showing the list", () => {
    render(<DeliveryListDetail list={list({ stock_status: "unavailable", items: [item({ stock: null })] }) as any} />);
    expect(screen.getByText(/Current stock could not be loaded/)).toBeTruthy();
    expect(screen.getByText("Steel bolt")).toBeTruthy();
  });

  it("edits a quantity: validated first, then one PATCH with the exact string", async () => {
    const user = userEvent.setup();
    render(<DeliveryListDetail list={list() as any} />);
    await user.click(screen.getByRole("button", { name: "Edit quantity of Steel bolt" }));
    const input = screen.getByLabelText("Quantity of Steel bolt");
    await user.clear(input);
    await user.type(input, "1.5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("whole number");
    expect(itemCalls()).toHaveLength(0);
    await user.clear(input);
    await user.type(input, "20{Enter}");
    await screen.findByText(/Steel bolt is now 20 pcs/);
    expect(itemCalls()).toEqual([{ url: `/api/sales/delivery-lists/${L1}/items/${ITEM1}`, method: "PATCH", body: { quantity: "20" } }]);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("removes a line only after confirmation", async () => {
    const user = userEvent.setup();
    render(<DeliveryListDetail list={list() as any} />);
    await user.click(screen.getByRole("button", { name: "Remove Steel bolt" }));
    expect(itemCalls()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Yes" }));
    await screen.findByText("Steel bolt was removed from DL-000001.");
    expect(itemCalls()).toEqual([{ url: `/api/sales/delivery-lists/${L1}/items/${ITEM1}`, method: "DELETE", body: undefined }]);
  });

  it("marks Ready with one POST, and says that no stock was deducted or reserved", async () => {
    const user = userEvent.setup();
    render(<DeliveryListDetail list={list() as any} />);
    await user.click(screen.getByRole("button", { name: "Mark Ready" }));
    expect((await screen.findByRole("status")).textContent).toContain("No stock was deducted or reserved");
    expect(calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.url])).toEqual([["POST", `/api/sales/delivery-lists/${L1}/ready`]]);
    expect(stockCalls()).toHaveLength(0);
  });

  it("cannot be marked Ready while empty", () => {
    render(<DeliveryListDetail list={list({ items: [], item_count: 0 }) as any} />);
    expect((screen.getByRole("button", { name: "Mark Ready" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No products yet/)).toBeTruthy();
  });

  it("cancels only after confirmation", async () => {
    const user = userEvent.setup();
    render(<DeliveryListDetail list={list() as any} />);
    await user.click(screen.getByRole("button", { name: "Cancel list" }));
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Yes, cancel" }));
    await screen.findByText(/was cancelled\. Nothing was deleted and no stock was involved/);
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.url)).toEqual([`/api/sales/delivery-lists/${L1}/cancel`]);
  });

  it("shows a refusal (e.g. an archived product) instead of pretending it worked", async () => {
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any) => (String(input).endsWith("/ready") ? json(409, { error: "These products are no longer available (archived or missing): Steel bolt (BOLT-1)." }) : (original as any)(input, init))));
    const user = userEvent.setup();
    render(<DeliveryListDetail list={list() as any} />);
    await user.click(screen.getByRole("button", { name: "Mark Ready" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no longer available");
  });

  it("flags an archived product on a line", () => {
    render(<DeliveryListDetail list={list({ items: [item({ stock: { total_quantity: "0", product_active: false, unit_allows_fractions: false, exceeds_available: true, shortfall: "12" } })] }) as any} />);
    expect(screen.getByText(/Archived product: remove it before marking the list Ready/)).toBeTruthy();
  });

  it("finds a product by SKU or barcode (typed or scanned into the box) and adds it with an explicit quantity", async () => {
    const user = userEvent.setup();
    render(<DeliveryListDetail list={list() as any} />);
    expect(screen.getByRole("link", { name: "Scan products for this list" }).getAttribute("href")).toBe(`/scan?list=${L1}`);
    await user.click(screen.getByRole("button", { name: "Type a SKU or barcode" }));
    await user.type(screen.getByLabelText("SKU or barcode"), "flour{Enter}");
    const form = await screen.findByRole("form", { name: "Add Flour to DL-000001" });
    expect(form.textContent).toContain("In stock now: 2.5 kg");
    await user.type(within(form).getByLabelText(/^Quantity to deliver/), "1.5");
    await user.click(within(form).getByRole("button", { name: "Add to delivery list" }));
    await screen.findByText("Added 1.5 kg of Flour to DL-000001.");
    expect(itemCalls()).toEqual([{ url: `/api/sales/delivery-lists/${L1}/items`, method: "POST", body: { productId: FLOUR, quantity: "1.5" } }]);
  });

  it("reports an unknown or archived product when looking up manually", async () => {
    const user = userEvent.setup();
    render(<DeliveryListDetail list={list() as any} />);
    await user.click(screen.getByRole("button", { name: "Type a SKU or barcode" }));
    await user.type(screen.getByLabelText("SKU or barcode"), "NOPE{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("No product in your catalog matches");
    await user.clear(screen.getByLabelText("SKU or barcode"));
    await user.type(screen.getByLabelText("SKU or barcode"), "OLD-1{Enter}");
    expect((await screen.findByText(/is archived and cannot be added/)).textContent).toContain("Old bolt");
    expect(itemCalls()).toHaveLength(0);
  });

  it("refuses a pasted web link in the manual lookup without asking the server", async () => {
    const user = userEvent.setup();
    render(<DeliveryListDetail list={list() as any} />);
    await user.click(screen.getByRole("button", { name: "Type a SKU or barcode" }));
    await user.type(screen.getByLabelText("SKU or barcode"), "https://evil.example/x{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("not opened");
    expect(calls).toHaveLength(0);
  });

  it("saves the reference and notes of a draft", async () => {
    const user = userEvent.setup();
    render(<DeliveryListDetail list={list() as any} />);
    await user.click(screen.getByRole("button", { name: "Type a SKU or barcode" }));
    const form = screen.getByRole("form", { name: "Reference and notes" });
    await user.type(within(form).getByLabelText("Your order reference"), "PO-9");
    await user.click(within(form).getByRole("button", { name: "Save reference & notes" }));
    await screen.findByText("Reference and notes saved.");
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ externalReference: "PO-9", notes: "" });
  });

  it("a Ready list can be reopened but not edited; a cancelled one has no actions", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DeliveryListDetail list={list({ status: "ready" }) as any} />);
    expect(screen.queryByRole("button", { name: "Mark Ready" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Steel bolt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit quantity of Steel bolt" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Add a product" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reopen as draft" }));
    await screen.findByText(/is a draft again/);
    unmount();
    render(<DeliveryListDetail list={list({ status: "cancelled" }) as any} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

// =============================================================================================================
describe("Delivery lists index", () => {
  const clients = [{ id: C1, name: "Acme Ltd", contact_person: null, email: null, phone: null, address: null, is_active: true, created_at: now, updated_at: now }];
  const base = { q: "", clientId: "", status: "" as const, page: 1 };

  it("creates a list for an existing client and opens it", async () => {
    const user = userEvent.setup();
    render(<DeliveryListIndex list={{ ok: true, items: [], total: 0, limit: 25, offset: 0 }} filters={base} clients={clients as any} />);
    await user.click(screen.getByRole("button", { name: "New Delivery List" }));
    const form = screen.getByRole("form", { name: "New delivery list" });
    await user.selectOptions(within(form).getByLabelText("Client"), C1);
    await user.type(within(form).getByLabelText(/order reference/), "PO-1");
    await user.click(within(form).getByRole("button", { name: "Create list" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/delivery-lists/a0000000-0000-4000-8000-0000000000ff"));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ clientId: C1, externalReference: "PO-1", notes: "" });
  });

  it("asks for a client, and only offers active clients for new lists but all clients as a filter", async () => {
    const user = userEvent.setup();
    const both = [...clients, { ...clients[0], id: "c2", name: "Dormant Co", is_active: false }];
    render(<DeliveryListIndex list={{ ok: true, items: [], total: 0, limit: 25, offset: 0 }} filters={base} clients={both as any} />);
    expect(within(screen.getByLabelText("Client")).getAllByRole("option").map((o) => o.textContent)).toEqual(["All clients", "Acme Ltd", "Dormant Co (inactive)"]);
    await user.click(screen.getByRole("button", { name: "New Delivery List" }));
    const form = screen.getByRole("form", { name: "New delivery list" });
    expect(within(within(form).getByLabelText("Client")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a client…", "Acme Ltd"]);
    await user.click(within(form).getByRole("button", { name: "Create list" }));
    expect((await within(form).findByRole("alert")).textContent).toContain("Choose a client");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("Clients", () => {
  const filters = { q: "", status: "active" as const, page: 1 };
  const acme = { id: C1, name: "Acme Ltd", contact_person: "Jane", email: "j@a.example", phone: null, address: null, is_active: true, created_at: now, updated_at: now };

  it("registers a client", async () => {
    const user = userEvent.setup();
    render(<ClientManager list={{ ok: true, items: [], total: 0, limit: 25, offset: 0 }} filters={filters} />);
    await user.click(screen.getByRole("button", { name: "Add Client" }));
    const form = screen.getByRole("form", { name: "Add client" });
    await user.type(within(form).getByLabelText(/Client \/ company name/), "Globex");
    await user.click(within(form).getByRole("button", { name: "Register client" }));
    await screen.findByText("Globex was registered.");
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ url: "/api/sales/clients", body: expect.objectContaining({ name: "Globex" }) });
  });

  it("shows a duplicate name under the Name field", async () => {
    server.createClient = () => json(409, { error: "A client named 'Acme' already exists in your directory.", fieldErrors: { name: "A client named 'Acme' already exists in your directory." } });
    const user = userEvent.setup();
    render(<ClientManager list={{ ok: true, items: [acme], total: 1, limit: 25, offset: 0 }} filters={filters} />);
    await user.click(screen.getByRole("button", { name: "Add Client" }));
    const form = screen.getByRole("form", { name: "Add client" });
    await user.type(within(form).getByLabelText(/Client \/ company name/), "Acme");
    await user.click(within(form).getByRole("button", { name: "Register client" }));
    await waitFor(() => expect(within(form).getAllByText(/already exists/).length).toBeGreaterThan(0));
  });

  it("requires a name before sending anything", async () => {
    const user = userEvent.setup();
    render(<ClientManager list={{ ok: true, items: [], total: 0, limit: 25, offset: 0 }} filters={filters} />);
    await user.click(screen.getByRole("button", { name: "Add Client" }));
    await user.click(screen.getByRole("button", { name: "Register client" }));
    expect(await screen.findByText("Enter the client's name.")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("deactivates a client (no delete exists) and links to its delivery lists", async () => {
    const user = userEvent.setup();
    render(<ClientManager list={{ ok: true, items: [acme], total: 1, limit: 25, offset: 0 }} filters={filters} />);
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Delivery lists" }).getAttribute("href")).toBe(`/delivery-lists?client=${C1}`);
    server.createClient = undefined;
    await user.click(screen.getByRole("button", { name: "Deactivate Acme Ltd" }));
    await screen.findByText(/Acme Ltd was deactivated\. Its delivery lists are kept/);
    expect(calls.find((c) => c.method === "POST")!.url).toBe(`/api/sales/clients/${C1}/deactivate`);
  });
});
