import { NextRequest, NextResponse } from "next/server";

import { inventoryRequest, stockFailureResponse } from "@/lib/inventory";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { UUID_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

// GENERATE the product's Impex label code (the value behind the QR code and the Code 128 barcode). Repeating it returns
// the same code, so a double click is harmless.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "You are not signed in." }, { status: 401 });
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: "Product not found." }, { status: 404 });

  const result = await inventoryRequest("POST", `/api/v1/inventory/products/${params.id}/identifiers/generate`, token);
  if (!result || (result.status !== 200 && result.status !== 201)) return stockFailureResponse(result, "Product not found.");
  return NextResponse.json({ identifier: result.data, created: result.status === 201 }, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
