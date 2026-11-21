// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import { ScanToAddButton } from "@/components/scan/scan-to-add";
import ProductForm from "@/components/product/product-form";

// Add Stock > Scan to add: a button after the product name that reads a barcode into the new product's Barcode box, after checking that the code is not already a product's.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const found = { matched_by: "identifier", identifier_kind: "manufacturer", product: { id: "p1", sku: "COKE-001", name: "Coca-cola", is_active: true, unit: "pcs" }, stock: { product_id: "p1" } };
const user = () => userEvent.setup();
let resolved: string[];

function stubResolve(answer: (code: string) => Response) {
  resolved = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any) => {
    const code = new URL(String(url), "http://localhost").searchParams.get("code") ?? "";
    resolved.push(code);
    return answer(code);
  }));
}

beforeEach(() => { router.replace.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness({ onCode }: { onCode: (c: string) => void }) {
  const [last, setLast] = useState("");
  return <><ScanToAddButton onCode={(c) => { setLast(c); onCode(c); }} /><output data-testid="last">{last}</output></>;
}

describe("Scan to add", () => {
  it("opens a dialog, reads a typed or scanned code (Enter), and hands over the normalized code when nothing has it yet", async () => {
    stubResolve(() => json(404, { error: "nope" }));
    const onCode = vi.fn();
    render(<Harness onCode={onCode} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Scan to add" }));
    expect(screen.getByRole("dialog", { name: "Scan to add" })).toBeTruthy();
    await u.type(screen.getByLabelText("Scan or type the barcode"), "  8901234567890{enter}");
    await waitFor(() => expect(onCode).toHaveBeenCalledWith("8901234567890"));
    expect(resolved).toEqual(["8901234567890"]); // checked first, read-only
    expect(screen.queryByRole("dialog")).toBeNull(); // and the dialog closes
  });

  it("a lower-case code is stored the way the Inventory Service stores it (capitals)", async () => {
    stubResolve(() => json(404, {}));
    const onCode = vi.fn();
    render(<Harness onCode={onCode} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Scan to add" }));
    await u.type(screen.getByLabelText("Scan or type the barcode"), "abc-123");
    await u.click(screen.getByRole("button", { name: "Use this code" }));
    await waitFor(() => expect(onCode).toHaveBeenCalledWith("ABC-123"));
  });

  it("refuses a code that already belongs to a product, naming it, and stays open for the next scan", async () => {
    stubResolve(() => json(200, found));
    const onCode = vi.fn();
    render(<Harness onCode={onCode} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Scan to add" }));
    await u.type(screen.getByLabelText("Scan or type the barcode"), "COKE-BARCODE{enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("already belongs to Coca-cola (COKE-001)");
    expect(onCode).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Scan to add" })).toBeTruthy();
  });

  it("does not use a code it cannot check (an outage, a retired code, a link) and says why", async () => {
    stubResolve(() => json(503, {}));
    const onCode = vi.fn();
    render(<Harness onCode={onCode} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Scan to add" }));
    const box = screen.getByLabelText("Scan or type the barcode");
    await u.type(box, "ABC123{enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/temporarily unavailable/);
    stubResolve(() => json(410, {}));
    await u.type(box, "OLD999{enter}");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/retired/));
    await u.type(box, "https://evil.example/x{enter}");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/web link/));
    expect(onCode).not.toHaveBeenCalled();
  });

  it("an expired session goes to the login page, and Cancel closes the dialog without handing anything over", async () => {
    stubResolve(() => json(401, {}));
    const onCode = vi.fn();
    render(<Harness onCode={onCode} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Scan to add" }));
    await u.type(screen.getByLabelText("Scan or type the barcode"), "ABC123{enter}");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    await u.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onCode).not.toHaveBeenCalled();
  });

  it("a scanner's Enter never submits a form the button sits in", async () => {
    stubResolve(() => json(404, {}));
    const submitted = vi.fn((e: any) => e.preventDefault());
    render(<form onSubmit={submitted}><ScanToAddButton onCode={vi.fn()} /></form>);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Scan to add" }));
    await u.type(screen.getByLabelText("Scan or type the barcode"), "ABC123{enter}");
    expect(submitted).not.toHaveBeenCalled();
  });
});

describe("Add Stock form: the Scan to add button", () => {
  const draw = (props: Record<string, unknown> = {}) => render(<ProductForm panel withBarcode withQuantity onDone={vi.fn()} {...props} />);

  it("sits right after the product name box, on the same row, and the name box is not full width", () => {
    draw();
    const name = screen.getByLabelText("Product name");
    const scan = screen.getByRole("button", { name: "Scan to add" });
    expect(name.compareDocumentPosition(scan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scan.parentElement!.className).toContain("sm:flex-row"); // one row from a small screen up, stacked on a phone
    expect(name.closest("div.min-w-0")!.className).toContain("flex-1"); // the name takes what the button leaves
  });

  it("puts the scanned code in the Barcode box (and clears an old barcode error), saving nothing", async () => {
    stubResolve(() => json(404, {}));
    draw();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Scan to add" }));
    await u.type(screen.getByLabelText("Scan or type the barcode"), "8901234567890{enter}");
    await waitFor(() => expect((screen.getByLabelText("Barcode") as HTMLInputElement).value).toBe("8901234567890"));
    expect(resolved).toEqual(["8901234567890"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is not offered where a product is only edited, or where the form has no Barcode box", () => {
    const { unmount } = render(<ProductForm panel onDone={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Scan to add" })).toBeNull();
    unmount();
    render(<ProductForm withBarcode onDone={vi.fn()} product={{ id: "p1", sku: "A", name: "Edit me", description: null, unit: "pcs", hs_code: null, cost_price: "1", selling_price: null, currency_code: "USD", is_active: true } as any} />);
    expect(screen.queryByRole("button", { name: "Scan to add" })).toBeNull();
  });
});
