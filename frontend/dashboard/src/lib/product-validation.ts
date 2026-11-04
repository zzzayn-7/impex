// Shared by the browser form (instant feedback) and the server routes (the real check).
// Money is ALWAYS a string here: it is never turned into a JavaScript number, so nothing is rounded or
// reformatted on the way to the database (NUMERIC).

export type ProductFormValues = {
  sku: string;
  name: string;
  description: string;
  category: string;
  unit: string;
  hsCode: string;
  costPrice: string;
  sellingPrice: string;
  currencyCode: string;
};

export type ProductFieldErrors = Partial<Record<keyof ProductFormValues, string>>;

// What the Inventory Service returns for one product (no organization_id is ever included).
export type Product = {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string;
  unit: string;
  hs_code: string | null;
  cost_price: string;
  selling_price: string;
  currency_code: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  unit_allows_fractions?: boolean; // decided by the Inventory Service: may this unit be counted in fractions?
  unit_locked?: boolean; // true once the product has stock movements: the unit can no longer be changed
};

export const SKU_RE = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;
export const HS_RE = /^(?:[0-9]{4}(?:\.[0-9]{2}){0,3}|[0-9]{4,10})$/;
export const MONEY_RE = /^[0-9]{1,10}(?:\.[0-9]{1,4})?$/; // at most 10 digits before and 4 after the point
export const CURRENCY_RE = /^[A-Z]{3}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EMPTY_PRODUCT: ProductFormValues = {
  sku: "", name: "", description: "", category: "", unit: "", hsCode: "", costPrice: "", sellingPrice: "", currencyCode: "USD",
};

const NORMALIZERS: { [K in keyof ProductFormValues]: (value: string) => string } = {
  sku: (v) => v.trim().toUpperCase(),
  name: (v) => v.trim().replace(/\s+/g, " "),
  description: (v) => v.trim(),
  category: (v) => v.trim().replace(/\s+/g, " "),
  unit: (v) => v.trim(),
  hsCode: (v) => v.trim(),
  costPrice: (v) => v.trim(),
  sellingPrice: (v) => v.trim(),
  currencyCode: (v) => v.trim().toUpperCase(),
};

// Normalizes only the fields that are present.
export function normalizeProduct<T extends Partial<ProductFormValues>>(values: T): T {
  const out: Partial<ProductFormValues> = {};
  for (const key of Object.keys(values) as (keyof ProductFormValues)[]) {
    const value = values[key];
    if (typeof value === "string") out[key] = NORMALIZERS[key](value);
  }
  return out as T;
}

const REQUIRED: (keyof ProductFormValues)[] = ["sku", "name", "category", "unit", "costPrice", "sellingPrice", "currencyCode"];

const CHECKS: { [K in keyof ProductFormValues]: (value: string) => string | undefined } = {
  sku: (v) =>
    !v ? "Enter a SKU." : v.length > 64 ? "SKU must be 64 characters or fewer." : !SKU_RE.test(v) ? "SKU may contain only letters, digits and . _ - /" : undefined,
  name: (v) => (!v ? "Enter the product name." : v.length > 255 ? "Name must be 255 characters or fewer." : undefined),
  description: (v) => (v.length > 2000 ? "Description must be 2000 characters or fewer." : undefined),
  category: (v) => (!v ? "Enter a category." : v.length > 100 ? "Category must be 100 characters or fewer." : undefined),
  unit: (v) => (!v ? "Enter the unit of measurement (e.g. pcs, kg)." : v.length > 20 ? "Unit must be 20 characters or fewer." : undefined),
  hsCode: (v) => (v && !HS_RE.test(v) ? "HS code must look like 8517, 8517.12 or 8517.12.00." : undefined),
  costPrice: (v) => (!v ? "Enter the cost price." : !MONEY_RE.test(v) ? "Use a number with at most 4 decimals, e.g. 12.50." : undefined),
  sellingPrice: (v) => (!v ? "Enter the selling price." : !MONEY_RE.test(v) ? "Use a number with at most 4 decimals, e.g. 19.99." : undefined),
  currencyCode: (v) => (!CURRENCY_RE.test(v) ? "Use a 3-letter currency code such as USD or EUR." : undefined),
};

// Validates normalized values. With `requireAll`, every required field must be present (creating a product);
// otherwise only the fields that are present are checked (a partial edit).
export function validateProduct(values: Partial<ProductFormValues>, requireAll = true): ProductFieldErrors {
  const errors: ProductFieldErrors = {};
  const keys = requireAll ? (Object.keys(CHECKS) as (keyof ProductFormValues)[]) : (Object.keys(values) as (keyof ProductFormValues)[]);
  for (const key of keys) {
    if (!(key in CHECKS)) continue;
    const value = values[key] ?? "";
    if (!requireAll && value === "" && !REQUIRED.includes(key)) continue; // clearing an optional field is fine
    const message = CHECKS[key](value);
    if (message) errors[key] = message;
  }
  return errors;
}

// Request body for creating a product. Optional blanks are omitted. There is deliberately no organization field.
export function toCreateBody(v: ProductFormValues) {
  return {
    sku: v.sku,
    name: v.name,
    ...(v.description ? { description: v.description } : {}),
    category: v.category,
    unit: v.unit,
    ...(v.hsCode ? { hs_code: v.hsCode } : {}),
    cost_price: v.costPrice,
    selling_price: v.sellingPrice,
    currency_code: v.currencyCode,
  };
}

const API_NAMES: { [K in keyof ProductFormValues]: string } = {
  sku: "sku", name: "name", description: "description", category: "category", unit: "unit", hsCode: "hs_code",
  costPrice: "cost_price", sellingPrice: "selling_price", currencyCode: "currency_code",
};

// Request body for a partial edit: only the fields that were provided. A blank optional field becomes null (clears it).
export function toPatchBody(v: Partial<ProductFormValues>) {
  const body: Record<string, string | null> = {};
  for (const key of Object.keys(v) as (keyof ProductFormValues)[]) {
    if (!(key in API_NAMES)) continue;
    const value = v[key] ?? "";
    body[API_NAMES[key]] = value === "" && (key === "description" || key === "hsCode") ? null : value;
  }
  return body;
}

export function fieldFromApiName(name: string): keyof ProductFormValues | undefined {
  return (Object.keys(API_NAMES) as (keyof ProductFormValues)[]).find((key) => API_NAMES[key] === name);
}

// Strings in, strings out: no Number() anywhere. "10.5000" -> "10.50", "1234567.8912" -> "1,234,567.8912".
export function formatMoney(value: string, currency: string): string {
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const decimals = trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed;
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${decimals} ${currency}`;
}

// For editing: "10.5000" -> "10.50" (no separators, still a string).
export function plainDecimal(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return `${whole}.${trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed}`;
}

export function productToForm(product: Product): ProductFormValues {
  return {
    sku: product.sku,
    name: product.name,
    description: product.description ?? "",
    category: product.category,
    unit: product.unit,
    hsCode: product.hs_code ?? "",
    costPrice: plainDecimal(product.cost_price),
    sellingPrice: plainDecimal(product.selling_price),
    currencyCode: product.currency_code,
  };
}
