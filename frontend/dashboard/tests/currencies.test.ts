import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CURRENCIES, CURRENCY_CODES, checkCurrency, currencyLabel, isKnownCurrency } from "@/lib/currencies";

// The complete list of currencies offered by the first-time setup and by Settings.

describe("the currency list", () => {
  it("has every code once, in capitals, each with a name, sorted by code", () => {
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length);
    for (const [code, name] of CURRENCIES) { expect(code).toMatch(/^[A-Z]{3}$/); expect(name.length, code).toBeGreaterThan(2); }
    expect([...CURRENCY_CODES].sort()).toEqual(CURRENCY_CODES);
    expect(new Set(CURRENCIES.map(([, name]) => name)).size).toBe(CURRENCIES.length);
  });

  it("includes the currencies of every region, USD among them", () => {
    for (const code of ["USD", "EUR", "GBP", "JPY", "CNY", "INR", "PKR", "AED", "SAR", "CAD", "AUD", "BRL", "MXN", "ZAR", "NGN", "CHF", "RUB", "TRY", "KRW", "XOF", "XAF"]) expect(CURRENCY_CODES, code).toContain(code);
  });

  it("labels a currency with its code and name", () => {
    expect(currencyLabel("USD")).toBe("USD — US Dollar");
    expect(currencyLabel("ZZZ")).toBe("ZZZ"); // not in the list: just the code
  });

  it("only a listed code is a currency", () => {
    expect(checkCurrency("USD")).toEqual({ ok: true, value: "USD" });
    for (const bad of ["usd", "US", "USDX", "XXX", "", " USD", "USD ", null, undefined, 1, ["USD"], {}]) expect(checkCurrency(bad).ok, String(bad)).toBe(false);
    expect(isKnownCurrency("EUR")).toBe(true);
    expect(isKnownCurrency("eur")).toBe(false);
  });

  const service = join(process.cwd(), "..", "..", "services/organization-service/app/currencies.py");
  it.skipIf(!existsSync(service))("is exactly the list the Organization Service accepts", () => {
    const py = readFileSync(service, "utf-8");
    const block = py.slice(py.indexOf('"""', py.indexOf("ISO_4217")) + 3, py.indexOf('""".split()'));
    expect([...block.split(/\s+/).filter(Boolean)].sort()).toEqual([...CURRENCY_CODES].sort());
  });
});
