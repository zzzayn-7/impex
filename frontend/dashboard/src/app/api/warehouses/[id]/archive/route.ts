import { NextRequest, NextResponse } from "next/server";

import { inventoryRequest, stockFailureResponse } from "@/lib/inventory";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { UUID_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

// ARCHIVE a warehouse (soft delete). Its stock and movement history are kept untouched; the warehouse just
// stops accepting new stock changes until it is restored. A warehouse is never hard-deleted.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "You are not signed in." }, { status: 401 });
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: "Warehouse not found." }, { status: 404 });

  const result = await inventoryRequest("POST", `/api/v1/inventory/warehouses/${params.id}/archive`, token);
  if (!result || result.status !== 200) return stockFailureResponse(result, "Warehouse not found.");
  return NextResponse.json({ warehouse: result.data }, { headers: { "Cache-Control": "no-store" } });
}
