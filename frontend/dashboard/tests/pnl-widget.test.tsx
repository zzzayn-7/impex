// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import PnlTrendWidget from "@/components/dashboard/pnl-widget";
import { normalizePreferences } from "@/lib/format";
import { buildPnlWidget, pnlBuckets, pnlSince, type ReportRow } from "@/lib/profit-loss";

// The home page's Profit & loss line graph: its slices of time, the figures built for the five periods, and the widget that draws them.

const NOW = new Date("2026-11-16T12:30:00.000Z");
const row = (id: string, at: string, profit: string, invested: string, state: ReportRow["state"] = profit.startsWith("-") ? "loss" : "profit", currency = "USD"): ReportRow => ({
  id, number: `SO-${id}`, client_name: "Alpha", currency_code: currency, total_amount: "1000.0000", completed_at: at, state, profit, invested, bps: null,
});
const rows: ReportRow[] = [
  row("A", "2026-11-16T10:10:00Z", "100.0000", "400.0000"),
  row("B", "2026-11-15T09:00:00Z", "-30.0000", "300.0000"),
  row("C", "2026-09-01T00:00:00Z", "50.0000", "200.0000"),
  row("D", "2026-11-16T09:00:00Z", "0", "0", "no-expenses"), // never calculated: nothing to plot
  row("E", "2026-11-16T08:00:00Z", "20.0000", "80.0000", "profit", "EUR"),
  row("F", "2025-12-20T08:00:00Z", "10.0000", "90.0000"), // within a year, outside 6 months
  row("G", "2025-10-20T08:00:00Z", "999.0000", "1.0000"), // older than the year
];

describe("the slices of time of each period", () => {
  it("are 24 hours, 7 days, 30 days, 6 months and 12 months, oldest first, the last one holding the present", () => {
    const counts = Object.fromEntries((["1d", "1w", "1m", "6m", "1y"] as const).map((k) => [k, pnlBuckets(k, NOW).length]));
    expect(counts).toEqual({ "1d": 24, "1w": 7, "1m": 30, "6m": 6, "1y": 12 });
    for (const key of ["1d", "1w", "1m", "6m", "1y"] as const) {
      const buckets = pnlBuckets(key, NOW);
      const last = buckets[buckets.length - 1];
      expect(NOW.getTime() >= last.start && NOW.getTime() < last.end, key).toBe(true);
      for (let i = 1; i < buckets.length; i++) expect(buckets[i].start).toBe(buckets[i - 1].end); // no gap, no overlap
    }
  });

  it("are labelled with the hour, the day or the month", () => {
    expect(pnlBuckets("1d", NOW).map((b) => b.label).slice(-2)).toEqual(["11:00", "12:00"]);
    expect(pnlBuckets("1w", NOW).map((b) => b.label)).toEqual(["10 Nov", "11 Nov", "12 Nov", "13 Nov", "14 Nov", "15 Nov", "16 Nov"]);
    expect(pnlBuckets("6m", NOW).map((b) => b.label)).toEqual(["Jun", "Jul", "Aug", "Sep", "Oct", "Nov"]);
    expect(pnlBuckets("1y", NOW)[0].label).toBe("Dec");
  });

  it("reading delivered orders has to go back to the start of the year's first month", () => {
    expect(pnlSince(NOW).toISOString()).toBe("2025-12-01T00:00:00.000Z");
  });
});

describe("the figures built for the five periods", () => {
  const built = buildPnlWidget(rows, NOW);
  const usd = (key: "1d" | "1w" | "1m" | "6m" | "1y") => built.periods[key].find((c) => c.currency === "USD");

  it("count only the orders delivered in the period whose expenses were entered, per currency", () => {
    expect(usd("1d")).toMatchObject({ profit: "100.0000", invested: "400.0000", calculated: 1, bps: 2500 });
    expect(usd("1w")).toMatchObject({ profit: "70.0000", invested: "700.0000", calculated: 2, bps: 1000 }); // 100 - 30 on 700 spent
    expect(usd("1m")).toMatchObject({ profit: "70.0000", calculated: 2 });
    expect(usd("6m")).toMatchObject({ profit: "120.0000", calculated: 3 });
    expect(usd("1y")).toMatchObject({ profit: "130.0000", calculated: 4 }); // the 999 from before the year is not in it
    expect(built.periods["1d"].map((c) => c.currency)).toEqual(["EUR", "USD"]);
    expect(built.periods["1w"].find((c) => c.currency === "EUR")).toMatchObject({ profit: "20.0000", calculated: 1 });
  });

  it("put each order's profit in its own slice and zero everywhere else, so the points always add up to the total", () => {
    const week = usd("1w")!.points;
    expect(week.map((p) => p.value)).toEqual(["0.0000", "0.0000", "0.0000", "0.0000", "0.0000", "-30.0000", "100.0000"]);
    const day = usd("1d")!.points;
    expect(day).toHaveLength(24);
    expect(day[day.length - 3].value).toBe("100.0000"); // the 10:00 slice
    for (const key of ["1d", "1w", "1m", "6m", "1y"] as const) {
      const c = usd(key)!;
      const sum = c.points.reduce((a, p) => a + Number(p.value), 0);
      expect(Math.abs(sum - Number(c.profit)), key).toBeLessThan(0.0001);
    }
    expect(usd("6m")!.points.map((p) => p.value)).toEqual(["0.0000", "0.0000", "0.0000", "50.0000", "0.0000", "70.0000"]);
  });

  it("have nothing to plot for a period with no worked-out order, and remember when Sales is missing", () => {
    expect(buildPnlWidget([], NOW).periods["1y"]).toEqual([]);
    expect(buildPnlWidget(rows.filter((r) => r.state === "no-expenses"), NOW).periods["1m"]).toEqual([]);
    expect(buildPnlWidget([], NOW, true).needsSales).toBe(true);
  });
});

describe("the Profit & loss widget", () => {
  const prefs = normalizePreferences({});
  const built = buildPnlWidget(rows, NOW);
  afterEach(cleanup);

  it("opens on a month with the five period buttons, the total in green, the return and the order count", () => {
    render(<PnlTrendWidget data={built} prefs={prefs} />);
    const group = screen.getByRole("group", { name: "Period" });
    expect(within(group).getAllByRole("button").map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["1 Day", "false"], ["1 Week", "false"], ["1 Month", "true"], ["6 Months", "false"], ["1 Year", "false"],
    ]);
    const total = document.querySelector("[data-pnl-total]")!;
    expect(total.textContent).toBe("+70.00 USD");
    expect(total.className).toContain("text-ix-gain");
    expect(document.querySelector("[data-pnl-return]")!.textContent).toBe("+10%");
    expect(document.querySelectorAll("[data-pnl-chart] circle")).toHaveLength(30);
    expect(document.querySelector("[data-zero-line]")).toBeTruthy();
  });

  it("changing the period redraws the line for it, with no request", async () => {
    render(<PnlTrendWidget data={built} prefs={prefs} />);
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "1 Year" }));
    expect(screen.getByRole("button", { name: "1 Year" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "1 Month" }).getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("[data-pnl-total]")!.textContent).toBe("+130.00 USD");
    expect(document.querySelectorAll("[data-pnl-chart] circle")).toHaveLength(12);
    await u.click(screen.getByRole("button", { name: "1 Day" }));
    expect(document.querySelectorAll("[data-pnl-chart] circle")).toHaveLength(24);
    await u.selectOptions(screen.getByLabelText("Currency"), "USD"); // a day has one order in each currency: the first (EUR) is drawn until another is chosen
    expect(document.querySelector("[data-pnl-total]")!.textContent).toBe("+100.00 USD");
  });

  it("colours the points: green for a profit, red for a loss, neutral for nothing", async () => {
    render(<PnlTrendWidget data={built} prefs={prefs} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "1 Week" }));
    const kinds = Array.from(document.querySelectorAll("[data-point]")).map((c) => c.getAttribute("data-point"));
    expect(kinds).toEqual(["flat", "flat", "flat", "flat", "flat", "loss", "gain"]);
    expect(document.querySelector('[data-point="loss"]')!.getAttribute("class")).toContain("fill-red-400");
    expect(document.querySelector('[data-point="gain"]')!.getAttribute("class")).toContain("fill-ix-gain");
  });

  it("shows a net loss in red with its minus sign", () => {
    const lossy = buildPnlWidget([row("L", "2026-11-16T10:00:00Z", "-80.0000", "400.0000")], NOW);
    render(<PnlTrendWidget data={lossy} prefs={prefs} />);
    expect(document.querySelector("[data-pnl-total]")!.textContent).toBe("-80.00 USD");
    expect(document.querySelector("[data-pnl-total]")!.className).toContain("text-red-400");
    expect(document.querySelector("[data-pnl-return]")!.textContent).toBe("-20%");
    expect(screen.getByText("Loss")).toBeTruthy();
  });

  it("offers a currency choice only when there are several, and draws the chosen one", async () => {
    render(<PnlTrendWidget data={built} prefs={prefs} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "1 Week" }));
    const select = screen.getByLabelText("Currency") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["EUR", "USD"]);
    await userEvent.setup().selectOptions(select, "EUR");
    expect(document.querySelector("[data-pnl-total]")!.textContent).toBe("+20.00 EUR");
    cleanup();
    render(<PnlTrendWidget data={buildPnlWidget([row("A", "2026-11-16T10:10:00Z", "100.0000", "400.0000")], NOW)} prefs={prefs} />);
    expect(screen.queryByLabelText("Currency")).toBeNull();
  });

  it("says plainly when nothing was delivered with expenses in the period (and points at the calculator), and when Sales is missing", () => {
    const { unmount } = render(<PnlTrendWidget data={buildPnlWidget([], NOW)} prefs={prefs} />);
    expect(screen.getByText(/No delivered order with expenses entered/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "PNL Calculator" }).getAttribute("href")).toBe("/pnl-calculator");
    unmount();
    render(<PnlTrendWidget data={buildPnlWidget([], NOW, true)} prefs={prefs} />);
    expect(screen.getByText(/needs the Sales module/)).toBeTruthy();
  });

  it("has a text alternative: a label and a table of every value", () => {
    render(<PnlTrendWidget data={built} prefs={prefs} />);
    expect(screen.getByRole("img", { name: /Profit and loss over the last 1 month in USD/i })).toBeTruthy();
    expect(document.querySelectorAll("[data-pnl-widget] table tbody tr")).toHaveLength(30);
  });
});
