import { NextRequest, NextResponse } from "next/server";

import { inventoryRequest, stockFailureResponse } from "@/lib/inventory";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { UUID_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

// RESTORE an archived warehouse so it accepts stock changes again.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "You are not signed in." }, { status: 401 });
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: "Warehouse not found." }, { status: 404 });

  const result = await inventoryRequest("POST", `/api/v1/inventory/warehouses/${params.id}/restore`, token);
  if (!result || result.status !== 200) return stockFailureResponse(result, "Warehouse not found.");
  return NextResponse.json({ warehouse: result.data }, { headers: { "Cache-Control": "no-store" } });
}
