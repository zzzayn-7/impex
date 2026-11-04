// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// The ZXing / BarcodeDetector decoder needs a real camera frame; tests swap in a decoder that "sees" one code.
const decoderState = { code: "IMX-ABC234DEFGHJ" as string | null };
vi.mock("@/lib/camera", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/camera")>()),
  createBrowserDecoder: async () => ({ name: "fake", decode: async () => decoderState.code }),
}));

import CameraScanner from "@/app/scan/camera-scanner";
import ScanProduct from "@/app/scan/scan-product";
import CodesManager from "@/app/products/[id]/codes/codes-manager";
import type { Warehouse } from "@/lib/stock-validation";

const BOLT_ID = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const FLOUR_ID = "7a1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const W_MAIN = "22222222-2222-4222-8222-222222222222";
const W_ANNEX = "33333333-3333-4333-8333-333333333333";
const now = "2026-11-05T10:00:00+00:00";

const warehouses: Warehouse[] = [
  { id: W_MAIN, code: "MAIN", name: "Main depot", address: null, is_active: true, created_at: now, updated_at: now, products_in_stock: 1 },
  { id: W_ANNEX, code: "ANNEX", name: "Annex", address: null, is_active: true, created_at: now, updated_at: now, products_in_stock: 0 },
];

const product = (id: string, sku: string, name: string, unit: string, extra: Record<string, unknown> = {}) => ({
  id, sku, name, description: null, category: "General", unit, unit_allows_fractions: unit === "kg", unit_locked: true, hs_code: null,
  cost_price: "1.0000", selling_price: "2.0000", currency_code: "USD", is_active: true, created_at: now, updated_at: now, ...extra,
});
const scanResult = (p: ReturnType<typeof product>, lines: any[], extra: Record<string, unknown> = {}) => ({
  matched_by: "identifier", identifier_kind: "generated", product: p,
  stock: {
    product_id: p.id, sku: p.sku, name: p.name, category: "General", unit: p.unit, unit_allows_fractions: p.unit === "kg", is_active: p.is_active,
    total_quantity: lines.reduce((sum, l) => sum + Number(l.quantity), 0).toFixed(4),
    available_quantity: lines.filter((l) => l.warehouse_active).reduce((sum, l) => sum + Number(l.quantity), 0).toFixed(4),
    lines,
  },
  ...extra,
});
const line = (id: string, code: string, name: string, quantity: string, active = true) => ({ warehouse_id: id, warehouse_code: code, warehouse_name: name, warehouse_active: active, quantity });

const bolt = product(BOLT_ID, "BOLT-1", "Steel bolt", "pcs");
const BOLT = scanResult(bolt, [line(W_MAIN, "MAIN", "Main depot", "40.0000"), line(W_ANNEX, "ANNEX", "Annex", "10.0000", false)]);
const FLOUR = scanResult(product(FLOUR_ID, "FLOUR", "Flour", "kg"), [line(W_MAIN, "MAIN", "Main depot", "2.5000")], { matched_by: "sku", identifier_kind: null });
const ARCHIVED = scanResult(product(BOLT_ID, "OLD-1", "Old bolt", "pcs", { is_active: false }), [line(W_MAIN, "MAIN", "Main depot", "3.0000")]);

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Calls = { url: string; init: any }[];
let calls: Calls;
const stockCalls = () => calls.filter((c) => c.url.startsWith("/api/stock/"));
const resolveCalls = () => calls.filter((c) => c.url.startsWith("/api/scan/resolve"));

function stubServer(handlers: { resolve?: (code: string) => Response; stock?: (action: string, body: any) => Response | Promise<Response> } = {}) {
  calls = [];
  const catalog: Record<string, unknown> = { "BOLT-1": BOLT, "IMX-ABC234DEFGHJ": BOLT, FLOUR, "OLD-1": ARCHIVED };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("/api/scan/resolve")) {
        const code = decodeURIComponent(url.split("code=")[1]);
        if (handlers.resolve) return handlers.resolve(code);
        return catalog[code] ? json(200, catalog[code]) : json(404, { error: "No product in your catalog matches this code." });
      }
      if (url.startsWith("/api/stock/")) {
        const action = url.split("/").pop()!;
        const body = JSON.parse(init.body);
        return handlers.stock ? handlers.stock(action, body) : json(201, { operation: { operation_id: "op", kind: action, replayed: false, movements: [] } });
      }
      return json(404, {});
    })
  );
}

const setup = () => userEvent.setup();
const scanBox = () => screen.getByLabelText(/Scan or type a barcode/i) as HTMLInputElement;

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  decoderState.code = "IMX-ABC234DEFGHJ";
  stubServer();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (navigator as any).mediaDevices;
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
});

// =============================================================================================================
describe("Scan Product: the scan box", () => {
  it("is focused when the page opens, so a USB/Bluetooth scanner can type straight into it", () => {
    render(<ScanProduct warehouses={warehouses} />);
    expect(document.activeElement).toBe(scanBox());
    expect(scanBox().autocomplete).toBe("off");
    expect(screen.getByText(/USB and Bluetooth scanners work as keyboards/)).toBeTruthy();
  });

  it("looks a product up when a keyboard-emulating scanner 'types' the code and presses Enter", async () => {
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.type(scanBox(), "bolt-1{Enter}"); // a scanner is exactly this, only faster
    await screen.findByText("Steel bolt");
    expect(resolveCalls().map((c) => c.url)).toEqual(["/api/scan/resolve?code=BOLT-1"]);
    expect(scanBox().value).toBe(""); // ready for the next scan
  });

  it("also works with the Look up button, for manual entry of a SKU or barcode", async () => {
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.type(scanBox(), "flour");
    await user.click(screen.getByRole("button", { name: "Look up" }));
    await screen.findByText("Flour");
    expect(resolveCalls()[0].url).toBe("/api/scan/resolve?code=FLOUR");
  });

  it("disables Look up while the box is empty", () => {
    render(<ScanProduct warehouses={warehouses} />);
    expect((screen.getByRole("button", { name: "Look up" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("ignores a repeated scanner event: the same code twice in a row looks up once", async () => {
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.type(scanBox(), "BOLT-1{Enter}");
    await user.type(scanBox(), "BOLT-1{Enter}");
    await screen.findByText("Steel bolt");
    expect(resolveCalls()).toHaveLength(1);
  });

  it("looks up again for a different code", async () => {
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.type(scanBox(), "BOLT-1{Enter}");
    await screen.findByText("Steel bolt");
    await user.type(scanBox(), "FLOUR{Enter}");
    await screen.findByText("Flour");
    expect(screen.queryByText("Steel bolt")).toBeNull();
    expect(resolveCalls()).toHaveLength(2);
  });
});

describe("Scan Product: what is shown after a scan", () => {
  it("shows name, SKU, unit, stock per warehouse, total, available and the three actions", async () => {
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.type(scanBox(), "IMX-ABC234DEFGHJ{Enter}");
    const card = await screen.findByRole("region", { name: "Scanned product" });
    const text = card.textContent!;
    for (const expected of ["Steel bolt", "BOLT-1", "Unit: pcs", "whole numbers only", "Impex label", "Total stock", "Available stock", "MAIN", "Main depot", "ANNEX", "(archived)"]) {
      expect(text, expected).toContain(expected);
    }
    expect(text).toContain("50 pcs"); // total: 40 + 10
    expect(within(card).getByText("Available stock").parentElement!.textContent).toContain("40 pcs"); // the archived warehouse's 10 is excluded
    expect(text).toContain("in active warehouses only");
    for (const name of ["Stock In", "Stock Out", "Transfer"]) expect(within(card).getByRole("button", { name })).toBeTruthy();
  });

  it("explains decimals for a measurable unit and a SKU match", async () => {
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.type(scanBox(), "FLOUR{Enter}");
    const card = await screen.findByRole("region", { name: "Scanned product" });
    expect(card.textContent).toContain("decimal quantities allowed");
    expect(card.textContent).toContain("found by SKU");
    expect(card.textContent).toContain("2.5 kg");
  });

  it("NEVER changes inventory just because a code was scanned", async () => {
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    for (const code of ["BOLT-1", "FLOUR", "NOPE", "OLD-1", "BOLT-1"]) await user.type(scanBox(), `${code}{Enter}`);
    expect(stockCalls()).toHaveLength(0);
    expect(calls.every((c) => c.url.startsWith("/api/scan/resolve"))).toBe(true);
    expect(calls.every((c) => (c.init.method ?? "GET") === "GET")).toBe(true);
  });

  it("says so for an unknown code, and shows no product", async () => {
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.type(scanBox(), "NOT-A-PRODUCT{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("No product in your catalog matches this code.");
    expect(screen.queryByRole("region", { name: "Scanned product" })).toBeNull();
  });

  it("clears an earlier result when the next scan finds nothing (no stale product to act on)", async () => {
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.type(scanBox(), "BOLT-1{Enter}");
    await screen.findByText("Steel bolt");
    await user.type(scanBox(), "NOT-A-PRODUCT{Enter}");
    await screen.findByRole("alert");
    expect(screen.queryByText("Steel bolt")).toBeNull();
  });

  it.each([
    [410, { error: "This barcode was retired and no longer identifies a product." }, "retired"],
    [409, { error: "ambiguous" }, "more than one product"],
    [403, { error: "Your organization is not active." }, "not active"],
    [503, { error: "x" }, "temporarily unavailable"],
  ])("shows a clear message for HTTP %i", async (status, body, expected) => {
    stubServer({ resolve: () => json(status as number, body) });
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.type(scanBox(), "BOLT-1{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain(expected);
  });

  it("sends the user to sign in again if the session has ended", async () => {
    stubServer({ resolve: () => json(401, { error: "expired" }) });
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.type(scanBox(), "BOLT-1{Enter}");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("treats a scanned web address as text: refused, not opened, not even sent to the server", async () => {
    const user = setup();
    const { container } = render(<ScanProduct warehouses={warehouses} />);
    await user.type(scanBox(), "https://evil.example/pay{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("not opened");
    expect(calls).toHaveLength(0);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.innerHTML).not.toContain("evil.example");
  });

  it("tells the user an archived product cannot be restocked from here", async () => {
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.type(scanBox(), "OLD-1{Enter}");
    const card = await screen.findByRole("region", { name: "Scanned product" });
    expect(card.textContent).toContain("Archived");
    expect(card.textContent).toContain("Restore it in Products before changing its stock");
    expect(within(card).queryByRole("button", { name: "Stock In" })).toBeNull();
    expect(card.textContent).toContain("3 pcs"); // but what is there is still reported
  });

  it("asks for a warehouse first when the organization has none", async () => {
    const user = setup();
    render(<ScanProduct warehouses={[]} />);
    await user.type(scanBox(), "BOLT-1{Enter}");
    const card = await screen.findByRole("region", { name: "Scanned product" });
    expect(card.textContent).toContain("Create a warehouse first");
    expect((within(card).getByRole("button", { name: "Stock In" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// =============================================================================================================
describe("Scan Product: changing stock reuses the Step 14 flow, with confirmation", () => {
  async function openForm(user: ReturnType<typeof setup>, action: "Stock In" | "Stock Out" | "Transfer", code = "BOLT-1") {
    render(<ScanProduct warehouses={warehouses} />);
    await user.type(scanBox(), `${code}{Enter}`);
    await screen.findByRole("region", { name: "Scanned product" });
    await user.click(screen.getByRole("button", { name: action }));
    return screen.getByRole("form", { name: action === "Transfer" ? "Transfer" : action === "Stock In" ? "Add stock" : "Remove stock" });
  }
  const fill = async (user: ReturnType<typeof setup>, form: HTMLElement, quantity: string, warehouse = W_MAIN) => {
    await user.selectOptions(within(form).getByLabelText("Warehouse"), warehouse);
    await user.type(within(form).getByLabelText(/^Quantity/), quantity);
  };

  it("offers only in / out / transfer, with the scanned product fixed", async () => {
    const user = setup();
    const form = await openForm(user, "Stock In");
    expect(within(form).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Add stock", "Remove stock", "Transfer"]);
    expect((within(form).getByLabelText(/^Product/) as HTMLSelectElement).disabled).toBe(true);
    expect((within(form).getByLabelText(/^Product/) as HTMLSelectElement).value).toBe(BOLT_ID);
    expect(within(form).getByLabelText("Warehouse").textContent).toContain("MAIN");
  });

  it("asks for confirmation first: pressing Review sends NOTHING", async () => {
    const user = setup();
    const form = await openForm(user, "Stock In");
    await fill(user, form, "5");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Confirm stock change" });
    expect(dialog.textContent).toContain("Add 5 pcs of Steel bolt to MAIN?");
    expect(dialog.textContent).toContain("recorded in the stock history");
    expect(stockCalls()).toHaveLength(0);
  });

  it("changes inventory only when Confirm is pressed, once, with an Idempotency-Key and no organization", async () => {
    const user = setup();
    const form = await openForm(user, "Stock In");
    await fill(user, form, "5");
    await user.type(within(form).getByLabelText(/^Reason/), "Delivery note 42");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    await screen.findByText(/Stock added\./);
    expect(stockCalls()).toHaveLength(1);
    const [{ url, init }] = stockCalls();
    expect(url).toBe("/api/stock/in");
    expect(init.method).toBe("POST");
    expect(init.headers["Idempotency-Key"]).toMatch(/^ui-[0-9a-f-]{36}$/);
    expect(JSON.parse(init.body)).toEqual({ product_id: BOLT_ID, warehouse_id: W_MAIN, quantity: "5", reason: "Delivery note 42" });
    expect(init.body).not.toMatch(/organization|tenant/i);
    await waitFor(() => expect(resolveCalls().length).toBeGreaterThanOrEqual(2)); // the quantities are refreshed afterwards
  });

  it("goes back without changing anything when the user says Back", async () => {
    const user = setup();
    const form = await openForm(user, "Stock Out");
    await fill(user, form, "5");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Back" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(stockCalls()).toHaveLength(0);
  });

  it("editing the form cancels a pending confirmation: what was summarised is no longer what is entered", async () => {
    const user = setup();
    const form = await openForm(user, "Stock Out");
    await fill(user, form, "5");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    await screen.findByRole("alertdialog");
    await user.type(within(form).getByLabelText(/^Quantity/), "0");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(stockCalls()).toHaveLength(0);
  });

  it("a stray Enter (e.g. from a scanner) while the question is showing does not confirm it", async () => {
    const user = setup();
    const form = await openForm(user, "Stock In");
    await fill(user, form, "5");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    await screen.findByRole("alertdialog");
    fireEvent.submit(form); // what Enter does in a form
    fireEvent.submit(form);
    expect(stockCalls()).toHaveLength(0);
  });

  it("a double click on Confirm sends one request", async () => {
    let release!: () => void;
    stubServer({ stock: () => new Promise<Response>((resolve) => (release = () => resolve(json(201, { operation: { replayed: false } })))) });
    const user = setup();
    const form = await openForm(user, "Stock In");
    await fill(user, form, "5");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    const confirm = await screen.findByRole("button", { name: "Confirm" });
    await user.dblClick(confirm);
    expect(stockCalls()).toHaveLength(1);
    release();
    await screen.findByText(/Stock added\./);
    expect(stockCalls()).toHaveLength(1);
  });

  it("a retry after a lost connection reuses the same Idempotency-Key, so the server applies it once", async () => {
    let attempt = 0;
    stubServer({
      stock: () => {
        attempt += 1;
        if (attempt === 1) throw new TypeError("network down"); // the request may or may not have reached the server
        return json(200, { operation: { operation_id: "op", kind: "in", replayed: true, movements: [] } });
      },
    });
    const user = setup();
    const form = await openForm(user, "Stock In");
    await fill(user, form, "5");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toContain("will not be applied twice");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    await screen.findByText(/already been applied/);
    const keys = stockCalls().map((c) => c.init.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("a different quantity is a different request with a new key", async () => {
    let attempt = 0;
    stubServer({ stock: () => { attempt += 1; if (attempt === 1) throw new TypeError("network down"); return json(201, { operation: {} }); } });
    const user = setup();
    const form = await openForm(user, "Stock In");
    await fill(user, form, "5");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    await screen.findByRole("alert");
    await user.clear(within(form).getByLabelText(/^Quantity/));
    await user.type(within(form).getByLabelText(/^Quantity/), "6");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    const keys = stockCalls().map((c) => c.init.headers["Idempotency-Key"]);
    expect(new Set(keys).size).toBe(2);
  });

  it("enforces whole numbers for indivisible units before asking for confirmation", async () => {
    const user = setup();
    const form = await openForm(user, "Stock In");
    await fill(user, form, "1.5");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect((await within(form).findByText(/Use a whole number/)).textContent).toContain("'pcs'");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(stockCalls()).toHaveLength(0);
  });

  it("allows decimals for a measurable unit", async () => {
    const user = setup();
    const form = await openForm(user, "Stock In", "FLOUR");
    await fill(user, form, "1.25");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect((await screen.findByRole("alertdialog")).textContent).toContain("Add 1.25 kg of Flour to MAIN?");
  });

  it.each(["0", "-3", "abc", "1.00001", ""])("rejects the quantity %j before confirmation", async (quantity) => {
    const user = setup();
    const form = await openForm(user, "Stock In");
    await user.selectOptions(within(form).getByLabelText("Warehouse"), W_MAIN);
    if (quantity) await user.type(within(form).getByLabelText(/^Quantity/), quantity);
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(stockCalls()).toHaveLength(0);
  });

  it("shows the server's refusal when a removal would make stock negative, and keeps the form", async () => {
    const message = "Insufficient stock: 40 pcs of Steel bolt available in MAIN, 100 requested.";
    stubServer({ stock: () => json(409, { error: message }) });
    const user = setup();
    const form = await openForm(user, "Stock Out");
    await fill(user, form, "100");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(within(form).getByLabelText(/^Quantity/)).toHaveProperty("value", "100"); // nothing lost, the user can correct it
  });

  it("transfers between two warehouses with a summary naming both", async () => {
    const user = setup();
    const form = await openForm(user, "Transfer");
    await user.selectOptions(within(form).getByLabelText("From warehouse"), W_MAIN);
    await user.selectOptions(within(form).getByLabelText("To warehouse"), W_ANNEX);
    await user.type(within(form).getByLabelText(/^Quantity/), "5");
    await user.click(within(form).getByRole("button", { name: "Review" }));
    expect((await screen.findByRole("alertdialog")).textContent).toContain("Transfer 5 pcs of Steel bolt from MAIN to ANNEX?");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText(/Stock transferred\./);
    expect(stockCalls().map((c) => c.url)).toEqual(["/api/stock/transfer"]);
    expect(JSON.parse(stockCalls()[0].init.body)).toEqual({ product_id: BOLT_ID, from_warehouse_id: W_MAIN, to_warehouse_id: W_ANNEX, quantity: "5" });
  });

  it("will not transfer to the same warehouse", async () => {
    const user = setup();
    const form = await openForm(user, "Transfer");
    await user.selectOptions(within(form).getByLabelText("From warehouse"), W_MAIN);
    // the destination list already leaves the source out
    expect(Array.from((within(form).getByLabelText("To warehouse") as HTMLSelectElement).options).map((o) => o.value)).not.toContain(W_MAIN);
  });

  it("closes the open form when a different product is scanned (it belonged to the previous one)", async () => {
    const user = setup();
    const form = await openForm(user, "Stock In");
    await fill(user, form, "5");
    await user.type(scanBox(), "FLOUR{Enter}");
    await screen.findByText("Flour");
    expect(screen.queryByRole("form", { name: "Add stock" })).toBeNull();
    expect(stockCalls()).toHaveLength(0);
  });
});

// =============================================================================================================
describe("Scan Product: camera", () => {
  function fakeCamera() {
    const tracks = [{ stop: vi.fn() }];
    const getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }));
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    HTMLMediaElement.prototype.play = vi.fn(async () => undefined) as any;
    HTMLMediaElement.prototype.pause = vi.fn() as any;
    return { tracks, getUserMedia };
  }

  it("does not touch the camera until the user presses Start camera", async () => {
    const { getUserMedia } = fakeCamera();
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.click(screen.getByRole("button", { name: "Use camera" }));
    expect(screen.getByRole("button", { name: "Start camera" })).toBeTruthy();
    expect(screen.getByText(/Your browser will ask for permission when you press Start camera/)).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Start camera" }));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("reads a code with the camera, looks the product up, and switches the camera off", async () => {
    const { tracks } = fakeCamera();
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.click(screen.getByRole("button", { name: "Use camera" }));
    await user.click(screen.getByRole("button", { name: "Start camera" }));
    await screen.findByText("Steel bolt", {}, { timeout: 3000 });
    expect(resolveCalls().map((c) => c.url)).toEqual(["/api/scan/resolve?code=IMX-ABC234DEFGHJ"]);
    expect(tracks[0].stop).toHaveBeenCalled(); // camera released
    expect(screen.queryByLabelText("Camera scanner")).toBeNull(); // and the camera panel closed
    expect(calls.every((c) => c.url.startsWith("/api/scan/resolve"))).toBe(true); // nothing but the text of the code went out
    expect(stockCalls()).toHaveLength(0);
  });

  it("turns the camera off when the user hides it", async () => {
    const { tracks } = fakeCamera();
    decoderState.code = null;
    const user = setup();
    render(<ScanProduct warehouses={warehouses} />);
    await user.click(screen.getByRole("button", { name: "Use camera" }));
    await user.click(screen.getByRole("button", { name: "Start camera" }));
    await screen.findByRole("button", { name: "Stop camera" });
    await user.click(screen.getByRole("button", { name: "Hide camera" }));
    expect(tracks[0].stop).toHaveBeenCalled();
  });
});

describe("CameraScanner on its own", () => {
  it("stops the camera when the component unmounts", async () => {
    const tracks = [{ stop: vi.fn() }];
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn(async () => ({ getTracks: () => tracks })) }, configurable: true });
    HTMLMediaElement.prototype.play = vi.fn(async () => undefined) as any;
    HTMLMediaElement.prototype.pause = vi.fn() as any;
    decoderState.code = null;
    const user = setup();
    const { unmount } = render(<CameraScanner onDetected={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Start camera" }));
    await screen.findByRole("button", { name: "Stop camera" });
    unmount();
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it("explains a refused permission and offers to try again", async () => {
    const getUserMedia = vi.fn(async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    const user = setup();
    render(<CameraScanner onDetected={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Start camera" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Camera access was blocked");
    expect(alert.textContent).toContain("USB/Bluetooth scanner");
    expect(screen.getByRole("button", { name: "Try the camera again" })).toBeTruthy();
  });

  it("explains that the camera needs HTTPS without even asking for it", async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    const user = setup();
    render(<CameraScanner onDetected={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Start camera" }));
    expect((await screen.findByRole("alert")).textContent).toContain("HTTPS");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("explains an unsupported browser", async () => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    const user = setup();
    render(<CameraScanner onDetected={vi.fn()} />); // no navigator.mediaDevices at all
    await user.click(screen.getByRole("button", { name: "Start camera" }));
    expect((await screen.findByRole("alert")).textContent).toContain("cannot use the camera");
  });

  it("explains a missing camera and a busy camera", async () => {
    for (const [name, text] of [["NotFoundError", "No camera was found"], ["NotReadableError", "The camera is busy"]]) {
      cleanup();
      Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn(async () => { throw Object.assign(new Error(name), { name }); }) }, configurable: true });
      const user = setup();
      render(<CameraScanner onDetected={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: "Start camera" }));
      expect((await screen.findByRole("alert")).textContent).toContain(text);
    }
  });
});

// =============================================================================================================
describe("Codes & labels page", () => {
  const label = {
    product: { id: BOLT_ID, sku: "BOLT-1", name: "Steel bolt", unit: "pcs" },
    identifier: { id: "i1", product_id: BOLT_ID, kind: "generated", value: "IMX-ABC234DEFGHJ", label: null, is_active: true, created_by_email: "a@b.c", created_at: now, retired_at: null },
    code: "IMX-ABC234DEFGHJ",
    qr_svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>',
    barcode_svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="10"/></svg>',
  };
  const supplier = { id: "i2", product_id: BOLT_ID, kind: "supplier", value: "ACME-77", label: "Acme Ltd", is_active: true, created_by_email: "a@b.c", created_at: now, retired_at: null };

  it("prints a label with the product name, SKU, QR code, Code 128 barcode and the code in text", () => {
    render(<CodesManager product={bolt as any} identifiers={[label.identifier as any]} label={label as any} />);
    const sheet = screen.getByLabelText("Label preview");
    expect(sheet.textContent).toContain("Steel bolt");
    expect(sheet.textContent).toContain("SKU: BOLT-1");
    expect(sheet.textContent).toContain("IMX-ABC234DEFGHJ");
    const qr = within(sheet).getByAltText("QR code IMX-ABC234DEFGHJ") as HTMLImageElement;
    const bars = within(sheet).getByAltText("Code 128 barcode IMX-ABC234DEFGHJ") as HTMLImageElement;
    expect(qr.src.startsWith("data:image/svg+xml")).toBe(true); // an image, not injected markup
    expect(bars.src.startsWith("data:image/svg+xml")).toBe(true);
  });

  it("prints the requested number of copies and opens the print dialog", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const user = setup();
    render(<CodesManager product={bolt as any} identifiers={[label.identifier as any]} label={label as any} />);
    const copies = screen.getByLabelText("Copies to print");
    fireEvent.change(copies, { target: { value: "3" } });
    expect(screen.getByLabelText("Label preview").children).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Print labels" }));
    expect(print).toHaveBeenCalledTimes(1);
    fireEvent.change(copies, { target: { value: "500" } });
    expect(screen.getByLabelText("Label preview").children).toHaveLength(24); // capped
    fireEvent.change(copies, { target: { value: "0" } });
    expect(screen.getByLabelText("Label preview").children).toHaveLength(1); // at least one
  });

  it("states that the QR code holds text, not a web address, and survives an SKU change", () => {
    render(<CodesManager product={bolt as any} identifiers={[label.identifier as any]} label={label as any} />);
    expect(document.body.textContent).toContain("as plain text, not a web address");
    expect(document.body.textContent).toContain("stays valid if the SKU or the product name changes");
  });

  it("offers to generate the codes when there are none, and does so with one request", async () => {
    stubServerFor(() => json(201, { identifier: label.identifier, created: true }));
    const user = setup();
    render(<CodesManager product={bolt as any} identifiers={[]} label={null} />);
    await user.click(screen.getByRole("button", { name: "Generate QR code & barcode" }));
    await screen.findByText("The QR code and barcode were generated.");
    expect(calls.map((c) => c.url)).toEqual([`/api/products/${BOLT_ID}/identifiers/generate`]);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("will not generate codes for an archived product", () => {
    render(<CodesManager product={{ ...bolt, is_active: false } as any} identifiers={[]} label={null} />);
    expect((screen.getByRole("button", { name: /Generate/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain("archived");
  });

  it("registers a manufacturer/supplier barcode (typed or scanned into the box, Enter included)", async () => {
    stubServerFor(() => json(201, { identifier: supplier }));
    const user = setup();
    render(<CodesManager product={bolt as any} identifiers={[label.identifier as any]} label={label as any} />);
    await user.selectOptions(screen.getByLabelText(/^Type/), "supplier");
    await user.type(screen.getByLabelText(/^Barcode/), "acme-77{Enter}");
    await screen.findByText("ACME-77 now identifies Steel bolt.");
    expect(JSON.parse(calls[0].init.body)).toEqual({ kind: "supplier", value: "ACME-77", label: "" });
    expect(calls[0].url).toBe(`/api/products/${BOLT_ID}/identifiers`);
  });

  it("rejects an invalid barcode or a web address without sending anything", async () => {
    stubServerFor(() => json(201, {}));
    const user = setup();
    render(<CodesManager product={bolt as any} identifiers={[label.identifier as any]} label={label as any} />);
    await user.type(screen.getByLabelText(/^Barcode/), "has space{Enter}");
    expect((await screen.findByText(/not a valid product code/)).textContent).toBeTruthy();
    await user.clear(screen.getByLabelText(/^Barcode/));
    await user.type(screen.getByLabelText(/^Barcode/), "https://evil.example{Enter}");
    expect((await screen.findByText(/web link/)).textContent).toContain("not opened");
    expect(calls).toHaveLength(0);
  });

  it("shows the server's message when a barcode already belongs to another product", async () => {
    const message = "DUP-1 is already assigned to Other (OTHER) in your catalog. A code can identify only one product.";
    stubServerFor(() => json(409, { error: message, fieldErrors: { value: message } }));
    const user = setup();
    render(<CodesManager product={bolt as any} identifiers={[label.identifier as any]} label={label as any} />);
    await user.type(screen.getByLabelText(/^Barcode/), "DUP-1{Enter}");
    await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThan(0));
  });

  it("retires a barcode only after confirmation, and keeps the Impex label code non-retirable", async () => {
    stubServerFor(() => json(200, { identifier: { ...supplier, is_active: false } }));
    const user = setup();
    render(<CodesManager product={bolt as any} identifiers={[label.identifier as any, supplier as any]} label={label as any} />);
    expect(screen.getAllByRole("button", { name: /^Retire/ })).toHaveLength(1); // only the supplier barcode
    await user.click(screen.getByRole("button", { name: "Retire ACME-77" }));
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Yes, retire" }));
    await screen.findByText(/was retired\. It is kept/);
    expect(calls[0].url).toBe(`/api/products/${BOLT_ID}/identifiers/i2/retire`);
  });

  function stubServerFor(handler: () => Response) {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => { calls.push({ url: String(input), init }); return handler(); }));
  }
});
