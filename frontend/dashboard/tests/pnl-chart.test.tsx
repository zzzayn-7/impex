// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/finance" }));

import PnlChart from "@/app/finance/pnl-chart";
import FinanceView from "@/app/finance/finance-view";
import { bucketLabel, bucketPeriod, compactNumber, niceCeil, pnlScale, signedWithCurrency } from "@/lib/finance-view";
import type { PnlBucket, PnlTrend } from "@/lib/finance";

const bucket = (start: string, end: string, net: string, over: Partial<PnlBucket> = {}): PnlBucket => ({
  start, end, revenue: "0.0000", cost_of_goods_sold: "0.0000", expenses: "0.0000", adjustments: "0.0000", other_costs: "0.0000", net, has_activity: net !== "0.0000", needs_cost_count: 0, ...over,
});
const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}T00:00:00+00:00`;

const WEEK: PnlTrend = {
  period: { key: "1w", label: "1 Week", start: day(4), end: day(11), timezone: "UTC" }, granularity: "day", default_currency: "PKR", currencies: ["PKR"], combined_available: true,
  by_currency: { PKR: { currency_code: "PKR", totals: { net: "250000.0000", profitable_periods: 2, loss_periods: 1, has_activity: true, needs_cost_count: 0 }, buckets: [
    bucket(day(4), day(5), "400000.0000", { revenue: "2400000.0000", cost_of_goods_sold: "2000000.0000" }),
    bucket(day(5), day(6), "0.0000"),
    bucket(day(6), day(7), "-100000.0000", { revenue: "900000.0000", cost_of_goods_sold: "1000000.0000" }),
    bucket(day(7), day(8), "0.0000", { has_activity: true, revenue: "10.0000", cost_of_goods_sold: "10.0000" }),
    bucket(day(8), day(9), "-50000.0000", { expenses: "50000.0000", other_costs: "50000.0000" }),
    bucket(day(9), day(10), "0.0000"),
    bucket(day(10), day(11), "0.0000", { has_activity: false }),
  ] } },
  incomplete: { needs_price: 0, needs_cost: 0 }, ...{},
};
const withNets = (nets: string[]): PnlTrend => ({ ...WEEK, by_currency: { PKR: { ...WEEK.by_currency.PKR, buckets: nets.map((n, i) => bucket(day(i + 1), day(i + 2), n)) } } });

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the chart's numbers", () => {
  it("finds nice axis ends and writes compact labels", () => {
    expect([niceCeil(0), niceCeil(0.9), niceCeil(1), niceCeil(1.1), niceCeil(350000), niceCeil(2400000), niceCeil(4999999)]).toEqual([0, 1, 1, 2, 500000, 2500000, 5000000]);
    expect([compactNumber(900), compactNumber(1500), compactNumber(350000), compactNumber(-2500000), compactNumber(1200000000)]).toEqual(["900", "1.5K", "350K", "-2.5M", "1.2B"]);
  });

  it("sizes profit above and loss below one zero baseline, each side to its own largest bar", () => {
    const scale = pnlScale(WEEK.by_currency.PKR.buckets);
    expect(scale.top).toBe(500000);
    expect(scale.bottom).toBe(100000);
    expect(scale.baselinePct).toBeCloseTo((100000 / 600000) * 100);
    expect(scale.bars.map((b) => b.kind)).toEqual(["profit", "none", "loss", "zero", "loss", "none", "none"]);
    expect(scale.bars[0].heightPct).toBeCloseTo((400000 / 600000) * 100);
    expect(scale.bars[2].heightPct).toBeCloseTo((100000 / 600000) * 100);
  });

  it("with only profits the baseline sits at the bottom, with only losses at the top", () => {
    expect(pnlScale(withNets(["5.0000", "10.0000"]).by_currency.PKR.buckets).baselinePct).toBe(0);
    expect(pnlScale(withNets(["-5.0000", "-10.0000"]).by_currency.PKR.buckets).baselinePct).toBe(100);
  });

  it("labels each granularity in the organization's own time zone", () => {
    const hour = bucket("2026-11-11T10:00:00+00:00", "2026-11-11T11:00:00+00:00", "1.0000");
    expect(bucketLabel(hour, "hour", "Asia/Karachi")).toBe("3 PM");
    expect(bucketPeriod(hour, "hour", "Asia/Karachi")).toBe("11/11/2026 | 03:00 PM – 04:00 PM");
    const d = bucket(day(4), day(5), "1.0000");
    expect(bucketLabel(d, "day", "UTC")).toBe("4 Nov");
    expect(bucketPeriod(d, "day", "UTC")).toBe("04/11/2026");
    const week = bucket(day(4), day(11), "1.0000");
    expect(bucketPeriod(week, "week", "UTC")).toBe("04/11/2026 – 10/11/2026");
    expect(bucketLabel(bucket("2026-10-11T00:00:00+00:00", "2026-11-11T00:00:00+00:00", "1.0000"), "month", "UTC")).toBe("Oct 26");
    expect(signedWithCurrency("350000.0000", "PKR")).toBe("+PKR 350,000.00");
    expect(signedWithCurrency("-50000.5000", "PKR")).toBe("-PKR 50,000.50");
    expect(signedWithCurrency("0.0000", "PKR")).toBe("PKR 0.00");
  });
});

describe("the chart", () => {
  const show = (trend: PnlTrend = WEEK) => render(<PnlChart state={{ status: "ready", trend }} currency="PKR" onRetry={() => undefined} />);

  it("has the heading, the subtitle, and the zero baseline", () => {
    show();
    expect(screen.getByRole("heading", { name: "Profit & Loss Trend" })).toBeTruthy();
    expect(screen.getByText("Track your business profitability over time.")).toBeTruthy();
    expect(screen.getByTestId("pnl-baseline")).toBeTruthy();
  });

  it("draws one bar per period: profit above (green), loss below (red), no misleading bar for no activity, a marker for a zero result", () => {
    show();
    const bars = screen.getAllByTestId("pnl-bar");
    expect(bars.map((b) => b.getAttribute("data-kind"))).toEqual(["profit", "none", "loss", "zero", "loss", "none", "none"]);
    const profit = bars[0].querySelector("span")!;
    const loss = bars[2].querySelector("span")!;
    expect(profit.className).toContain("--ix-profit-rgb");
    expect(profit.className).toContain("rounded-t-md");
    expect(loss.className).toContain("bg-red-400");
    expect(loss.className).toContain("rounded-b-md");
    expect(bars[1].querySelector("span")).toBeNull(); // nothing happened: no bar at all
    expect(bars[0].getAttribute("aria-label")).toContain("profit +PKR 400,000.00");
    expect(bars[2].getAttribute("aria-label")).toContain("loss -PKR 100,000.00");
    expect(bars[1].getAttribute("aria-label")).toContain("no activity");
  });

  it("the bars grow from the baseline, with a transition that is switched off for reduced motion", async () => {
    show();
    const profit = screen.getAllByTestId("pnl-bar")[0].querySelector("span")!;
    expect(profit.className).toContain("transition-[height]");
    expect(profit.className).toContain("motion-reduce:transition-none");
    await waitFor(() => expect(profit.style.height).toBe(`${(400000 / 600000) * 100}%`));
    expect(profit.style.bottom).toBe(`${(100000 / 600000) * 100}%`); // it stands ON the baseline
    const loss = screen.getAllByTestId("pnl-bar")[2].querySelector("span")!;
    expect(loss.style.top).toBe(`${100 - (100000 / 600000) * 100}%`); // it hangs FROM the baseline
  });

  it("the summary: total net, profitable periods, loss-making periods - zero-activity periods are neither", () => {
    show();
    expect(screen.getByTestId("pnl-total").textContent).toBe("+PKR 250,000.00");
    expect(screen.getByTestId("pnl-profitable").textContent).toBe("2");
    expect(screen.getByTestId("pnl-loss").textContent).toBe("1");
    expect(screen.getByText("Profitable periods")).toBeTruthy();
    expect(screen.getByText("Loss-making periods")).toBeTruthy();
  });

  it("hovering a bar shows the exact figures the service sent", async () => {
    show();
    await userEvent.hover(screen.getAllByTestId("pnl-bar")[0]);
    const tip = screen.getByTestId("pnl-tooltip");
    expect(tip.getAttribute("role")).toBe("tooltip");
    for (const text of ["04/11/2026", "Sales Revenue", "PKR 2,400,000.00", "Cost of Goods Sold", "PKR 2,000,000.00", "Expenses / Adjustments", "Net Profit / Loss", "+PKR 400,000.00"]) expect(tip.textContent, text).toContain(text);
    expect(screen.getByTestId("pnl-tooltip-net").className).toContain("--ix-profit-rgb"); // a profit is green
    await userEvent.hover(screen.getAllByTestId("pnl-bar")[2]);
    expect(screen.getByTestId("pnl-tooltip-net").textContent).toBe("-PKR 100,000.00");
    expect(screen.getByTestId("pnl-tooltip-net").className).toContain("text-red-");
    await userEvent.unhover(screen.getAllByTestId("pnl-bar")[2]);
  });

  it("the expenses and adjustments line is the cost that is not goods sold", async () => {
    show();
    await userEvent.hover(screen.getAllByTestId("pnl-bar")[4]);
    expect(screen.getByTestId("pnl-tooltip").textContent).toContain("Expenses / AdjustmentsPKR 50,000.00");
    expect(screen.getByTestId("pnl-tooltip-net").textContent).toBe("-PKR 50,000.00");
  });

  it("a tap opens the tooltip and a tap anywhere else closes it; the keyboard works too", async () => {
    show();
    fireEvent.click(screen.getAllByTestId("pnl-bar")[2]); // a tap
    expect(screen.getByTestId("pnl-tooltip-net").textContent).toBe("-PKR 100,000.00");
    fireEvent.click(screen.getAllByTestId("pnl-bar")[2]);
    expect(screen.getByTestId("pnl-tooltip")).toBeTruthy(); // tapping the same bar again does not hide what was just opened
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("pnl-tooltip")).toBeNull();
    act(() => screen.getAllByTestId("pnl-bar")[0].focus());
    expect(screen.getByTestId("pnl-tooltip")).toBeTruthy();
    fireEvent.keyDown(screen.getAllByTestId("pnl-bar")[0], { key: "Escape" });
    expect(screen.queryByTestId("pnl-tooltip")).toBeNull();
  });

  it("a net of zero over activity says so, and is neither profit nor loss", () => {
    const zero: PnlTrend = { ...withNets(["0.0000"]), by_currency: { PKR: { currency_code: "PKR", totals: { net: "0.0000", profitable_periods: 0, loss_periods: 0, has_activity: true, needs_cost_count: 0 }, buckets: [bucket(day(1), day(2), "0.0000", { has_activity: true })] } } };
    show(zero);
    expect(screen.getByTestId("pnl-zero").textContent).toContain("balance out to zero");
    expect(screen.getByTestId("pnl-total").textContent).toBe("PKR 0.00");
    expect(screen.getByTestId("pnl-bar").getAttribute("data-kind")).toBe("zero");
  });

  it("no activity is its own message - not zero profit, not a chart of nothing", () => {
    show({ ...WEEK, by_currency: { PKR: { ...WEEK.by_currency.PKR, totals: { net: "0.0000", profitable_periods: 0, loss_periods: 0, has_activity: false, needs_cost_count: 0 }, buckets: WEEK.by_currency.PKR.buckets.map((b) => ({ ...b, net: "0.0000", has_activity: false })) } } });
    expect(screen.getByTestId("pnl-empty").textContent).toBe("No profit or loss activity for this period.");
    expect(screen.queryByTestId("pnl-baseline")).toBeNull();
    cleanup();
    show({ ...WEEK, currencies: [], by_currency: {} }); // no records at all
    expect(screen.getByTestId("pnl-empty")).toBeTruthy();
  });

  it("incomplete information is announced instead of a misleading total", () => {
    show({ ...WEEK, incomplete: { needs_price: 0, needs_cost: 2 } });
    expect(screen.getByTestId("pnl-incomplete").textContent).toContain("2 deliveries have no reliable cost yet");
    expect(screen.getByTestId("pnl-incomplete").textContent).toContain("not in this chart");
    cleanup();
    show({ ...WEEK, by_currency: { PKR: { ...WEEK.by_currency.PKR, totals: { ...WEEK.by_currency.PKR.totals, has_activity: false }, buckets: [] } }, incomplete: { needs_price: 1, needs_cost: 0 } });
    expect(screen.getByTestId("pnl-incomplete").textContent).toContain("1 delivery has no reliable price");
    expect(screen.getByTestId("pnl-empty")).toBeTruthy(); // and it is not shown as a zero profit
  });

  it("says when other currencies are not added to the one shown", () => {
    show({ ...WEEK, currencies: ["PKR", "USD"], combined_available: false });
    expect(screen.getByText(/Shown in PKR only: other currencies are never added to it/)).toBeTruthy();
  });

  it("loading and a failed service are different states, and the failure offers a retry", async () => {
    const retry = vi.fn();
    const { rerender } = render(<PnlChart state={{ status: "loading" }} currency="PKR" onRetry={retry} />);
    expect(screen.getByRole("status").textContent).toContain("Loading profit and loss");
    rerender(<PnlChart state={{ status: "error", message: "x" }} currency="PKR" onRetry={retry} />);
    expect(screen.getByTestId("pnl-error").textContent).toContain("We couldn't load the profit and loss chart");
    expect(screen.queryByTestId("pnl-empty")).toBeNull(); // never confused with "no activity"
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("stays inside its container and follows the theme (tokens only; green and red are the profit/loss colours)", () => {
    const source = readFileSync(join(__dirname, "..", "src", "app", "finance", "pnl-chart.tsx"), "utf8");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:bg|text|border)-(?:white|black|slate-\d+|gray-\d+|zinc-\d+)\b/);
    expect(source).not.toMatch(/mock|demo|sample data/i);
    const css = readFileSync(join(__dirname, "..", "src", "app", "globals.css"), "utf8");
    expect(css).toMatch(/:root \{ --ix-profit-rgb: \d+ \d+ \d+; \}/);
    expect(css).toMatch(/:root\[data-ix-scheme="light"\] \{ --ix-profit-rgb: \d+ \d+ \d+; \}/); // a darker green on the light background
    const { container } = show();
    expect(container.querySelector(".pr-1")).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/width:\s*\d{4,}px/);
  });
});

// ---- connected to the Finance page's date filter -------------------------------------------------------------------------------------------------
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const flat = { absolute: "0.0000", percent: "0.0", state: "value" as const, direction: "flat" as const };
const summary = (period: string): any => ({
  period: { key: period, label: period, start: day(4), end: day(11), timezone: "UTC" }, default_currency: "PKR", currencies: ["PKR"], combined_available: true, combined_note: null, setup_required: false, setup_message: null,
  has_opening_position: false, reconciliation: { needs_cost: 0, needs_price: 0, total: 0 },
  by_currency: { PKR: { currency_code: "PKR", capital: { ready: true, basis: "owner_records", closing: "1.0000", opening: "1.0000", change: flat },
    investment: { closing: "1.0000", opening: "1.0000", change: flat, contributions: "0.0000", withdrawals: "0.0000", net_invested: "0.0000", inventory_purchases: "0.0000" },
    profit_loss: { net: "250000.0000", gross_profit: "250000.0000", revenue: "1.0000", cost_of_goods_sold: "1.0000", expenses: "0.0000", adjustments: "0.0000", needs_cost_count: 0, needs_cost_revenue: "0.0000" }, trend: [] } },
});
const history = { items: [], total: 0, limit: 25, offset: 0, period: { key: "1w", label: "1 Week", start: day(4), end: day(11) } };

describe("the date filter drives the chart", () => {
  it("asks for the chart of the chosen period and replaces the bars; a failure shows a retry that recovers", async () => {
    const calls: string[] = [];
    let fail = false;
    const month: PnlTrend = { ...WEEK, period: { ...WEEK.period, key: "1m", label: "1 Month" }, granularity: "week", by_currency: { PKR: { ...WEEK.by_currency.PKR, buckets: WEEK.by_currency.PKR.buckets.slice(0, 5) } } };
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("/api/finance/pnl-trend")) return fail ? json(503, { error: "The finance service is unavailable." }) : json(200, url.endsWith("1y") ? { ...WEEK, granularity: "month", period: { ...WEEK.period, key: "1y" } } : month);
      if (url.startsWith("/api/finance/summary")) return json(200, summary(new URL(url, "http://x").searchParams.get("period")!));
      if (url.startsWith("/api/finance/history")) return json(200, history);
      return json(200, {});
    }));
    render(<FinanceView initialSummary={summary("1m")} initialHistory={history as any} expenseCategories={[]} initialPnl={month} />);
    expect(screen.getAllByTestId("pnl-bar")).toHaveLength(5);
    await userEvent.click(screen.getByRole("radio", { name: "1 Year" }));
    await waitFor(() => expect(screen.getAllByTestId("pnl-bar")).toHaveLength(7));
    expect(calls.filter((c) => c.startsWith("/api/finance/pnl-trend"))).toEqual(["/api/finance/pnl-trend?period=1y"]);
    fail = true;
    await userEvent.click(screen.getByRole("radio", { name: "1 Week" }));
    expect(await screen.findByTestId("pnl-error")).toBeTruthy();
    expect(screen.getByTestId("capital-value")).toBeTruthy(); // the figures above stay
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByTestId("pnl-error")).toBeNull());
    expect(calls.at(-1)).toBe("/api/finance/pnl-trend?period=1w");
    expect(screen.getByTestId("pnl-total").textContent!.replace("+PKR ", "")).toBe(screen.getByTestId("pnl-value").textContent!.replace("PKR +", "")); // the chart total is the Profit & Loss card's net
  });
});

describe("one accent colour", () => {
  it("the Finance page never uses the yellow warning colour: highlighted text takes the theme accent", () => {
    for (const file of ["finance-view.tsx", "summary-cards.tsx", "history-panel.tsx", "pnl-chart.tsx"]) {
      const source = readFileSync(join(__dirname, "..", "src", "app", "finance", file), "utf8");
      expect(source, file).not.toMatch(/amber-/);
    }
  });
});
