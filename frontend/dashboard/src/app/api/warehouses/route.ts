import { NextRequest, NextResponse } from "next/server";

import { inventoryRequest, stockFailureResponse } from "@/lib/inventory";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { normalizeWarehouse, toWarehouseBody, validateWarehouse } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

function fail(error: string, status: number, fieldErrors?: unknown) {
  return NextResponse.json({ error, fieldErrors }, { status, headers: { "Cache-Control": "no-store" } });
}

// CREATE a warehouse in the signed-in administrator's organization.
//
// Protected like the product routes: the token comes from the HttpOnly tenant cookie and is sent as a Bearer
// token. Only code, name and address are read from the browser; anything else (including any organization id)
// is dropped here and would be rejected by the Inventory Service anyway.
export async function POST(req: NextRequest) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return fail("You are not signed in.", 401);
  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Invalid request.", 415);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return fail("Invalid request.", 400);

  const values = normalizeWarehouse({
    code: typeof body.code === "string" ? body.code : "",
    name: typeof body.name === "string" ? body.name : "",
    address: typeof body.address === "string" ? body.address : "",
  });
  const fieldErrors = validateWarehouse(values);
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, fieldErrors);

  const result = await inventoryRequest("POST", "/api/v1/inventory/warehouses", token, toWarehouseBody(values));
  if (!result || result.status !== 201) return conflictAsFieldError(result);
  return NextResponse.json({ warehouse: result.data }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

// A duplicate code is shown under the Code field rather than as a general error.
function conflictAsFieldError(result: Awaited<ReturnType<typeof inventoryRequest>>) {
  if (result?.status === 409 && typeof result.data?.detail === "string") {
    return fail(result.data.detail, 409, { code: result.data.detail });
  }
  return stockFailureResponse(result, "Warehouse not found.");
}
