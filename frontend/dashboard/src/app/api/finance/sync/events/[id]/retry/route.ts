import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

// Give a FAILED event another go. It is posted at most once, however often this is called.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Event not found.", 404);
  const result = await financeRequest("POST", `/api/v1/finance/sync/events/${params.id}/retry`, token);
  if (!result || result.status !== 200) return financeFailureResponse(result, "Event not found.");
  return NextResponse.json({ event: result.data }, { headers: NO_STORE });
}
