// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import { ScanProductButton } from "@/components/scan/scan-product-modal";
import StockForm from "@/app/stock/stock-form";
import type { ScanResult } from "@/lib/scan";

const BOLT = "b0000000-0000-4000-8000-000000000001";
const FLOUR = "b0000000-0000-4000-8000-000000000002";
const OLD = "b0000000-0000-4000-8000-000000000003";
const now = "2026-11-09T10:00:00+00:00";

const product = (id: string, sku: string, name: string, unit: string, active = true) => ({
  id, sku, name, description: null, unit, hs_code: null, cost_price: "1.0000", selling_price: "2.0000", currency_code: "USD", is_active: active,
  created_at: now, updated_at: now, unit_allows_fractions: unit === "kg",
});
const stock = (p: ReturnType<typeof product>, total: string, reserved: string) => ({
  product_id: p.id, sku: p.sku, name: p.name, unit: p.unit, unit_allows_fractions: p.unit_allows_fractions, is_active: p.is_active,
  total_quantity: total, reserved_quantity: reserved, available_quantity: String(Number(total) - Number(reserved)),
});
const bolt = product(BOLT, "BOLT-1", "Steel bolt", "pcs");
const flour = product(FLOUR, "FLOUR", "Flour", "kg");
const old = product(OLD, "OLD-1", "Old bolt", "pcs", false);
const CATALOG: Record<string, ScanResult> = {
  "BOLT-1": { matched_by: "sku", identifier_kind: null, product: bolt as any, stock: stock(bolt, "100", "40") as any },
  "MFR-123": { matched_by: "identifier", identifier_kind: "manufacturer", product: bolt as any, stock: stock(bolt, "100", "40") as any }, // a manufacturer barcode of the same product
  "IXG-9": { matched_by: "identifier", identifier_kind: "generated", product: flour as any, stock: stock(flour, "20", "0") as any }, // an Impex-generated code
  "OLD-1": { matched_by: "sku", identifier_kind: null, product: old as any, stock: stock(old, "0", "0") as any },
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; body: any; headers: Record<string, string> };
let calls: Call[];
let unauthorized = false;

beforeEach(() => {
  calls = [];
  unauthorized = false;
  Object.values(router).forEach((fn) => fn.mockReset());
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    if (url.startsWith("/api/scan/resolve")) {
      if (unauthorized) return json(401, { error: "expired" });
      const code = new URL(url, "http://x").searchParams.get("code") ?? "";
      return CATALOG[code] ? json(200, CATALOG[code]) : json(404, { error: "No product in your catalog matches this code." });
    }
    if (url.startsWith("/api/stock/") && init.method === "POST") return json(201, { operation: { replayed: false } });
    return json(404, { error: "not found" });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.style.overflow = ""; });

const scanBox = () => within(screen.getByRole("dialog")).getByLabelText(/Scan or type a barcode/) as HTMLInputElement;
const writes = () => calls.filter((c) => c.method !== "GET");

// =====================================================================================================================================
describe("Scan Product: the shared dialog", () => {
  function Harness({ onFound = vi.fn(), onSubmit = vi.fn(), ...props }: { onFound?: (r: ScanResult) => void; onSubmit?: () => void; activeOnly?: boolean; check?: (r: ScanResult) => string | null }) {
    const [name, setName] = useState("typed before scanning");
    return (
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} aria-label="Surrounding form">
        <input aria-label="Notes" value={name} onChange={(e) => setName(e.target.value)} />
        <ScanProductButton onFound={onFound} {...props} />
        <button type="submit">Save</button>
      </form>
    );
  }

  it("opens as a centered dialog over the page and closes with Cancel, the close button and Escape, leaving the form's values alone", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Scan Product");
    expect(dialog.className).toContain("-translate-x-1/2"); // centered
    expect(dialog.closest(".ix-dash, body")).toBeTruthy(); // inside the page, so it inherits the portal theme
    expect(document.activeElement).toBe(scanBox()); // ready for a scanner
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.click(within(await screen.findByRole("dialog")).getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    fireEvent(await screen.findByRole("dialog"), new Event("cancel", { cancelable: true })); // Escape
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((screen.getByLabelText("Notes") as HTMLInputElement).value).toBe("typed before scanning");
    expect(document.body.style.overflow).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("a scanner's code plus Enter identifies the product and hands it, with its stock, to the screen; it closes and sends nothing but the lookup", async () => {
    const user = userEvent.setup();
    const onFound = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onFound={onFound} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.type(scanBox(), "bolt-1{Enter}");
    await waitFor(() => expect(onFound).toHaveBeenCalledTimes(1));
    const result = onFound.mock.calls[0][0] as ScanResult;
    expect([result.product.id, result.stock.total_quantity, result.stock.reserved_quantity, result.stock.available_quantity]).toEqual([BOLT, "100", "40", "60"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled(); // the scanner's Enter did not submit the form behind the dialog
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/scan/resolve?code=BOLT-1"]); // a lookup only: no stock, order or reservation request
    expect((screen.getByLabelText("Notes") as HTMLInputElement).value).toBe("typed before scanning");
  });

  it("resolves manufacturer barcodes and Impex's own generated codes (the server decides what a code means), and manual entry works", async () => {
    const user = userEvent.setup();
    const onFound = vi.fn();
    render(<Harness onFound={onFound} />);
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.type(scanBox(), "MFR-123{Enter}");
    await waitFor(() => expect(onFound).toHaveBeenCalledTimes(1));
    expect(onFound.mock.calls[0][0].matched_by).toBe("identifier");
    expect(onFound.mock.calls[0][0].identifier_kind).toBe("manufacturer");
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.type(scanBox(), "ixg-9");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Find product" })); // the typed fallback
    await waitFor(() => expect(onFound).toHaveBeenCalledTimes(2));
    expect(onFound.mock.calls[1][0].identifier_kind).toBe("generated");
    expect(onFound.mock.calls[1][0].product.id).toBe(FLOUR);
  });

  it("says plainly when nothing matches, stays open for another try, and hands nothing over", async () => {
    const user = userEvent.setup();
    const onFound = vi.fn();
    render(<Harness onFound={onFound} />);
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.type(scanBox(), "NOPE{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("No product in your catalog matches this code.");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onFound).not.toHaveBeenCalled();
    await user.type(scanBox(), "bolt-1{Enter}");
    await waitFor(() => expect(onFound).toHaveBeenCalledTimes(1));
  });

  it("treats a code that looks like a web link as text: refused, never fetched", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.type(scanBox(), "https://evil.example/x{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("web link");
    expect(calls).toHaveLength(0);
  });

  it("refuses an archived product by default, and lets a screen that may look at archived products have it", async () => {
    const user = userEvent.setup();
    const strict = vi.fn();
    const { unmount } = render(<Harness onFound={strict} />);
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.type(scanBox(), "OLD-1{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("Old bolt is archived");
    expect(strict).not.toHaveBeenCalled();
    unmount();
    const lenient = vi.fn();
    render(<Harness onFound={lenient} activeOnly={false} />);
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.type(scanBox(), "OLD-1{Enter}");
    await waitFor(() => expect(lenient).toHaveBeenCalledTimes(1));
  });

  it("lets a screen refuse a product that does not belong there, with its own message, inside the dialog", async () => {
    const user = userEvent.setup();
    const onFound = vi.fn();
    render(<Harness onFound={onFound} check={(r) => (r.product.id === BOLT ? "Steel bolt is not on this order." : null)} />);
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.type(scanBox(), "bolt-1{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("Steel bolt is not on this order.");
    expect(onFound).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it("sends an expired session to the sign-in page", async () => {
    const user = userEvent.setup();
    unauthorized = true;
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.type(scanBox(), "bolt-1{Enter}");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("offers the phone camera (nothing is asked of the camera until Start camera is pressed) and a disabled button opens nothing", async () => {
    const user = userEvent.setup();
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    const { unmount } = render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use the camera" }));
    expect(within(screen.getByRole("dialog")).getByRole("region", { name: "Camera scanner" })).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();
    unmount();
    render(<ScanProductButton onFound={() => undefined} disabled />);
    expect((screen.getByRole("button", { name: "Scan Product" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// =====================================================================================================================================
describe("Stock In and Stock Out: Scan Product selects the product, and only submitting changes stock", () => {
  const products = [bolt, flour] as any[];
  const mountForm = (action: "in" | "out", props: Record<string, unknown> = {}) => {
    const onDone = vi.fn();
    render(<StockForm initialAction={action} products={products} onDone={onDone} onCancel={() => undefined} {...props} />);
    return onDone;
  };
  const select = () => screen.getByLabelText("Product") as HTMLSelectElement;
  const scanInto = async (user: ReturnType<typeof userEvent.setup>, code: string) => {
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.type(scanBox(), `${code}{Enter}`);
  };

  it("Stock In: the scan selects the product, shows its stock, keeps what was typed, and nothing is added until the form is submitted", async () => {
    const user = userEvent.setup();
    const onDone = mountForm("in");
    await user.type(screen.getByLabelText("Reason (optional)"), "delivery note 7");
    await scanInto(user, "mfr-123");
    await waitFor(() => expect(select().value).toBe(BOLT));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByLabelText("Reason (optional)") as HTMLInputElement).value).toBe("delivery note 7"); // form values survive
    const status = screen.getByText(/Scanned:/).closest("p")!;
    expect(status.textContent).toContain("On hand 100 pcs");
    expect(status.textContent).toContain("Reserved 40");
    expect(status.textContent).toContain("Available 60 pcs");
    expect(writes()).toEqual([]); // identified only: no stock movement yet
    await user.type(screen.getByLabelText(/^Quantity/), "5");
    await user.click(screen.getByRole("button", { name: "Add stock" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(writes()).toHaveLength(1); // exactly one transaction, after the administrator submitted it
    expect(writes()[0]).toMatchObject({ url: "/api/stock/in", method: "POST", body: { product_id: BOLT, quantity: "5", reason: "delivery note 7" } });
    expect(writes()[0].headers["Idempotency-Key"]).toMatch(/^ui-/);
  });

  it("Stock Out: shows the AVAILABLE stock (reserved stock belongs to customer orders) and removes nothing until submitted", async () => {
    const user = userEvent.setup();
    mountForm("out");
    await scanInto(user, "bolt-1");
    await waitFor(() => expect(select().value).toBe(BOLT));
    const status = screen.getByText(/Scanned:/).closest("p")!;
    expect(status.textContent).toContain("Available 60 pcs");
    expect(status.textContent).toContain("Stock reserved for customer orders cannot be removed");
    expect(writes()).toEqual([]);
  });

  it("a different product chosen afterwards clears the scanned figures (they belong to the scanned product only)", async () => {
    const user = userEvent.setup();
    mountForm("out");
    await scanInto(user, "bolt-1");
    await waitFor(() => expect(screen.getByText(/Scanned:/)).toBeTruthy());
    await user.selectOptions(select(), FLOUR);
    expect(screen.queryByText(/Scanned:/)).toBeNull();
  });

  it("refuses, inside the dialog, a product the form cannot use, and an unknown code; the selection is untouched", async () => {
    const user = userEvent.setup();
    mountForm("in", { products: [flour] });
    await scanInto(user, "bolt-1");
    expect((await screen.findByRole("alert")).textContent).toContain("is not available for stock changes here");
    await user.type(scanBox(), "NOPE{Enter}");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("No product in your catalog matches"));
    expect(select().value).toBe("");
    expect(writes()).toEqual([]);
  });

  it("manual selection is still there and still works without any scan", async () => {
    const user = userEvent.setup();
    const onDone = mountForm("in");
    await user.selectOptions(select(), FLOUR);
    await user.type(screen.getByLabelText(/^Quantity/), "2.5");
    await user.click(screen.getByRole("button", { name: "Add stock" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(writes()).toHaveLength(1);
    expect(calls.some((c) => c.url.startsWith("/api/scan"))).toBe(false);
  });

  it("a form whose product is fixed (opened from a row) offers no scan button, so it can never switch product silently", () => {
    mountForm("in", { initialProductId: BOLT, lockProduct: true });
    expect(screen.queryByRole("button", { name: "Scan Product" })).toBeNull();
  });
});

// =====================================================================================================================================
describe("Products: Scan Product finds a product in the catalog", () => {
  it("puts the scanned product's SKU in the search and shows it (archived products too); nothing is changed", async () => {
    const { default: ProductCatalog } = await import("@/app/products/product-catalog");
    const user = userEvent.setup();
    render(<ProductCatalog list={{ ok: true, products: [bolt] as any, total: 1, limit: 25, offset: 0 }} filters={{ q: "", status: "active", page: 1 }} />);
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.type(scanBox(), "bolt-1{Enter}");
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/products?q=BOLT-1"));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("BOLT-1");
    await user.click(screen.getByRole("button", { name: "Scan Product" }));
    await user.type(scanBox(), "OLD-1{Enter}");
    await waitFor(() => expect(router.push).toHaveBeenLastCalledWith("/products?q=OLD-1&status=all")); // an archived product must not be hidden by the default filter
    expect(writes()).toEqual([]);
  });
});
