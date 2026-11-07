import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { fail, NO_STORE, sessionToken } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

// "Sync now": pull and post this organization's Sales and Purchasing events immediately (the background worker does the same every few seconds).
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const result = await financeRequest("POST", "/api/v1/finance/sync/run", token);
  if (!result || result.status !== 200) return financeFailureResponse(result);
  return NextResponse.json({ result: result.data }, { headers: NO_STORE });
}
