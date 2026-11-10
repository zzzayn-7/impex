import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { badParse, fail, isResponse, NO_STORE, parseOpeningBody, readObject, requireKey, sessionToken } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const result = await financeRequest("GET", "/api/v1/finance/opening-positions", token);
  if (!result || result.status !== 200) return financeFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// Set the financial position the organization starts from: what it owned and owed on a date, in one currency. The owner's equity is computed by the service.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const key = requireKey(req);
  if (typeof key !== "string") return key;
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const parsed = parseOpeningBody(body);
  if (!parsed.ok) return badParse(parsed);
  const result = await financeRequest("POST", "/api/v1/finance/opening-positions", token, parsed.value, { "Idempotency-Key": key });
  if (!result || (result.status !== 201 && result.status !== 200)) return financeFailureResponse(result);
  return NextResponse.json({ position: result.data, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
