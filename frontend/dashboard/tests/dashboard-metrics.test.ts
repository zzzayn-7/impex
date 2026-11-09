import { describe, expect, it } from "vitest";

import { amountOf, dayInZone, formatAmount, lastDays, lastMonths, monthLabel, monthlyTotals, movementActivity, primaryCurrency, startOfMonths, toPlot, totalsByCurrency } from "@/lib/dashboard-metrics";
import { navGroups } from "@/lib/dashboard-nav";
import { DEFAULT_PREFERENCES } from "@/lib/format";

describe("money is totalled per currency, exactly, and currencies are never mixed", () => {
  it("adds each currency on its own", () => {
    expect(totalsByCurrency([
      { currency: "USD", amount: "10.5000" }, { currency: "EUR", amount: "7.0000" }, { currency: "USD", amount: "0.2500" }, { currency: "EUR", amount: "0.0001" },
    ])).toEqual([{ currency: "EUR", amount: "7.0001" }, { currency: "USD", amount: "10.7500" }]);
  });

  it("is exact where floating point is not", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(totalsByCurrency([{ currency: "USD", amount: "0.1" }, { currency: "USD", amount: "0.2" }])).toEqual([{ currency: "USD", amount: "0.3000" }]);
    expect(totalsByCurrency([{ currency: "USD", amount: "99999999999999.9999" }, { currency: "USD", amount: "0.0001" }])[0].amount).toBe("100000000000000.0000");
  });

  it("ignores anything that is not a currency code, and an empty list has no totals", () => {
    expect(totalsByCurrency([{ currency: "usd", amount: "5" }, { currency: "", amount: "5" }, { currency: "DOLLARS", amount: "5" }])).toEqual([]);
    expect(totalsByCurrency([])).toEqual([]);
    expect(amountOf([], "USD")).toBe("0.0000");
    expect(amountOf([{ currency: "EUR", amount: "5.0000" }], "USD")).toBe("0.0000");
  });

  it("the headline currency is the organization's default when it has data in it, else the most used one", () => {
    expect(primaryCurrency([{ currency: "EUR" }, { currency: "USD" }], "USD")).toBe("USD");
    expect(primaryCurrency([{ currency: "EUR" }, { currency: "EUR" }, { currency: "GBP" }], "USD")).toBe("EUR");
    expect(primaryCurrency([{ currency: "GBP" }, { currency: "EUR" }], "USD")).toBe("EUR"); // a tie is broken alphabetically, never by chance
    expect(primaryCurrency([], "USD")).toBeNull();
  });
});

describe("the calendar", () => {
  it("the last months run oldest first and cross the year", () => {
    expect(lastMonths("2026-11-07", 6)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(lastMonths("2026-02-15", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(lastMonths("nonsense", 6)).toEqual([]);
    expect(startOfMonths(lastMonths("2026-11-07", 6))).toBe("2026-06-01");
    expect(monthLabel("2026-06")).toBe("Jun");
  });

  it("the last days run oldest first, across month and year ends", () => {
    expect(lastDays("2026-03-02", 4)).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(lastDays("2026-01-01", 2)).toEqual(["2025-12-31", "2026-01-01"]);
    expect(lastDays("2024-03-01", 2)).toEqual(["2024-02-29", "2024-03-01"]);
  });

  it("a stored instant belongs to the day it is in the ORGANIZATION's time zone", () => {
    expect(dayInZone("2026-11-07T23:30:00+00:00", "UTC")).toBe("2026-11-07");
    expect(dayInZone("2026-11-07T23:30:00+00:00", "Asia/Karachi")).toBe("2026-11-08");
    expect(dayInZone("2026-11-07T01:30:00+00:00", "America/New_York")).toBe("2026-11-06");
    expect(dayInZone("not a date", "UTC")).toBeNull();
    expect(dayInZone("2026-11-07T00:00:00+00:00", "Not/AZone")).toBeNull();
  });
});

describe("series", () => {
  it("monthly totals are exact, per currency, and ignore rows outside the months", () => {
    const rows = [
      { date: "2026-10-03", currency: "USD", amount: "0.1" }, { date: "2026-10-30", currency: "USD", amount: "0.2" }, { date: "2026-10-30", currency: "EUR", amount: "99" },
      { date: "2026-11-01", currency: "USD", amount: "5.5" }, { date: "2025-10-30", currency: "USD", amount: "1000" }, { date: "2026-12-01", currency: "USD", amount: "7" },
    ];
    expect(monthlyTotals(rows, ["2026-09", "2026-10", "2026-11"], "USD")).toEqual(["0.0000", "0.3000", "5.5000"]);
    expect(monthlyTotals(rows, ["2026-10"], "EUR")).toEqual(["99.0000"]);
    expect(monthlyTotals(rows, ["2026-10"], "GBP")).toEqual(["0.0000"]);
  });

  it("stock movements are counted per day in the organization's zone", () => {
    const days = ["2026-11-06", "2026-11-07"];
    const movements = [
      { movement_type: "in", created_at: "2026-11-07T10:00:00+00:00" }, { movement_type: "opening", created_at: "2026-11-07T11:00:00+00:00" },
      { movement_type: "out", created_at: "2026-11-07T12:00:00+00:00" }, { movement_type: "out", created_at: "2026-11-06T09:00:00+00:00" },
      { movement_type: "in", created_at: "2026-10-01T09:00:00+00:00" },
    ];
    expect(movementActivity(movements, days, "UTC")).toEqual([{ day: "2026-11-06", added: 0, removed: 1 }, { day: "2026-11-07", added: 2, removed: 1 }]);
    expect(movementActivity([{ movement_type: "in", created_at: "2026-11-07T23:30:00+00:00" }], days, "Asia/Karachi")).toEqual([{ day: "2026-11-06", added: 0, removed: 0 }, { day: "2026-11-07", added: 0, removed: 0 }]); // (that is 8 Nov there)
  });

  it("plot positions come from the exact strings and never leak into what is written", () => {
    expect(toPlot("12.5000")).toBe(12.5);
    expect(toPlot("nonsense")).toBe(0);
  });
});

describe("amounts are written in the organization's format and never rounded", () => {
  const indian = { ...DEFAULT_PREFERENCES, number_format: "indian" as const };
  const european = { ...DEFAULT_PREFERENCES, number_format: "dot_comma" as const };
  it("drops only trailing zeros beyond two decimals", () => {
    expect(formatAmount("1234567.5000", DEFAULT_PREFERENCES)).toBe("1,234,567.50");
    expect(formatAmount("198.0000", DEFAULT_PREFERENCES)).toBe("198.00");
    expect(formatAmount("0.3333", DEFAULT_PREFERENCES)).toBe("0.3333");
    expect(formatAmount("0.0001", DEFAULT_PREFERENCES)).toBe("0.0001");
    expect(formatAmount("1234567.5000", indian)).toBe("12,34,567.50");
    expect(formatAmount("1234567.5000", european)).toBe("1.234.567,50");
    expect(formatAmount("-5.0000", DEFAULT_PREFERENCES)).toBe("-5.00");
    expect(formatAmount("oops", DEFAULT_PREFERENCES)).toBe("oops");
  });
});

describe("the sidebar lists exactly what the organization can use", () => {
  const labels = (modules: unknown) => navGroups(modules).map((g) => [g.id, g.items.map((i) => i.label)]);
  it("always has Dashboard, Help & Support and Settings - and nothing else without modules", () => {
    expect(labels([])).toEqual([["main", ["Dashboard"]], ["workspace", ["Help & Support", "Settings"]]]);
    expect(labels(undefined)).toEqual(labels([]));
    expect(labels("all")).toEqual(labels([])); // an unknown list means none, never all
  });
  it("groups each enabled module with its pages, in a fixed order", () => {
    expect(labels(["finance", "sales", "inventory", "purchasing"])).toEqual([
      ["main", ["Dashboard"]],
      ["inventory", ["Products", "Stock", "Scan Product", "Movements"]],
      ["purchasing", ["Suppliers", "Purchase Orders", "Goods Receipts"]],
      ["sales", ["Clients", "Create Order", "Delivery Lists", "Invoices"]],
      ["finance", ["Financial Overview", "Accounts", "Expenses", "Journal Entries"]],
      ["workspace", ["Help & Support", "Settings"]],
    ]);
  });
  it("Finance shows only when enabled; Sales and Purchasing need Inventory", () => {
    expect(labels(["inventory"]).map(([id]) => id)).toEqual(["main", "inventory", "workspace"]);
    expect(labels(["finance"]).map(([id]) => id)).toEqual(["main", "finance", "workspace"]);
    expect(labels(["sales", "purchasing"]).map(([id]) => id)).toEqual(["main", "workspace"]);
  });
  it("every entry has a route, an icon and a unique key", () => {
    const items = navGroups(["inventory", "purchasing", "sales", "finance"]).flatMap((g) => g.items);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.href)).size).toBe(items.length);
    for (const item of items) expect(item.href.startsWith("/") && item.icon).toBeTruthy();
  });
});
