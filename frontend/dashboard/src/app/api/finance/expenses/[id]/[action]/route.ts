import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { badParse, checkUuid, fail, NO_STORE, parseReason, sessionToken } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

const ACTIONS = ["post", "reverse"];

// POST posts a draft expense once (a second post is refused). REVERSE cancels a posted expense with a mirror entry and a reason.
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!ACTIONS.includes(params.action)) return fail("Not found.", 404);
  if (!checkUuid(params.id)) return fail("Expense not found.", 404);
  let body: unknown;
  if (params.action === "reverse") {
    const sent = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const reason = parseReason(sent?.reason);
    if (!reason.ok) return badParse(reason);
    body = { reason: reason.value };
  }
  const result = await financeRequest("POST", `/api/v1/finance/expenses/${params.id}/${params.action}`, token, body);
  if (!result || result.status !== 200) return financeFailureResponse(result, "Expense not found.");
  return NextResponse.json({ expense: result.data }, { headers: NO_STORE });
}
