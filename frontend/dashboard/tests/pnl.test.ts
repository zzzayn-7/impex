import { describe, expect, it } from "vitest";

import { amountOf, computePnl, goodsCostOf, magnitude } from "@/lib/pnl";

describe("PNL calculator arithmetic", () => {
  it("reads an amount exactly: a blank box is zero, anything else must be a plain number with at most 4 decimals", () => {
    expect(amountOf("")).toBe("0.0000");
    expect(amountOf("   ")).toBe("0.0000");
    expect(amountOf("12.5")).toBe("12.5000");
    expect(amountOf("0")).toBe("0.0000");
    expect(amountOf("99999999999999.9999")).toBe("99999999999999.9999");
    for (const bad of ["1,5", "-1", "abc", "1e3", "12.34567", ".5", "5.", "1 000", "99999999999999999", "+3", "0x10"]) expect(amountOf(bad), bad).toBeNull();
  });

  it("profit = selling price - goods - delivery - every other expense, to the last decimal", () => {
    const r = computePnl({ selling: "500000", goods: "300000", delivery: "20000", others: [{ label: "Packing", amount: "5000" }, { label: "Fuel", amount: "2500.5" }] })!;
    expect(r).toMatchObject({ selling: "500000.0000", goods: "300000.0000", delivery: "20000.0000", others: "7500.5000", expenses: "327500.5000", profit: "172499.5000", verdict: "profit" });
  });

  it("says Loss when the expenses are more than the selling price, with the difference", () => {
    const r = computePnl({ selling: "1000", goods: "900", delivery: "150.25", others: [] })!;
    expect(r.profit).toBe("-50.2500");
    expect(r.verdict).toBe("loss");
    expect(magnitude(r.profit)).toBe("50.2500");
  });

  it("says no profit, no loss when they are equal, and never loses a fraction to floating point", () => {
    expect(computePnl({ selling: "300.30", goods: "0.1", delivery: "0.2", others: [{ label: "x", amount: "300" }] })!).toMatchObject({ profit: "0.0000", verdict: "even" });
    expect(computePnl({ selling: "0.3", goods: "0.1", delivery: "0.2", others: [] })!.verdict).toBe("even"); // 0.1 + 0.2 is not 0.30000000000000004 here
  });

  it("blank boxes count as zero, and one bad amount makes the whole result unavailable", () => {
    expect(computePnl({ selling: "100", goods: "", delivery: "", others: [{ label: "x", amount: "" }] })).toMatchObject({ profit: "100.0000", verdict: "profit" });
    expect(computePnl({ selling: "100", goods: "abc", delivery: "", others: [] })).toBeNull();
    expect(computePnl({ selling: "100", goods: "1", delivery: "-2", others: [] })).toBeNull();
    expect(computePnl({ selling: "100", goods: "1", delivery: "", others: [{ label: "x", amount: "1,5" }] })).toBeNull();
  });

  it("magnitude only drops the minus sign", () => {
    expect(magnitude("-12.5000")).toBe("12.5000");
    expect(magnitude("12.5000")).toBe("12.5000");
  });
});

describe("the cost of the goods on an order", () => {
  const lines = [{ product_id: "a", ordered_quantity: "10.0000" }, { product_id: "b", ordered_quantity: "2.5000" }];

  it("is quantity x the product's cost price, added up exactly", () => {
    expect(goodsCostOf(lines, { a: { cost_price: "3.2000", currency_code: "USD" }, b: { cost_price: "10.0000", currency_code: "USD" } }, "USD")).toEqual({ value: "57.0000", complete: true, missing: 0 });
    expect(goodsCostOf([{ product_id: "a", ordered_quantity: "3" }], { a: { cost_price: "0.3333", currency_code: "USD" } }, "USD").value).toBe("0.9999");
  });

  it("is incomplete, and says how many products could not be priced, when a cost is unknown or in another currency (nothing is converted)", () => {
    const some = goodsCostOf(lines, { a: { cost_price: "3.2000", currency_code: "USD" }, b: { cost_price: "10.0000", currency_code: "EUR" } }, "USD");
    expect(some).toEqual({ value: "32.0000", complete: false, missing: 1 });
    expect(goodsCostOf(lines, {}, "USD")).toEqual({ value: "0.0000", complete: false, missing: 2 });
  });
});
