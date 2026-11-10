import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { fail, NO_STORE, sessionToken } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

// The deliveries that still need a price or a cost. READ-ONLY.
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const result = await financeRequest("GET", "/api/v1/finance/reconciliation", token);
  if (!result || result.status !== 200) return financeFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}
