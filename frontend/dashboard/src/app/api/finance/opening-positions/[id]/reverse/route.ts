import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { badParse, checkUuid, fail, NO_STORE, parseReason, sessionToken } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Opening position not found.", 404);
  const sent = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const reason = parseReason(sent?.reason);
  if (!reason.ok) return badParse(reason);
  const result = await financeRequest("POST", `/api/v1/finance/opening-positions/${params.id}/reverse`, token, { reason: reason.value });
  if (!result || result.status !== 200) return financeFailureResponse(result, "Opening position not found.");
  return NextResponse.json({ position: result.data }, { headers: NO_STORE });
}
