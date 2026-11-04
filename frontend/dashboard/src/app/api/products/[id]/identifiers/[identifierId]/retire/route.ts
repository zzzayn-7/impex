import { NextRequest, NextResponse } from "next/server";

import { inventoryRequest, stockFailureResponse } from "@/lib/inventory";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { UUID_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

// RETIRE a manufacturer / supplier barcode: it stops resolving but is kept (reserved for this product), never deleted.
export async function POST(req: NextRequest, { params }: { params: { id: string; identifierId: string } }) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "You are not signed in." }, { status: 401 });
  if (!UUID_RE.test(params.id) || !UUID_RE.test(params.identifierId)) return NextResponse.json({ error: "Code not found." }, { status: 404 });

  const result = await inventoryRequest("POST", `/api/v1/inventory/products/${params.id}/identifiers/${params.identifierId}/retire`, token);
  if (!result || result.status !== 200) return stockFailureResponse(result, "Code not found.");
  return NextResponse.json({ identifier: result.data }, { headers: { "Cache-Control": "no-store" } });
}
