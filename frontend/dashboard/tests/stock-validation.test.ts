import { describe, expect, it, vi } from "vitest";

import {
  EMPTY_STOCK_FORM,
  EMPTY_WAREHOUSE,
  IDEMPOTENCY_KEY_RE,
  formatQuantity,
  newIdempotencyKey,
  normalizeStock,
  normalizeWarehouse,
  toStockBody,
  toWarehouseBody,
  validateQuantity,
  validateStock,
  validateWarehouse,
} from "@/lib/stock-validation";

const P = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";

describe("warehouse validation", () => {
  it("normalizes code (upper case) and name (single spaces) before checking", () => {
    expect(normalizeWarehouse({ code: " main-01 ", name: "  Main   depot ", address: "  1 Dock Rd " })).toEqual({ code: "MAIN-01", name: "Main depot", address: "1 Dock Rd" });
  });

  it("requires code and name, but not the address", () => {
    expect(Object.keys(validateWarehouse(EMPTY_WAREHOUSE)).sort()).toEqual(["code", "name"]);
    expect(validateWarehouse({ code: "MAIN", name: "Main", address: "" })).toEqual({});
  });

  it.each(["has space", "-LEADING", "A".repeat(33), "bad/slash", "ünï"])("rejects the code %j", (code) => {
    expect(validateWarehouse({ code, name: "X" }).code).toBeTruthy();
  });

  it("checks only the fields that are present when editing", () => {
    expect(validateWarehouse({ name: "New name" }, false)).toEqual({});
    expect(validateWarehouse({ code: "bad code" }, false).code).toBeTruthy();
    expect(validateWarehouse({ name: "" }, false).name).toBeTruthy();
  });

  it("sends a blank address as null so editing can clear it, and never includes an organization", () => {
    expect(toWarehouseBody({ code: "MAIN", name: "Main", address: "" })).toEqual({ code: "MAIN", name: "Main", address: null });
    expect(toWarehouseBody({ name: "Only name" })).toEqual({ name: "Only name" });
    expect(Object.keys(toWarehouseBody({ code: "A", name: "B", address: "C" })).join()).not.toMatch(/org|tenant/i);
  });
});

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
  const base = { ...EMPTY_STOCK_FORM, productId: P, warehouseId: W1, quantity: "5" };

  it("accepts a valid add / remove / opening", () => {
    for (const action of ["in", "out", "opening"] as const) expect(validateStock(action, base, false)).toEqual({});
  });

  it("asks for the missing choices", () => {
    expect(Object.keys(validateStock("in", EMPTY_STOCK_FORM, true)).sort()).toEqual(["productId", "quantity", "warehouseId"]);
    expect(Object.keys(validateStock("transfer", EMPTY_STOCK_FORM, true)).sort()).toEqual(["fromWarehouseId", "productId", "quantity", "toWarehouseId"]);
  });

  it("refuses a transfer to the same warehouse", () => {
    const errors = validateStock("transfer", { ...base, fromWarehouseId: W1, toWarehouseId: W1 }, true);
    expect(errors.toWarehouseId).toContain("different");
    expect(validateStock("transfer", { ...base, fromWarehouseId: W1, toWarehouseId: W2 }, true)).toEqual({});
  });

  it("applies the unit rule to the quantity", () => {
    expect(validateStock("in", { ...base, quantity: "1.5" }, false, "pcs").quantity).toContain("whole number");
    expect(validateStock("in", { ...base, quantity: "1.5" }, true, "kg")).toEqual({});
  });

  it("limits the reason length", () => {
    expect(validateStock("in", { ...base, reason: "x".repeat(256) }, true).reason).toBeTruthy();
  });

  it("builds bodies that never name an organization", () => {
    expect(toStockBody("in", { ...base, reason: "Delivery" })).toEqual({ product_id: P, warehouse_id: W1, quantity: "5", reason: "Delivery" });
    expect(toStockBody("transfer", { ...base, fromWarehouseId: W1, toWarehouseId: W2 })).toEqual({ product_id: P, from_warehouse_id: W1, to_warehouse_id: W2, quantity: "5" });
    expect(JSON.stringify(toStockBody("out", base))).not.toMatch(/org|tenant/i);
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
