import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { badParse, checkDispatchDate, checkUuid, fail, NO_STORE, parseReason, sessionToken, text } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

const ACTIONS = ["post", "reverse"];

// POST balances and numbers a draft (posting twice is refused, never repeated). REVERSE posts the exact mirror image of a posted entry, with a
// reason; the original stays exactly as it was.
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!ACTIONS.includes(params.action)) return fail("Not found.", 404);
  if (!checkUuid(params.id)) return fail("Journal entry not found.", 404);
  let body: unknown;
  if (params.action === "reverse") {
    const sent = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const reason = parseReason(sent?.reason);
    if (!reason.ok) return badParse(reason);
    const date = text(sent?.entryDate) ?? "";
    if (date && !checkDispatchDate(date)) return fail("Enter a valid date.", 400, { fieldErrors: { entryDate: "Enter a valid date." } });
    body = { reason: reason.value, ...(date ? { entry_date: date } : {}) };
  }
  const result = await financeRequest("POST", `/api/v1/finance/journal-entries/${params.id}/${params.action}`, token, body);
  if (!result || (result.status !== 200 && result.status !== 201)) return financeFailureResponse(result, "Journal entry not found.");
  return NextResponse.json({ entry: result.data }, { status: result.status, headers: NO_STORE });
}
