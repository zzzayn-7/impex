import { describe, expect, it } from "vitest";

import {
  EMPTY_PRODUCT,
  MONEY_RE,
  Product,
  ProductFormValues,
  formatMoney,
  normalizeProduct,
  plainDecimal,
  productToForm,
  toCreateBody,
  toPatchBody,
  validateProduct,
} from "@/lib/product-validation";

const valid: ProductFormValues = {
  sku: "WID-001", name: "Widget", description: "", unit: "pcs", hsCode: "", costPrice: "10.50",
  sellingPrice: "15.99", currencyCode: "USD",
};

describe("normalizeProduct", () => {
  it("tidies text, upper-cases SKU and currency, and leaves money untouched as a string", () => {
    expect(normalizeProduct({ sku: " wid-001 ", name: "  Steel   bolt ", currencyCode: "usd", costPrice: " 0.1 " })).toEqual({
      sku: "WID-001", name: "Steel bolt", currencyCode: "USD", costPrice: "0.1",
    });
  });
});

describe("validateProduct", () => {
  it("accepts a complete valid product", () => {
    expect(validateProduct(valid)).toEqual({});
  });

  it.each([
    ["sku", { sku: "" }], ["sku", { sku: "has space" }], ["sku", { sku: "bad#" }], ["sku", { sku: "X".repeat(65) }],
    ["name", { name: "" }], ["name", { name: "N".repeat(256) }], ["unit", { unit: "" }],
    ["unit", { unit: "U".repeat(21) }], ["description", { description: "D".repeat(2001) }],
    ["hsCode", { hsCode: "12" }], ["hsCode", { hsCode: "abcd" }], ["hsCode", { hsCode: "8517.1" }],
    ["costPrice", { costPrice: "" }], ["costPrice", { costPrice: "-1" }], ["costPrice", { costPrice: "1.23456" }],
    ["costPrice", { costPrice: "12345678901" }], ["costPrice", { costPrice: "1e3" }], ["costPrice", { costPrice: "12,5" }],
    ["costPrice", { costPrice: "abc" }], ["costPrice", { costPrice: ".5" }], ["sellingPrice", { sellingPrice: "" }],
    ["currencyCode", { currencyCode: "US" }], ["currencyCode", { currencyCode: "USDX" }], ["currencyCode", { currencyCode: "12A" }],
  ])("rejects an invalid %s: %j", (field, change) => {
    expect(Object.keys(validateProduct({ ...valid, ...change }))).toContain(field);
  });

  it.each(["8517", "8517.12", "8517.12.00", "85171200", "8517.12.00.10"])("accepts the HS code %s", (hsCode) => {
    expect(validateProduct({ ...valid, hsCode })).toEqual({});
  });

  it.each(["0", "0.1", "10", "10.5", "10.5000", "9999999999.9999"])("accepts the price %s", (price) => {
    expect(MONEY_RE.test(price)).toBe(true);
  });

  it("checks only the fields present in a partial edit, and allows clearing optional ones", () => {
    expect(validateProduct({ name: "New name" }, false)).toEqual({});
    expect(validateProduct({ hsCode: "", description: "" }, false)).toEqual({});
    expect(Object.keys(validateProduct({ name: "" }, false))).toEqual(["name"]);
    expect(Object.keys(validateProduct({ costPrice: "-3" }, false))).toEqual(["costPrice"]);
  });
});

describe("request bodies", () => {
  it("creating omits blank optional fields, keeps money as the exact strings, and has no organization field", () => {
    const body = toCreateBody({ ...valid, costPrice: "0.1", sellingPrice: "0.2" });
    expect(body).toEqual({ sku: "WID-001", name: "Widget", unit: "pcs", cost_price: "0.1", selling_price: "0.2", currency_code: "USD" });
    expect(Object.keys(body).join()).not.toMatch(/org|tenant/i);
    expect(toCreateBody({ ...valid, description: "d", hsCode: "8517" })).toMatchObject({ description: "d", hs_code: "8517" });
  });

  it("editing sends only the changed fields, and blank optional fields become null (cleared)", () => {
    expect(toPatchBody({ name: "New" })).toEqual({ name: "New" });
    expect(toPatchBody({ description: "", hsCode: "", costPrice: "1.5" })).toEqual({ description: null, hs_code: null, cost_price: "1.5" });
  });
});

describe("money display (strings only, never floating point)", () => {
  it.each([
    ["10.5000", "USD", "10.50 USD"], ["15.9900", "EUR", "15.99 EUR"], ["0.1000", "USD", "0.10 USD"], ["7", "USD", "7.00 USD"],
    ["1234567.8912", "USD", "1,234,567.8912 USD"], ["9999999999.9999", "USD", "9,999,999,999.9999 USD"], ["0.0001", "USD", "0.0001 USD"],
  ])("formats %s %s", (value, currency, expected) => {
    expect(formatMoney(value, currency)).toBe(expected);
  });

  it("plainDecimal keeps at least two decimals for editing", () => {
    expect(plainDecimal("10.5000")).toBe("10.50");
    expect(plainDecimal("0.1234")).toBe("0.1234");
    expect(plainDecimal("5.0000")).toBe("5.00");
  });

  it("round-trips a product into the edit form without losing precision", () => {
    const product: Product = {
      id: "1", sku: "A-1", name: "A", description: null, unit: "pcs", hs_code: null, cost_price: "0.1000",
      selling_price: "1234567.8912", currency_code: "USD", is_active: true, created_at: "", updated_at: "",
    };
    expect(productToForm(product)).toEqual({ ...EMPTY_PRODUCT, sku: "A-1", name: "A", unit: "pcs", costPrice: "0.10", sellingPrice: "1234567.8912" });
  });
});
