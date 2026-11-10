import { NextRequest, NextResponse } from "next/server";

import { inventoryRequest, stockFailureResponse } from "@/lib/inventory";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { UUID_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

// TAKE A MOVEMENT OFF THE STOCK MOVEMENTS PAGE (the bin icon). The stock ledger itself is append-only and is NOT changed: the movement stays in it and every balance is
// unchanged; the Inventory Service only remembers that this organization no longer wants to see it in the list. Session only; no organization is ever named here.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "You are not signed in." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: "Movement not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const result = await inventoryRequest("POST", `/api/v1/inventory/stock/movements/${params.id}/hide`, token);
  if (!result || result.status !== 204) return stockFailureResponse(result, "Movement not found.");
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
