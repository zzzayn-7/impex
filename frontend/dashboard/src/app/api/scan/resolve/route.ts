import { NextRequest, NextResponse } from "next/server";

import { inventoryRequest, stockFailureResponse } from "@/lib/inventory";
import { normalizeScanned } from "@/lib/scan";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

// Resolve a scanned / typed code to a product of the signed-in administrator's organization, with its stock.
//
// READ ONLY: this route never changes inventory. The code is treated as plain text: a value that looks like a link is
// refused here and never fetched or followed. The only thing read from the browser is the code; the organization comes
// from the HttpOnly session cookie (Bearer token) and is decided by the Inventory Service.
export async function GET(req: NextRequest) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "You are not signed in." }, { status: 401, headers: { "Cache-Control": "no-store" } });

  const normalized = normalizeScanned(req.nextUrl.searchParams.get("code") ?? "");
  if (!normalized.ok) return NextResponse.json({ error: normalized.message }, { status: 400, headers: { "Cache-Control": "no-store" } });

  const result = await inventoryRequest("GET", `/api/v1/inventory/scan/resolve?code=${encodeURIComponent(normalized.code)}`, token);
  if (!result || result.status !== 200) return stockFailureResponse(result, "No product in your catalog matches this code.");
  return NextResponse.json(result.data, { headers: { "Cache-Control": "no-store" } });
}
