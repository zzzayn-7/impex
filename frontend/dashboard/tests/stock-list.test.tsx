// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import StockOverview from "@/app/stock/stock-overview";
import FullStockList from "@/app/stock/full/full-stock-list";

// The Stock list scrolls instead of paging: no Previous / Next, the next rows load when the end of the list comes into view, and "Full view" opens the whole
// list on its own page. The toolbar above it has the search box, a scanner icon and the status filter, and nothing else.

const row = (n: number) => ({
  product_id: `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`, sku: `SKU-${n}`, name: `Product ${n}`, unit: "pcs", unit_allows_fractions: false, is_active: true,
  total_quantity: "10.0000", reserved_quantity: "0.0000", available_quantity: "10.0000", cost_price: "2.0000", selling_price: null, currency_code: "USD",
});
const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => row(from + i));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const filters = { q: "", inStockOnly: false, status: "active" as const, page: 1 };
const list = (items: any[], total = items.length) => ({ ok: true as const, items, total, limit: 25, offset: 0 }) as any;
let urls: string[];
let observers: { callback: (entries: { isIntersecting: boolean }[]) => void }[];

beforeEach(() => {
  urls = [];
  observers = [];
  Object.values(router).forEach((fn) => fn.mockReset());
  vi.stubGlobal("IntersectionObserver", class {
    constructor(public callback: (entries: { isIntersecting: boolean }[]) => void) { observers.push(this); }
    observe() { /* the test decides when the end of the list is reached */ }
    disconnect() {}
    unobserve() {}
  });
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("/api/stock/items")) return json(200, { items: rows(26, 30), total: 30, pageSize: 25 });
    return json(404, { error: "not found" });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = (over: Partial<React.ComponentProps<typeof StockOverview>> = {}) =>
  render(<StockOverview list={list(rows(1, 25), 30)} filters={filters} products={[] as any} {...over} />);

describe("the toolbar above the Stock list", () => {
  it("has no 'In stock only' checkbox and no 'Products' heading above the status dropdown", () => {
    mount();
    expect(screen.queryByLabelText(/in stock only/i)).toBeNull();
    expect(screen.queryByText("In stock only")).toBeNull();
    expect(screen.queryByText("Products")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect((screen.getByLabelText("Show products") as HTMLSelectElement).value).toBe("active");
  });

  it("has a scanner icon between the search box and the status filter", () => {
    mount();
    const search = screen.getByRole("search");
    const scan = screen.getByRole("button", { name: "Scan to search" });
    const status = screen.getByLabelText("Show products");
    expect(scan.textContent).toBe(""); // an icon, no words
    expect(search.compareDocumentPosition(scan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scan.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the status filter has one fixed width, whatever is chosen", () => {
    mount();
    expect(screen.getByLabelText("Show products").className).toMatch(/\bw-36\b/);
  });
});

describe("the Stock list scrolls instead of paging", () => {
  it("has no Previous / Next buttons and no page numbers, and offers Full view", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.getByTestId("stock-scroller").className).toMatch(/overflow-auto/); // its own scroll area
    expect(screen.getByRole("link", { name: "Full view" }).getAttribute("href")).toBe("/stock/full");
  });

  it("Full view keeps the search and the status filter", () => {
    mount({ filters: { ...filters, q: "bolt", status: "all" } });
    expect(screen.getByRole("link", { name: "Full view" }).getAttribute("href")).toBe("/stock/full?q=bolt&status=all");
  });

  it("loads the next rows when the end of the list comes into view, and says how many are shown", async () => {
    mount();
    expect(screen.getByTestId("stock-count").textContent).toBe("Showing 25 of 30");
    expect(screen.queryByText("Product 30")).toBeNull();
    observers[observers.length - 1].callback([{ isIntersecting: true }]);
    await screen.findByText("Product 30");
    expect(urls).toEqual(["/api/stock/items?page=2&status=active"]);
    expect(screen.getByTestId("stock-count").textContent).toBe("Showing 30 of 30");
    expect(screen.getAllByRole("row")).toHaveLength(31); // header + 30
  });

  it("asks for nothing more once everything is shown", () => {
    mount({ list: list(rows(1, 3), 3) });
    expect(observers).toHaveLength(0);
    expect(urls).toEqual([]);
  });

  it("says so, with a way to try again, when the next rows cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(503, { error: "down" })));
    const user = userEvent.setup();
    mount();
    observers[observers.length - 1].callback([{ isIntersecting: true }]);
    const retry = await screen.findByRole("button", { name: /Could not load more/ }, { timeout: 4000 });
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { items: rows(26, 30), total: 30, pageSize: 25 })));
    await user.click(retry);
    await screen.findByText("Product 30", undefined, { timeout: 4000 });
  });
});

describe("the Full view list", () => {
  it("is the same list without a height limit of its own (the page scrolls) and loads more the same way", async () => {
    render(<FullStockList initial={rows(1, 25)} total={30} filters={{ q: "", status: "active" }} />);
    expect(screen.getByTestId("stock-scroller").className).not.toMatch(/max-h-/);
    observers[observers.length - 1].callback([{ isIntersecting: true }]);
    await screen.findByText("Product 30");
    expect(within(screen.getByTestId("stock-scroller")).getAllByRole("row")).toHaveLength(31);
  });
});
