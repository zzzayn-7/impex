import { NextRequest, NextResponse } from "next/server";

import { inventoryRequest, stockFailureResponse } from "@/lib/inventory";
import { normalizeScanned } from "@/lib/scan";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { UUID_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

function fail(error: string, status: number, fieldErrors?: unknown) {
  return NextResponse.json({ error, fieldErrors }, { status, headers: { "Cache-Control": "no-store" } });
}

// REGISTER a manufacturer or supplier barcode on a product. Only kind, value and an optional label are read from the
// browser; the product is the one in the URL and the organization is decided by the Inventory Service from the token.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return fail("You are not signed in.", 401);
  if (!UUID_RE.test(params.id)) return fail("Product not found.", 404);
  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Invalid request.", 415);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return fail("Invalid request.", 400);

  const kind = body.kind === "supplier" ? "supplier" : body.kind === "manufacturer" ? "manufacturer" : null;
  if (!kind) return fail("Choose whether this is a manufacturer or a supplier barcode.", 400, { kind: "Choose a type." });
  const code = normalizeScanned(typeof body.value === "string" ? body.value : "");
  if (!code.ok) return fail(code.message, 400, { value: code.message });
  const label = typeof body.label === "string" ? body.label.trim().replace(/\s+/g, " ") : "";
  if (label.length > 100) return fail("The note must be 100 characters or fewer.", 400, { label: "100 characters or fewer." });

  const result = await inventoryRequest("POST", `/api/v1/inventory/products/${params.id}/identifiers`, token, {
    kind,
    value: code.code,
    ...(label ? { label } : {}),
  });
  if (result?.status === 409 && typeof result.data?.detail === "string") return fail(result.data.detail, 409, { value: result.data.detail });
  if (!result || result.status !== 201) return stockFailureResponse(result, "Product not found.");
  return NextResponse.json({ identifier: result.data }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
