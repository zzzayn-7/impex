import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { fail, HISTORY_CATEGORIES, NO_STORE, PERIOD_KEYS, sessionToken } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

// The transactions behind the figures. READ-ONLY; only the period, a category, a currency and a page are read from the URL.
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const p = req.nextUrl.searchParams;
  const period = p.get("period") ?? "1m";
  const category = p.get("category") ?? "all";
  if (!(PERIOD_KEYS as readonly string[]).includes(period)) return fail("Choose 1 Day, 1 Week, 1 Month, 6 Months or 1 Year.", 400);
  if (!(HISTORY_CATEGORIES as readonly string[]).includes(category)) return fail("Unknown category.", 400);
  const params = new URLSearchParams({ period, category });
  const currency = (p.get("currency") ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(currency)) params.set("currency", currency);
  params.set("limit", String(Math.max(1, Math.min(200, parseInt(p.get("limit") ?? "25", 10) || 25))));
  params.set("offset", String(Math.max(0, parseInt(p.get("offset") ?? "0", 10) || 0)));
  const result = await financeRequest("GET", `/api/v1/finance/history?${params}`, token);
  if (!result || result.status !== 200) return financeFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}
