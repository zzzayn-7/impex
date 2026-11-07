import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { badParse, checkUuid, fail, isResponse, NO_STORE, parseExpenseBody, readObject, sessionToken } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Expense not found.", 404);
  const result = await financeRequest("GET", `/api/v1/finance/expenses/${params.id}`, token);
  if (!result || result.status !== 200) return financeFailureResponse(result, "Expense not found.");
  return NextResponse.json({ expense: result.data }, { headers: NO_STORE });
}

// Replace a DRAFT expense. A posted expense can never be edited.
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Expense not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const parsed = parseExpenseBody(body, true);
  if (!parsed.ok) return badParse(parsed);
  const result = await financeRequest("PUT", `/api/v1/finance/expenses/${params.id}`, token, parsed.value);
  if (!result || result.status !== 200) return financeFailureResponse(result, "Expense not found.");
  return NextResponse.json({ expense: result.data }, { headers: NO_STORE });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Expense not found.", 404);
  const result = await financeRequest("DELETE", `/api/v1/finance/expenses/${params.id}`, token);
  if (!result || result.status !== 204) return financeFailureResponse(result, "Expense not found.");
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
