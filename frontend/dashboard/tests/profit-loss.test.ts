import { describe, expect, it } from "vitest";

import { bpsOf, buildReport, formatBps, parsePeriod, periodSince } from "@/lib/profit-loss";

describe("the percentage of a profit or loss", () => {
  it("is profit / everything invested, in hundredths of a percent, rounded half away from zero", () => {
    expect(bpsOf("10000.0000", "100000.0000")).toBe(1000); // +10%
    expect(bpsOf("-5250.0000", "100000.0000")).toBe(-525); // -5.25%
    expect(bpsOf("1.0000", "3.0000")).toBe(3333);
    expect(bpsOf("2.0000", "3.0000")).toBe(6667);
    expect(bpsOf("-1.0000", "3.0000")).toBe(-3333);
    expect(bpsOf("-2.0000", "3.0000")).toBe(-6667);
    expect(bpsOf("0.0000", "50.0000")).toBe(0);
    expect(bpsOf("5.0000", "0.0000")).toBeNull(); // nothing invested: nothing to compare with
  });

  it("is written with a sign and at most two decimals: +10%, +12.5%, -5.25%", () => {
    expect(formatBps(1000)).toBe("+10%");
    expect(formatBps(1250)).toBe("+12.5%");
    expect(formatBps(525)).toBe("+5.25%");
    expect(formatBps(-525)).toBe("-5.25%");
    expect(formatBps(-1000)).toBe("-10%");
    expect(formatBps(0)).toBe("0%");
    expect(formatBps(5)).toBe("+0.05%");
    expect(formatBps(-5)).toBe("-0.05%");
    expect(formatBps(10)).toBe("+0.1%");
    expect(formatBps(100)).toBe("+1%");
    expect(formatBps(123456)).toBe("+1234.56%");
  });
});

describe("the periods of the portfolio", () => {
  const at = (iso: string) => new Date(iso);
  const since = (key: any, now: string) => periodSince(key, at(now)).toISOString();

  it("a day is 24 hours and a week 7 days back", () => {
    expect(since("1d", "2026-11-16T12:00:00.000Z")).toBe("2026-11-15T12:00:00.000Z");
    expect(since("1w", "2026-11-16T12:00:00.000Z")).toBe("2026-11-09T12:00:00.000Z");
  });

  it("a month, 6 months and a year go back by calendar months, a month-end staying at the end of a shorter month", () => {
    expect(since("1m", "2026-11-16T12:00:00.000Z")).toBe("2026-10-16T12:00:00.000Z");
    expect(since("6m", "2026-11-16T12:00:00.000Z")).toBe("2026-05-16T12:00:00.000Z");
    expect(since("1y", "2026-11-16T12:00:00.000Z")).toBe("2025-11-16T12:00:00.000Z");
    expect(since("1m", "2026-03-31T08:30:00.000Z")).toBe("2026-02-28T08:30:00.000Z");
    expect(since("1m", "2024-03-31T08:30:00.000Z")).toBe("2024-02-29T08:30:00.000Z");
    expect(since("1m", "2026-01-31T00:00:00.000Z")).toBe("2025-12-31T00:00:00.000Z");
    expect(since("6m", "2026-01-15T00:00:00.000Z")).toBe("2025-07-15T00:00:00.000Z");
    expect(since("1y", "2024-02-29T00:00:00.000Z")).toBe("2023-02-28T00:00:00.000Z");
  });

  it("anything that is not one of the five periods is a month", () => {
    expect(parsePeriod("1w")).toBe("1w");
    for (const bad of [undefined, "", "2y", "1M", "all", null, 5, "1d; drop"]) expect(parsePeriod(bad as any)).toBe("1m");
  });
});

describe("the report of delivered orders", () => {
  const order = (id: string, number: string, total: string | null, currency: string | null = "USD") => ({ id, number, client_name: "Alpha Metals", currency_code: currency, total_amount: total, completed_at: "2026-11-10T10:00:00+00:00" });
  const saved = (id: string, goods: string, delivery: string, others: { label: string; amount: string }[] = [], currency = "USD") => ({ order_id: id, currency_code: currency, goods_cost: goods, delivery_charges: delivery, other_expenses: others, updated_by_email: "a@b.c", updated_at: "2026-11-10T10:00:00+00:00" });
  const delivered = [
    order("o1", "SO-1", "500000.0000"), order("o2", "SO-2", "1000.0000"), order("o3", "SO-3", "200.0000"), order("o4", "SO-4", null, null), order("o5", "SO-5", "80.0000", "EUR"),
    order("o6", "SO-6", "100.0000"),
  ];
  const expenses = [saved("o1", "300000", "20000", [{ label: "Packing", amount: "5000" }]), saved("o2", "900", "150"), saved("o5", "50", "5", [], "USD"), saved("o6", "60", "40")];
  const report = buildReport(delivered, expenses as any);
  const row = (n: string) => report.rows.find((r) => r.number === n)!;

  it("works every order out as profit or loss of what was spent on it", () => {
    expect(row("SO-1")).toMatchObject({ state: "profit", profit: "175000.0000", invested: "325000.0000", bps: 5385 }); // +53.85%
    expect(row("SO-2")).toMatchObject({ state: "loss", profit: "-50.0000", invested: "1050.0000", bps: -476 }); // -4.76%
    expect(row("SO-6")).toMatchObject({ state: "even", profit: "0.0000", invested: "100.0000", bps: 0 });
  });

  it("leaves an order out of the profit when its expenses were never entered, were entered in another currency, or the order has no prices", () => {
    expect(row("SO-3")).toMatchObject({ state: "no-expenses", profit: null, bps: null });
    expect(row("SO-5")).toMatchObject({ state: "no-expenses" }); // the saved expenses are in USD, the order in EUR: nothing is converted
    expect(row("SO-4")).toMatchObject({ state: "no-prices" });
    expect(report.notCalculated).toBe(2); // an order with no prices is not "waiting for expenses"
  });

  it("builds one portfolio per currency, never mixing them", () => {
    expect(report.portfolios.map((p) => p.currency)).toEqual(["EUR", "USD"]);
    const usd = report.portfolios.find((p) => p.currency === "USD")!;
    expect(usd).toMatchObject({ orders: 4, sales: "501300.0000", calculated: 3, invested: "326150.0000", profit: "174950.0000", verdict: "profit", bps: 5364 });
    const eur = report.portfolios.find((p) => p.currency === "EUR")!;
    expect(eur).toMatchObject({ orders: 1, sales: "80.0000", calculated: 0, verdict: "none", bps: null });
  });

  it("says Loss for a period that lost money and has nothing to report for an empty one", () => {
    const lost = buildReport([order("a", "SO-A", "100.0000")], [saved("a", "150", "0")] as any);
    expect(lost.portfolios[0]).toMatchObject({ verdict: "loss", profit: "-50.0000", bps: -3333 });
    expect(buildReport([], [])).toEqual({ rows: [], portfolios: [], notCalculated: 0 });
  });
});
