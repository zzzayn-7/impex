import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { fail, NO_STORE, sessionToken, SYNC_STATUSES } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

// The events received from Sales and Purchasing, with what became of each (posted, skipped, failed, waiting).
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const p = req.nextUrl.searchParams;
  const params = new URLSearchParams();
  const status = p.get("status");
  if (status && (SYNC_STATUSES as readonly string[]).includes(status)) params.set("status", status);
  params.set("limit", String(Math.max(1, Math.min(200, parseInt(p.get("limit") ?? "25", 10) || 25))));
  params.set("offset", String(Math.max(0, parseInt(p.get("offset") ?? "0", 10) || 0)));
  const result = await financeRequest("GET", `/api/v1/finance/sync/events?${params}`, token);
  if (!result || result.status !== 200) return financeFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}
