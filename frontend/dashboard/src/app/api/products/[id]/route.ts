import { NextRequest, NextResponse } from "next/server";

import { failureResponse, inventoryRequest } from "@/lib/inventory";
import {
  EMPTY_PRODUCT,
  ProductFormValues,
  UUID_RE,
  normalizeProduct,
  toPatchBody,
  validateProduct,
} from "@/lib/product-validation";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

function fail(error: string, status: number, fieldErrors?: unknown) {
  return NextResponse.json({ error, fieldErrors }, { status, headers: { "Cache-Control": "no-store" } });
}

// EDIT a product of the signed-in administrator's catalog. Only the fields that are sent are changed.
// The product id is looked up inside the administrator's own organization by the Inventory Service, so another
// organization's id simply answers "not found". No organization field can be sent or changed from here.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return fail("You are not signed in.", 401);
  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Invalid request.", 415);
  if (!UUID_RE.test(params.id)) return fail("Product not found.", 404);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return fail("Invalid request.", 400);

  const provided: Partial<ProductFormValues> = {};
  for (const key of Object.keys(EMPTY_PRODUCT) as (keyof ProductFormValues)[]) {
    if (typeof body[key] === "string") provided[key] = body[key] as string; // whitelist
  }
  if (Object.keys(provided).length === 0) return fail("Provide at least one field to change.", 400);

  const values = normalizeProduct(provided);
  const fieldErrors = validateProduct(values, false);
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, fieldErrors);

  const result = await inventoryRequest("PATCH", `/api/v1/inventory/products/${params.id}`, token, toPatchBody(values));
  if (!result || result.status !== 200) return failureResponse(result);
  return NextResponse.json({ product: result.data }, { headers: { "Cache-Control": "no-store" } });
}
