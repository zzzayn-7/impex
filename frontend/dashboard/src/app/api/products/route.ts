import { NextRequest, NextResponse } from "next/server";

import { failureResponse, inventoryRequest } from "@/lib/inventory";
import { EMPTY_PRODUCT, ProductFormValues, normalizeProduct, toCreateBody, validateProduct } from "@/lib/product-validation";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

function fail(error: string, status: number, fieldErrors?: unknown) {
  return NextResponse.json({ error, fieldErrors }, { status, headers: { "Cache-Control": "no-store" } });
}

// SEARCH the signed-in administrator's active products by SKU, name, description or HS code (the product selector of a purchase order uses this).
// Read-only. Only the search text and a small page size are read from the URL; whose catalog it is comes from the session, inside the Inventory Service.
export async function GET(req: NextRequest) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return fail("You are not signed in.", 401);
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 100);
  const limit = Math.max(1, Math.min(20, parseInt(req.nextUrl.searchParams.get("limit") ?? "8", 10) || 8));
  const params = new URLSearchParams({ status: "active", limit: String(limit) });
  if (q) params.set("q", q);
  const result = await inventoryRequest("GET", `/api/v1/inventory/products?${params}`, token);
  if (!result || result.status !== 200) return failureResponse(result);
  return NextResponse.json({ items: result.data.items, total: result.data.total }, { headers: { "Cache-Control": "no-store" } });
}

// CREATE a product in the signed-in administrator's catalog.
//
// Protected: the session token comes from the HttpOnly tenant cookie and is sent to the Inventory Service as a
// Bearer token. Only the product fields below are read from the browser; anything else, including any
// organization id, is ignored here and would be rejected by the Inventory Service anyway. The organization is
// decided by the Inventory Service from the token.
export async function POST(req: NextRequest) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return fail("You are not signed in.", 401);
  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Invalid request.", 415);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return fail("Invalid request.", 400);

  const input = { ...EMPTY_PRODUCT, currencyCode: "" } as ProductFormValues;
  for (const key of Object.keys(EMPTY_PRODUCT) as (keyof ProductFormValues)[]) {
    if (typeof body[key] === "string") input[key] = body[key] as string; // whitelist: unknown keys never get this far
  }
  const values = normalizeProduct(input);
  const fieldErrors = validateProduct(values);
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, fieldErrors);

  const result = await inventoryRequest("POST", "/api/v1/inventory/products", token, toCreateBody(values));
  if (!result || result.status !== 201) return failureResponse(result);
  return NextResponse.json({ product: result.data }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
