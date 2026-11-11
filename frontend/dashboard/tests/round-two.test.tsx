// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import { ClockProvider, Stamp } from "@/components/clock";
import MovementHistory from "@/app/movements/movement-history";
import StockOverview from "@/app/stock/stock-overview";
import { formatStamp } from "@/lib/format";
import { PERIODS } from "@/lib/finance-view";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: { url: string; method: string }[] = [];
beforeEach(() => {
  calls = [];
  Object.values(router).forEach((fn) => fn.mockReset());
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => { calls.push({ url: String(input), method: init.method ?? "GET" }); return json(200, { ok: true }); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("time is written dd/mm/yyyy | hh:mm AM/PM in the organization's own time zone", () => {
  it("formats morning, noon, afternoon, midnight and shifts to the zone", () => {
    expect(formatStamp("2026-11-11T09:05:00+00:00", "UTC")).toBe("11/11/2026 | 09:05 AM");
    expect(formatStamp("2026-11-11T12:00:00+00:00", "UTC")).toBe("11/11/2026 | 12:00 PM");
    expect(formatStamp("2026-11-11T15:45:00+00:00", "UTC")).toBe("11/11/2026 | 03:45 PM");
    expect(formatStamp("2026-11-11T00:10:00+00:00", "UTC")).toBe("11/11/2026 | 12:10 AM");
    expect(formatStamp("2026-11-11T10:00:00+00:00", "Asia/Karachi")).toBe("11/11/2026 | 03:00 PM"); // Pakistan is UTC+5
    expect(formatStamp("2026-11-11T22:30:00+00:00", "Asia/Karachi")).toBe("12/11/2026 | 03:30 AM"); // already the next day there
    expect(formatStamp("2026-11-11T10:00:00+00:00", "America/New_York")).toBe("11/11/2026 | 05:00 AM");
    expect(formatStamp("not a date", "UTC")).toBe("not a date");
    expect(formatStamp("2026-11-11T10:00:00+00:00", "Not/AZone")).toBe("11/11/2026 | 10:00 AM"); // a bad zone is never trusted
  });

  it("never writes UTC, and the provider decides the zone for every page below it", () => {
    render(<ClockProvider timeZone="Asia/Karachi"><p data-testid="t"><Stamp iso="2026-11-11T10:00:00+00:00" /> / <Stamp iso={null} /></p></ClockProvider>);
    expect(screen.getByTestId("t").textContent).toBe("11/11/2026 | 03:00 PM / —");
    expect(screen.getByTestId("t").textContent).not.toContain("UTC");
  });

  it("no page source still writes ' UTC' after a time", () => {
    const files = [
      "app/delivery-lists/order-modals.tsx", "app/dispatches/[id]/dispatch-detail.tsx", "app/goods-receipts/[id]/receipt-detail.tsx", "app/finance/expenses/[id]/expense-detail.tsx",
      "app/finance/journal/[id]/entry-detail.tsx", "app/finance/overview-view.tsx", "app/finance/ui.tsx", "app/movements/movement-history.tsx", "app/purchase-orders/[id]/order-detail.tsx",
      "app/delivery-lists/[id]/delivery-list-detail.tsx", "app/support/support-index.tsx", "app/support/[id]/ticket-conversation.tsx",
    ];
    for (const file of files) expect(readFileSync(join(__dirname, "..", "src", file), "utf8"), file).not.toMatch(/\bUTC\b/);
  });
});

const stockRow = (sku: string, qty: string, cost: string | null, currency = "PKR") => ({
  product_id: `b0000000-0000-4000-8000-0000000000${sku.length}${qty.length}`, sku, name: sku, unit: "pcs", unit_allows_fractions: false, is_active: true,
  total_quantity: qty, reserved_quantity: "0", available_quantity: qty, cost_price: cost, selling_price: null, currency_code: currency,
});
const listOf = (items: any[]) => ({ ok: true as const, items, total: items.length, limit: 25, offset: 0 });
const filters = { q: "", inStockOnly: false, status: "active" as const, page: 1 };

describe("Stock: the Total cost section", () => {
  it("shows the sum of (pieces x cost) of ALL products, one total per currency", () => {
    const { rerender } = render(<StockOverview list={listOf([stockRow("A", "10", "50000"), stockRow("B", "5", "30")])} filters={filters} products={[]} totals={[{ currency: "PKR", amount: "500150.0000" }]} />);
    expect(screen.getByTestId("stock-total-cost-PKR").textContent).toBe("500,150.00 PKR");
    expect(screen.getByTestId("stock-total-cost").textContent).toContain("for all 2 products");
    rerender(<StockOverview list={listOf([])} filters={filters} products={[]} totals={[{ currency: "PKR", amount: "1.0000" }, { currency: "USD", amount: "2.5000" }]} />);
    expect(screen.getByTestId("stock-total-cost-USD").textContent).toBe("2.50 USD"); // currencies are never added together
  });

  it("is filled up from every page of the filter, exactly, and skips a product with no cost", async () => {
    vi.resetModules();
    vi.doMock("@/lib/inventory", () => ({
      PAGE_SIZE: 2,
      listStock: async (_token: string, f: { page: number }) => ({ ok: true, total: 5, limit: 2, offset: (f.page - 1) * 2, items: [
        [stockRow("A", "10", "0.1"), stockRow("B", "3", "0.2")], [stockRow("C", "7", "100.5"), stockRow("D", "9", null)], [stockRow("E", "2", "5", "USD")],
      ][f.page - 1] }),
    }));
    const { stockTotals } = await import("@/lib/stock-totals");
    expect(await stockTotals("t", filters)).toEqual([{ currency: "PKR", amount: "705.1000" }, { currency: "USD", amount: "10.0000" }]); // 1.0 + 0.6 + 703.5 ; 2 x 5
    vi.doUnmock("@/lib/inventory");
  });

  it("has no Remove Stock button", () => {
    render(<StockOverview list={listOf([stockRow("A", "10", "5")])} filters={filters} products={[{ id: "x" } as any]} totals={[]} />);
    expect(screen.queryByRole("button", { name: "Remove Stock" })).toBeNull();
    expect(screen.getByRole("button", { name: "Opening Balance" })).toBeTruthy();
  });
});

const movement = (over: Record<string, unknown>) => ({
  id: "m1", operation_id: "o1", product_id: "p1", product_sku: "LAP-1", product_name: "Laptop", product_unit: "pcs", unit_allows_fractions: false, movement_type: "in", quantity: "20.0000", balance_after: "50.0000",
  reason: "Goods receipt GR-1", created_by_email: "admin@example.org", source_type: null, source_reference: null, created_at: "2026-11-11T10:00:00+00:00", ...over,
});

describe("Stock Movements page", () => {
  const mount = (items: any[]) => render(
    <ClockProvider timeZone="Asia/Karachi"><MovementHistory list={{ ok: true, items, total: items.length, limit: 25, offset: 0 }} filters={{ productId: "", type: "", page: 1 }} products={[]} /></ClockProvider>,
  );

  it("has the columns in this order, with the bin last and no Reason column", () => {
    mount([movement({})]);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Product", "Quantity before", "Quantity after", "Order", "Activity", "Date and time", "User", "Remove"]);
    expect(screen.queryByText("Reason")).toBeNull();
    expect(screen.queryByText("Goods receipt GR-1")).toBeNull();
  });

  it("computes the quantity before and after exactly, and writes the activity, the date and the user", () => {
    mount([movement({ id: "in", movement_type: "in", quantity: "20.0000", balance_after: "50.0000" }), movement({ id: "out", movement_type: "out", quantity: "12.5000", balance_after: "37.5000", created_at: "2026-11-11T22:30:00+00:00" }),
           movement({ id: "open", movement_type: "opening", quantity: "7.0000", balance_after: "7.0000" })]);
    expect(screen.getByTestId("before-in").textContent).toBe("30");
    expect(screen.getByTestId("after-in").textContent).toBe("50");
    expect(screen.getByTestId("order-in").textContent).toContain("20");
    expect(screen.getByTestId("before-out").textContent).toBe("50");
    expect(screen.getByTestId("after-out").textContent).toBe("37.5");
    expect(screen.getByTestId("before-open").textContent).toBe("0");
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("In")).toBeTruthy();
    expect(within(rows[1]).getByText("Out")).toBeTruthy();
    expect(within(rows[2]).getByText("In")).toBeTruthy(); // an opening balance puts stock in
    expect(within(rows[0]).getByText("11/11/2026 | 03:00 PM")).toBeTruthy();
    expect(within(rows[1]).getByText("12/11/2026 | 03:30 AM")).toBeTruthy();
    expect(within(rows[0]).getByText("admin@example.org")).toBeTruthy();
  });

  it("the bin asks first, then takes the movement off the page (the ledger is not touched)", async () => {
    mount([movement({})]);
    await userEvent.click(screen.getByRole("button", { name: "Remove the movement of Laptop from the list" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls[0].url).toBe("/api/stock/movements/m1/hide");
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("does nothing when the question is answered No", async () => {
    vi.stubGlobal("confirm", () => false);
    mount([movement({})]);
    await userEvent.click(screen.getByRole("button", { name: "Remove the movement of Laptop from the list" }));
    expect(calls).toHaveLength(0);
  });
});

describe("tables and periods", () => {
  it("every other column of every table is centred; the first stays on the left", () => {
    const css = readFileSync(join(__dirname, "..", "src", "components", "ui", "org-portal.css"), "utf8");
    expect(css).toMatch(/\.ix-dash table :is\(th, td\):not\(:first-child\) \{ text-align: center; \}/);
    expect(css).toMatch(/td:not\(:first-child\) > div\.flex \{ justify-content: center; \}/);
  });

  it("the Finance selector offers 1 Day, 1 Week, 1 Month, 6 Months, 1 Year", () => {
    expect(PERIODS.map((p) => [p.key, p.label])).toEqual([["1d", "1 Day"], ["1w", "1 Week"], ["1m", "1 Month"], ["6m", "6 Months"], ["1y", "1 Year"]]);
  });
});
