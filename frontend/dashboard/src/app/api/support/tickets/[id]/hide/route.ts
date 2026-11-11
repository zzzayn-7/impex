import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { supportFailureResponse, supportRequest } from "@/lib/support";

export const dynamic = "force-dynamic";

// DELETE A REQUEST FROM YOUR SIDE (the bin icon). Nothing is unsent or erased: the Impex team still has the request and its messages; it only leaves THIS organization's list.
// Session only; another organization's ticket answers "not found", exactly like an id that does not exist.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Ticket not found.", 404);
  const result = await supportRequest("POST", `/api/v1/support/tickets/${params.id}/hide`, token);
  if (!result || result.status !== 204) return supportFailureResponse(result);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
