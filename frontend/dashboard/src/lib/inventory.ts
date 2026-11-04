import { NextResponse } from "next/server";

import { fieldFromApiName, type Product, type ProductFieldErrors } from "@/lib/product-validation";

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
  body?: unknown
): Promise<InventoryResult> {
  try {
    const res = await fetch(`${inventoryServiceUrl()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
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
export type ProductFilters = { q: string; category: string; status: "active" | "archived" | "all"; page: number };
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
  if (filters.category) params.set("category", filters.category);
  const result = await inventoryRequest("GET", `/api/v1/inventory/products?${params}`, token);
  if (!result || result.status !== 200) return { ok: false, reason: reason(result) };
  return { ok: true, products: result.data.items, total: result.data.total, limit: result.data.limit, offset: result.data.offset };
}

export async function listCategories(token: string): Promise<string[]> {
  const result = await inventoryRequest("GET", "/api/v1/inventory/categories", token);
  return result?.status === 200 && Array.isArray(result.data) ? result.data : [];
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
