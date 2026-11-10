import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { badParse, fail, isResponse, NO_STORE, parseInvestmentBody, readObject, requireKey, sessionToken } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

// Record an owner contribution or withdrawal (cash, or an asset / stock given in kind, at its valuation). Idempotent by the Idempotency-Key: a double click records ONE.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const key = requireKey(req);
  if (typeof key !== "string") return key;
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const parsed = parseInvestmentBody(body);
  if (!parsed.ok) return badParse(parsed);
  const result = await financeRequest("POST", "/api/v1/finance/investments", token, parsed.value, { "Idempotency-Key": key });
  if (!result || (result.status !== 201 && result.status !== 200)) return financeFailureResponse(result);
  return NextResponse.json({ record: result.data, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
