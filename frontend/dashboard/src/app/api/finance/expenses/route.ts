import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import {
  badParse, checkDispatchDate, checkUuid, EXPENSE_STATUSES, fail, isResponse, NO_STORE, parseExpenseBody, readObject, requireKey, sessionToken,
} from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const p = req.nextUrl.searchParams;
  const params = new URLSearchParams();
  const status = p.get("status");
  if (status && (EXPENSE_STATUSES as readonly string[]).includes(status)) params.set("status", status);
  const currency = (p.get("currency") ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(currency)) params.set("currency", currency);
  const account = p.get("accountId");
  if (account) {
    if (!checkUuid(account)) return fail("Not found.", 404);
    params.set("account_id", account);
  }
  for (const [name, upstream] of [["dateFrom", "date_from"], ["dateTo", "date_to"]] as const) {
    const value = p.get(name);
    if (value) {
      if (!checkDispatchDate(value)) return fail("Enter a valid date.", 400);
      params.set(upstream, value);
    }
  }
  const q = (p.get("q") ?? "").trim().slice(0, 100);
  if (q) params.set("q", q);
  params.set("limit", String(Math.max(1, Math.min(200, parseInt(p.get("limit") ?? "25", 10) || 25))));
  params.set("offset", String(Math.max(0, parseInt(p.get("offset") ?? "0", 10) || 0)));
  const result = await financeRequest("GET", `/api/v1/finance/expenses?${params}`, token);
  if (!result || result.status !== 200) return financeFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// Record an expense as a DRAFT, or post it straight away (`post: true`). Recording moves no money. Idempotent by the Idempotency-Key.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const key = requireKey(req);
  if (typeof key !== "string") return key;
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const parsed = parseExpenseBody(body);
  if (!parsed.ok) return badParse(parsed);
  const result = await financeRequest("POST", "/api/v1/finance/expenses", token, { ...parsed.value, post: body.post === true }, { "Idempotency-Key": key });
  if (!result || (result.status !== 201 && result.status !== 200)) return financeFailureResponse(result);
  return NextResponse.json({ expense: result.data, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
