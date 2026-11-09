import { NextResponse } from "next/server";

import { fieldFromApiName, type Product, type ProductFieldErrors } from "@/lib/product-validation";
import {
  API_FIELD_NAMES,
  type Movement,
  type MovementType,
  type StockFieldErrors,
  type StockProduct,
} from "@/lib/stock-validation";

// Server-side only. Talks to the Inventory Service with the signed-in administrator's own session token
// (the HttpOnly tenant cookie). Nothing here ever names an organization: the Inventory Service derives
// it from the token (see docs/multi-tenancy.md), so there is nothing for the browser to tamper with.

export function inventoryServiceUrl(): string {
  return (process.env.INVENTORY_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");
}

export type InventoryResult = { status: number; data: any } | null; // null = the service could not be reached

export async function inventoryRequest(
  method: "GET" | "POST" | "PATCH",
  path: string,
  token: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<InventoryResult> {
  try {
    const res = await fetch(`${inventoryServiceUrl()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

// ---- reading (used by the server-rendered Products page) -----------------------------------------------
export type ProductFilters = { q: string; status: "active" | "archived" | "all"; page: number };
export const PAGE_SIZE = 25;

export type ProductListResult =
  | { ok: true; products: Product[]; total: number; limit: number; offset: number }
  | { ok: false; reason: "unauthorized" | "forbidden" | "unavailable" };

function reason(result: InventoryResult): "unauthorized" | "forbidden" | "unavailable" {
  if (result?.status === 401) return "unauthorized";
  if (result?.status === 403) return "forbidden";
  return "unavailable";
}

export async function listProducts(token: string, filters: ProductFilters): Promise<ProductListResult> {
  const params = new URLSearchParams({ status: filters.status, limit: String(PAGE_SIZE), offset: String((filters.page - 1) * PAGE_SIZE) });
  if (filters.q) params.set("q", filters.q);
  const result = await inventoryRequest("GET", `/api/v1/inventory/products?${params}`, token);
  if (!result || result.status !== 200) return { ok: false, reason: reason(result) };
  return { ok: true, products: result.data.items, total: result.data.total, limit: result.data.limit, offset: result.data.offset };
}

// ---- failures from write calls, turned into safe responses for the browser ------------------------------
export function describeFailure(result: InventoryResult): { status: number; message: string; fieldErrors?: ProductFieldErrors } {
  if (!result) return { status: 503, message: "The inventory service is unavailable. Please try again shortly." };
  const detail = result.data?.detail;
  const text = typeof detail === "string" ? detail : null;
  switch (result.status) {
    case 401:
      return { status: 401, message: "Your session has expired. Please sign in again." };
    case 403:
      return { status: 403, message: text ?? "You do not have access to the product catalog." };
    case 404:
      return { status: 404, message: "Product not found." };
    case 409:
      // The unit of measurement is locked once a product has stock movements: show that under the Unit field, not the SKU.
      if (text && text.includes("unit of measurement")) return { status: 409, message: text, fieldErrors: { unit: text } };
      return { status: 409, message: text ?? "That SKU is already in use.", fieldErrors: { sku: text ?? "That SKU is already in use." } };
    case 422: {
      const fieldErrors: ProductFieldErrors = {};
      if (Array.isArray(detail)) {
        for (const item of detail as { loc?: unknown[]; msg?: string }[]) {
          const field = fieldFromApiName(String(item.loc?.[item.loc.length - 1]));
          if (field && !fieldErrors[field]) fieldErrors[field] = item.msg?.replace(/^Value error, /, "") ?? "Invalid value.";
        }
      }
      return { status: 400, message: "Some values were rejected. Please check the form.", fieldErrors };
    }
    case 503:
      return { status: 503, message: text ?? "The service is temporarily unavailable. Please try again." };
    default:
      return { status: 502, message: "The request could not be completed. Please try again." };
  }
}

export function failureResponse(result: InventoryResult) {
  const { status, message, fieldErrors } = describeFailure(result);
  return NextResponse.json({ error: message, fieldErrors }, { status, headers: { "Cache-Control": "no-store" } });
}


// ======================================================================================================
// Stock (Step 14). Same rules as above: server-side only, the administrator's own token,
// and not one place where an organization is named.
// ======================================================================================================
type Failure = { ok: false; reason: "unauthorized" | "forbidden" | "unavailable" };
export type PagedResult<T> = ({ ok: true } & { items: T[]; total: number; limit: number; offset: number }) | Failure;

async function getPaged<T>(path: string, params: URLSearchParams, token: string): Promise<PagedResult<T>> {
  const result = await inventoryRequest("GET", `${path}?${params}`, token);
  if (!result || result.status !== 200) return { ok: false, reason: reason(result) };
  return { ok: true, items: result.data.items, total: result.data.total, limit: result.data.limit, offset: result.data.offset };
}

const pageParams = (page: number, status?: string) => {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
  if (status) params.set("status", status);
  return params;
};

// Products for the pickers: the product list already says whether a unit may be counted in fractions.
export async function listProductChoices(token: string, status: "active" | "all" = "active"): Promise<Product[]> {
  const result = await getPaged<Product>("/api/v1/inventory/products", new URLSearchParams({ status, limit: "200" }), token);
  return result.ok ? result.items : [];
}

export type StockFilters = { q: string; inStockOnly: boolean; status: "active" | "archived" | "all"; page: number };
export function listStock(token: string, filters: StockFilters) {
  const params = pageParams(filters.page, filters.status);
  if (filters.q) params.set("q", filters.q);
  if (filters.inStockOnly) params.set("in_stock_only", "true");
  return getPaged<StockProduct>("/api/v1/inventory/stock", params, token);
}

export type MovementFilters = { productId: string; type: MovementType | ""; page: number };
export function listMovements(token: string, filters: MovementFilters) {
  const params = pageParams(filters.page);
  if (filters.productId) params.set("product_id", filters.productId);
  if (filters.type) params.set("type", filters.type);
  return getPaged<Movement>("/api/v1/inventory/stock/movements", params, token);
}

// ---- failures from stock write calls ---------------------------------------------------------
// The service's messages here are written for people ("Insufficient stock: 5 pcs of Bolt available, 6
// requested."), so they are passed on; anything unexpected becomes a generic message.
export type StockFailure = { status: number; message: string; fieldErrors?: Record<string, string> };

export function describeStockFailure(result: InventoryResult, notFound = "Not found."): StockFailure {
  if (!result) return { status: 503, message: "The inventory service is unavailable. Please try again shortly." };
  const detail = result.data?.detail;
  const text = typeof detail === "string" ? detail : null;
  switch (result.status) {
    case 400:
      return { status: 400, message: text ?? "The request was not accepted." };
    case 401:
      return { status: 401, message: "Your session has expired. Please sign in again." };
    case 403:
      return { status: 403, message: text ?? "You do not have access to stock management." };
    case 404:
      return { status: 404, message: text ?? notFound };
    case 409:
      return { status: 409, message: text ?? "That change conflicts with existing data." };
    case 410:
      return { status: 410, message: text ?? "That code is no longer in use." };
    case 422: {
      const fieldErrors: Record<string, string> = {};
      if (Array.isArray(detail)) {
        for (const item of detail as { loc?: unknown[]; msg?: string }[]) {
          const name = String(item.loc?.[item.loc.length - 1]);
          const field = API_FIELD_NAMES[name] ?? name;
          if (!fieldErrors[field]) fieldErrors[field] = item.msg?.replace(/^Value error, /, "") ?? "Invalid value.";
        }
      }
      return { status: 400, message: text ?? "Some values were rejected. Please check the form.", fieldErrors };
    }
    case 503:
      return { status: 503, message: text ?? "The service is temporarily unavailable. Please try again." };
    default:
      return { status: 502, message: "The request could not be completed. Please try again." };
  }
}

export function stockFailureResponse(result: InventoryResult, notFound?: string) {
  const { status, message, fieldErrors } = describeStockFailure(result, notFound);
  return NextResponse.json({ error: message, fieldErrors }, { status, headers: { "Cache-Control": "no-store" } });
}

export type { StockFieldErrors };

// ======================================================================================================
// Scannable codes and labels (Step 15). Server-side only; nothing here names an organization.
// ======================================================================================================
export type Identifier = {
  id: string;
  product_id: string;
  kind: "generated" | "manufacturer" | "supplier";
  value: string;
  label: string | null;
  is_active: boolean;
  created_by_email: string;
  created_at: string;
  retired_at: string | null;
};

export type Label = {
  product: { id: string; sku: string; name: string; unit: string };
  identifier: Identifier;
  code: string;
  qr_svg: string;
  barcode_svg: string;
};

export type CodesResult =
  | { ok: true; product: Product; identifiers: Identifier[]; label: Label | null }
  | { ok: false; reason: "unauthorized" | "forbidden" | "not-found" | "unavailable" };

// Everything the product's "Codes & labels" page shows. The label (QR + barcode SVGs) is only requested when the product
// already has its Impex code: viewing a page never creates one (the "Generate codes" button does).
export async function loadCodes(token: string, productId: string): Promise<CodesResult> {
  const base = `/api/v1/inventory/products/${productId}`;
  const [product, list] = await Promise.all([inventoryRequest("GET", base, token), inventoryRequest("GET", `${base}/identifiers`, token)]);
  for (const result of [product, list]) {
    if (!result || result.status !== 200) return { ok: false, reason: result?.status === 404 ? "not-found" : reason(result) };
  }
  const identifiers: Identifier[] = list!.data.items;
  const generated = identifiers.find((i) => i.kind === "generated");
  let label: Label | null = null;
  if (generated) {
    const made = await inventoryRequest("GET", `${base}/label`, token);
    if (!made || made.status !== 200) return { ok: false, reason: reason(made) };
    label = made.data;
  }
  return { ok: true, product: product!.data, identifiers, label };
}


// Stock on hand for these products (information for the dispatch form; nothing is reserved). Product id -> stock.
export async function loadStockSummary(token: string, productIds: string[]): Promise<Record<string, StockProduct>> {
  if (productIds.length === 0) return {};
  const params = new URLSearchParams();
  for (const id of productIds.slice(0, 100)) params.append("product_id", id);
  const result = await inventoryRequest("GET", `/api/v1/inventory/stock/summary?${params}`, token);
  if (!result || result.status !== 200) return {};
  const out: Record<string, StockProduct> = {};
  for (const item of result.data?.items ?? []) out[item.product_id] = item;
  return out;
}
