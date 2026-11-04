import { NextRequest, NextResponse } from "next/server";

import { inventoryRequest, stockFailureResponse } from "@/lib/inventory";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { IDEMPOTENCY_KEY_RE, UUID_RE, validateQuantity, isStockAction } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

function fail(error: string, status: number, fieldErrors?: unknown) {
  return NextResponse.json({ error, fieldErrors }, { status, headers: { "Cache-Control": "no-store" } });
}

const FIELDS: Record<string, string[]> = {
  opening: ["product_id", "warehouse_id", "quantity", "reason"],
  in: ["product_id", "warehouse_id", "quantity", "reason"],
  out: ["product_id", "warehouse_id", "quantity", "reason"],
  transfer: ["product_id", "from_warehouse_id", "to_warehouse_id", "quantity", "reason"],
};

// OPENING BALANCE / STOCK IN / STOCK OUT / TRANSFER.
//
// Protected: the tenant token comes from the HttpOnly cookie. The browser supplies an Idempotency-Key per
// intended action (a double click or a retry sends the same key, so the stock changes once). Only the fields
// above are forwarded; there is no organization field anywhere, the Inventory Service decides the
// organization from the token. Whether a quantity may have a fraction depends on the product's unit, which
// only the service knows, so that rule is enforced there and its message is passed back.
export async function POST(req: NextRequest, { params }: { params: { action: string } }) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return fail("You are not signed in.", 401);
  if (!isStockAction(params.action)) return fail("Not found.", 404);
  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Invalid request.", 415);
  const key = (req.headers.get("idempotency-key") ?? "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) return fail("Missing or invalid request key. Reload the page and try again.", 400);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return fail("Invalid request.", 400);

  const forward: Record<string, string> = {};
  for (const field of FIELDS[params.action]) {
    const value = body[field];
    if (typeof value === "string") forward[field] = field === "reason" ? value.trim().replace(/\s+/g, " ") : value.trim();
  }
  if (forward.reason === "") delete forward.reason;

  const fieldErrors: Record<string, string> = {};
  for (const field of FIELDS[params.action]) {
    if (field.endsWith("_id") && !UUID_RE.test(forward[field] ?? "")) fieldErrors[field] = "Choose a value.";
  }
  const quantityError = validateQuantity(forward.quantity ?? "", true); // fractions are judged by the service, per unit
  if (quantityError) fieldErrors.quantity = quantityError;
  if ((forward.reason ?? "").length > 255) fieldErrors.reason = "Reason must be 255 characters or fewer.";
  if (params.action === "transfer" && forward.from_warehouse_id && forward.from_warehouse_id === forward.to_warehouse_id) {
    fieldErrors.to_warehouse_id = "Choose a different warehouse than the source.";
  }
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, fieldErrors);

  const result = await inventoryRequest("POST", `/api/v1/inventory/stock/${params.action}`, token, forward, { "Idempotency-Key": key });
  if (!result || (result.status !== 201 && result.status !== 200)) return stockFailureResponse(result);
  // 201 = applied now, 200 = this exact request had already been applied (a retry): the browser treats both as success.
  return NextResponse.json({ operation: result.data }, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
