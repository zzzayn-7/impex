import { describe, expect, it } from "vitest";

import { parsePlan, splitInstallments } from "@/lib/installments";

describe("installments", () => {
  it("splits the total into equal parts to the cent, the last taking the leftover, always adding up exactly", () => {
    expect(splitInstallments("500000.0000", 5)).toEqual(Array(5).fill("100000.0000"));
    expect(splitInstallments("100.0000", 3)).toEqual(["33.3300", "33.3300", "33.3400"]);
    expect(splitInstallments("350.0000", 3)).toEqual(["116.6600", "116.6600", "116.6800"]);
    for (const total of ["0.0700", "1234567.8900", "10.0100", "99999999999999.9999"]) {
      for (const count of [2, 3, 4, 5]) {
        const parts = splitInstallments(total, count);
        const sum = parts.reduce((a, b) => a + BigInt(b.replace(".", "")), BigInt(0));
        expect(parts).toHaveLength(count);
        expect(sum).toBe(BigInt(total.replace(".", "")));
      }
    }
  });

  it("accepts only a whole plan: 2 to 5 payments, a whole number of days (365), weeks (52) or months (12)", () => {
    expect(parsePlan({ count: 5, every: 1, unit: "months" })).toEqual({ count: 5, every: 1, unit: "months" });
    expect(parsePlan({ count: 2, every: 365, unit: "days" })).not.toBeNull();
    expect(parsePlan({ count: 2, every: 52, unit: "weeks" })).not.toBeNull();
    for (const bad of [null, undefined, "x", {}, { count: 1, every: 1, unit: "days" }, { count: 6, every: 1, unit: "days" }, { count: 2.5, every: 1, unit: "days" }, { count: "3", every: 1, unit: "days" },
      { count: 3, every: 0, unit: "days" }, { count: 3, every: 366, unit: "days" }, { count: 3, every: 53, unit: "weeks" }, { count: 3, every: 13, unit: "months" }, { count: 3, every: 1, unit: "years" }, { count: 3, every: NaN, unit: "days" }, { count: 3, every: 1 }]) {
      expect(parsePlan(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
