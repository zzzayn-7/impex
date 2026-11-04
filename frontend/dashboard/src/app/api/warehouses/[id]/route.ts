import { NextRequest, NextResponse } from "next/server";

import { inventoryRequest, stockFailureResponse } from "@/lib/inventory";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { UUID_RE, normalizeWarehouse, toWarehouseBody, validateWarehouse } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

function fail(error: string, status: number, fieldErrors?: unknown) {
  return NextResponse.json({ error, fieldErrors }, { status, headers: { "Cache-Control": "no-store" } });
}

// EDIT a warehouse (code, name, address). Archiving and restoring have their own routes; there is no delete.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return fail("You are not signed in.", 401);
  if (!UUID_RE.test(params.id)) return fail("Warehouse not found.", 404);
  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Invalid request.", 415);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return fail("Invalid request.", 400);

  const picked: Record<string, string> = {};
  for (const key of ["code", "name", "address"]) if (typeof body[key] === "string") picked[key] = body[key] as string;
  if (Object.keys(picked).length === 0) return fail("Nothing to change.", 400);

  const values = normalizeWarehouse(picked);
  const fieldErrors = validateWarehouse(values, false);
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, fieldErrors);

  const result = await inventoryRequest("PATCH", `/api/v1/inventory/warehouses/${params.id}`, token, toWarehouseBody(values));
  if (result?.status === 409 && typeof result.data?.detail === "string") return fail(result.data.detail, 409, { code: result.data.detail });
  if (!result || result.status !== 200) return stockFailureResponse(result, "Warehouse not found.");
  return NextResponse.json({ warehouse: result.data }, { headers: { "Cache-Control": "no-store" } });
}
