import { describe, expect, it, vi } from "vitest";

import {
  ACTION_LABELS,
  EMPTY_STOCK_FORM,
  IDEMPOTENCY_KEY_RE,
  MOVEMENT_LABELS,
  formatQuantity,
  newIdempotencyKey,
  normalizeStock,
  toStockBody,
  validateQuantity,
  validateStock,
} from "@/lib/stock-validation";

const P = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
describe("quantity validation", () => {
  it.each(["1", "12", "0.5", "2.5000", "99999999999999", "0.0001"])("accepts %s for a measurable unit", (q) => {
    expect(validateQuantity(q, true)).toBeUndefined();
  });

  it.each([["", "Enter"], ["0", "greater than zero"], ["0.0000", "greater than zero"], ["-1", "positive"], ["abc", "positive"], ["1e3", "positive"], ["1,5", "positive"],
    ["1.00001", "positive"], ["123456789012345", "positive"], [" 1", "positive"], ["NaN", "positive"]])("rejects %j", (q, hint) => {
    expect(validateQuantity(q, true)).toContain(hint);
  });

  it("rejects fractions for indivisible units but accepts whole numbers written with zeros", () => {
    expect(validateQuantity("1.5", false, "pcs")).toContain("whole number");
    expect(validateQuantity("1.5", false, "pcs")).toContain("'pcs'");
    expect(validateQuantity("0.0001", false)).toContain("whole number");
    expect(validateQuantity("3", false)).toBeUndefined();
    expect(validateQuantity("3.0000", false)).toBeUndefined();
  });

  it("formats exactly, as text, without rounding", () => {
    expect(formatQuantity("10.5000")).toBe("10.5");
    expect(formatQuantity("1234.0000")).toBe("1,234");
    expect(formatQuantity("0.0000")).toBe("0");
    expect(formatQuantity("0.1000")).toBe("0.1");
    expect(formatQuantity("99999999999999.9999")).toBe("99,999,999,999,999.9999");
    expect(formatQuantity("7")).toBe("7");
  });
});

describe("stock form validation", () => {
  const base = { ...EMPTY_STOCK_FORM, productId: P, quantity: "5" };

  it("accepts a valid add / remove / opening", () => {
    for (const action of ["in", "out", "opening"] as const) expect(validateStock(action, base, false)).toEqual({});
  });

  it("asks for the missing choices", () => {
    expect(Object.keys(validateStock("in", EMPTY_STOCK_FORM, true)).sort()).toEqual(["productId", "quantity"]);
  });

  it("has no warehouse or transfer anywhere in the form", () => {
    expect(Object.keys(EMPTY_STOCK_FORM).sort()).toEqual(["productId", "quantity", "reason"]);
    expect(Object.keys(ACTION_LABELS).sort()).toEqual(["in", "opening", "out"]);
    expect(Object.keys(MOVEMENT_LABELS).sort()).toEqual(["in", "opening", "out"]);
  });

  it("applies the unit rule to the quantity", () => {
    expect(validateStock("in", { ...base, quantity: "1.5" }, false, "pcs").quantity).toContain("whole number");
    expect(validateStock("in", { ...base, quantity: "1.5" }, true, "kg")).toEqual({});
  });

  it("limits the reason length", () => {
    expect(validateStock("in", { ...base, reason: "x".repeat(256) }, true).reason).toBeTruthy();
  });

  it("builds bodies that never name an organization", () => {
    expect(toStockBody("in", { ...base, reason: "Delivery" })).toEqual({ product_id: P, quantity: "5", reason: "Delivery" });
    expect(toStockBody("out", base)).toEqual({ product_id: P, quantity: "5" });
    expect(JSON.stringify(toStockBody("out", base))).not.toMatch(/org|tenant|warehouse/i);
  });

  it("keeps the quantity a string all the way", () => {
    expect(typeof toStockBody("in", { ...base, quantity: "0.1" }).quantity).toBe("string");
    expect(normalizeStock({ quantity: " 2.50 ", reason: " a   b " })).toEqual({ quantity: "2.50", reason: "a b" });
  });
});

describe("idempotency keys", () => {
  it("are unique, and acceptable to the server's rule", () => {
    const keys = new Set(Array.from({ length: 50 }, newIdempotencyKey));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key).toMatch(IDEMPOTENCY_KEY_RE);
  });

  it("still work over plain http, where crypto.randomUUID does not exist (a phone or another PC on the LAN)", () => {
    const real = globalThis.crypto;
    // an insecure-context crypto: getRandomValues only
    vi.stubGlobal("crypto", { getRandomValues: (array: Uint8Array) => real.getRandomValues(array) });
    try {
      expect((globalThis.crypto as any).randomUUID).toBeUndefined();
      const keys = new Set(Array.from({ length: 50 }, newIdempotencyKey));
      expect(keys.size).toBe(50);
      for (const key of keys) {
        expect(key).toMatch(IDEMPOTENCY_KEY_RE);
        expect(key).toMatch(/^ui-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
