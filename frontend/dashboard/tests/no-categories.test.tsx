// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import ProductCatalog from "@/app/products/product-catalog";
import ProductForm from "@/app/products/product-form";
import StockOverview from "@/app/stock/stock-overview";
import { EMPTY_PRODUCT, normalizeProduct, toCreateBody, validateProduct } from "@/lib/product-validation";

// The business deals only in hardware products, so products have no category: not in the catalog, the stock overview, the product form, Create Order,
// the API calls or the validation. (Support tickets and finance expenses have categories of their own; those are different things and stay.)

afterEach(cleanup);
const now = "2026-11-09T10:00:00+00:00";
const bolt = { id: "b0000000-0000-4000-8000-000000000001", sku: "BOLT-1", name: "Steel bolt", description: null, unit: "pcs", hs_code: null, cost_price: "1.0000", selling_price: "2.0000", currency_code: "USD", is_active: true, created_at: now, updated_at: now, unit_allows_fractions: false, unit_locked: false };
const stockItem = { product_id: bolt.id, sku: "BOLT-1", name: "Steel bolt", unit: "pcs", unit_allows_fractions: false, is_active: true, total_quantity: "10", reserved_quantity: "0", available_quantity: "10" };

describe("products have no category", () => {
  it("the Products page has no Category column, no category filter and does not search by category", () => {
    render(<ProductCatalog list={{ ok: true, products: [bolt] as any, total: 1, limit: 25, offset: 0 }} filters={{ q: "", status: "active", page: 1 }} />);
    expect(screen.queryByText(/categor/i)).toBeNull();
    expect(screen.queryByRole("combobox", { name: /categor/i })).toBeNull();
    expect(within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Product", "Unit", "HS code", "Cost", "Price", "Status", "Actions"]);
    expect((screen.getByRole("searchbox") as HTMLInputElement).placeholder).toBe("SKU, name, description, HS code");
  });

  it("the product form has no Category field", () => {
    render(<ProductForm onDone={() => undefined} onCancel={() => undefined} />);
    expect(screen.queryByLabelText(/categor/i)).toBeNull();
    expect(screen.getAllByRole("textbox").map((e) => e.getAttribute("name") ?? e.id)).not.toContain("category");
    expect(document.querySelector("datalist#category-options")).toBeNull();
  });

  it("the Stock page has no Category column and searches by SKU or name", () => {
    render(<StockOverview list={{ ok: true, items: [stockItem] as any, total: 1, limit: 25, offset: 0 } as any} filters={{ q: "", inStockOnly: false, status: "active", page: 1 }} products={[bolt] as any} />);
    expect(screen.queryByText(/categor/i)).toBeNull();
    expect((screen.getByRole("searchbox") as HTMLInputElement).placeholder).toBe("SKU or name");
  });

  it("validation and the request body no longer know a category: it is neither required nor sent", () => {
    const values = { ...EMPTY_PRODUCT, sku: "WID-001", name: "Widget", unit: "pcs", costPrice: "1", sellingPrice: "2" };
    expect(validateProduct(normalizeProduct(values))).toEqual({});
    expect(Object.keys(EMPTY_PRODUCT)).not.toContain("category");
    expect(Object.keys(toCreateBody(values))).not.toContain("category");
  });

  it("nothing in the portal's own pages, libraries or API routes mentions an inventory category (support and finance have their own, unrelated ones)", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const root = join(__dirname, "..", "src");
    const files = execSync(`grep -rliI categor ${JSON.stringify(root)} || true`, { encoding: "utf-8" }).split("\n").filter(Boolean).map((f) => f.replace(/\\/g, "/"));
    const ownerOfItsCategories = (f: string) => /\/(support|finance)\b|support|finance-routes/.test(f);
    expect(files.filter((f) => !ownerOfItsCategories(f))).toEqual([]);
    expect(readFileSync(join(root, "lib", "inventory.ts"), "utf-8")).not.toMatch(/categor/i);
  });
});
