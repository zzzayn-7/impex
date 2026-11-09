import { NextRequest, NextResponse } from "next/server";

import { inventoryRequest, stockFailureResponse } from "@/lib/inventory";
import { fail, NO_STORE, sessionToken } from "@/lib/sales-routes";

export const dynamic = "force-dynamic";

// The product picker of the order form: active products matching the search, each with its PHYSICAL stock, what is reserved for other orders
// and what is still available to order. Read-only; the Inventory Service decides which products are the signed-in administrator's.
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 100);
  const offset = Number.parseInt(req.nextUrl.searchParams.get("offset") ?? "0", 10);
  const params = new URLSearchParams({ status: "active", limit: "20", offset: String(Number.isSafeInteger(offset) && offset > 0 ? offset : 0) });
  if (q) params.set("q", q);
  const result = await inventoryRequest("GET", `/api/v1/inventory/stock?${params}`, token);
  if (!result || result.status !== 200) return stockFailureResponse(result);
  return NextResponse.json({ items: result.data.items, total: result.data.total, limit: result.data.limit, offset: result.data.offset }, { headers: NO_STORE });
}
