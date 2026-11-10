import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { badParse, checkUuid, fail, NO_STORE, parseReason, sessionToken } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

// Correct a mistaken contribution or withdrawal: a reversing record is added (the original stays, with who reversed it and why).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Record not found.", 404);
  const sent = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const reason = parseReason(sent?.reason);
  if (!reason.ok) return badParse(reason);
  const result = await financeRequest("POST", `/api/v1/finance/investments/${params.id}/reverse`, token, { reason: reason.value });
  if (!result || result.status !== 201) return financeFailureResponse(result, "Record not found.");
  return NextResponse.json({ record: result.data }, { status: 201, headers: NO_STORE });
}
