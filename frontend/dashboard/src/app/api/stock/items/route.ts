import { NextRequest, NextResponse } from "next/server";

import { PAGE_SIZE, listStock } from "@/lib/inventory";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

// One more page of the Stock list, for the scrolling list (it asks for the next page when the reader reaches the end). Read-only; the organization is decided by
// the Inventory Service from the signed-in administrator's token, so there is nothing here to name one.
export async function GET(req: NextRequest) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "You are not signed in." }, { status: 401 });
  const params = req.nextUrl.searchParams;
  const status = params.get("status");
  const page = Math.max(1, Math.min(10000, parseInt(params.get("page") ?? "1", 10) || 1));
  const result = await listStock(token, {
    q: (params.get("q") ?? "").trim().slice(0, 100),
    inStockOnly: false,
    status: status === "archived" || status === "all" ? status : "active",
    page,
  });
  if (!result.ok) {
    const code = result.reason === "unauthorized" ? 401 : result.reason === "forbidden" ? 403 : 503;
    return NextResponse.json({ error: "Stock could not be loaded." }, { status: code, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ items: result.items, total: result.total, pageSize: PAGE_SIZE }, { headers: { "Cache-Control": "no-store" } });
}
