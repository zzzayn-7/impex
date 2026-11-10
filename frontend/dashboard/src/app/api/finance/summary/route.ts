import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { fail, NO_STORE, PERIOD_KEYS, sessionToken } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

// Capital, Investment and Profit & Loss for a rolling period. READ-ONLY. Only the period is read from the URL: whose books these are comes from the session.
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const period = req.nextUrl.searchParams.get("period") ?? "1m";
  if (!(PERIOD_KEYS as readonly string[]).includes(period)) return fail("Choose 1 Day, 1 Week, 1 Month, 6 Months or 1 Year.", 400);
  const result = await financeRequest("GET", `/api/v1/finance/summary?period=${period}`, token);
  if (!result || result.status !== 200) return financeFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}
