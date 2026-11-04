import { NextRequest, NextResponse } from "next/server";

import { failureResponse, inventoryRequest } from "@/lib/inventory";
import { UUID_RE } from "@/lib/product-validation";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

// ARCHIVE a product (soft delete): it leaves the default list but nothing is erased and it can be restored.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "You are not signed in." }, { status: 401 });
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: "Product not found." }, { status: 404 });

  const result = await inventoryRequest("POST", `/api/v1/inventory/products/${params.id}/archive`, token);
  if (!result || result.status !== 200) return failureResponse(result);
  return NextResponse.json({ product: result.data }, { headers: { "Cache-Control": "no-store" } });
}
