import { NextRequest, NextResponse } from "next/server";

import { supportFailureResponse, supportRequest, UUID_RE } from "@/lib/support";
import { PRIORITIES, STATUSES } from "@/lib/support-labels";
import { NO_STORE, fail, isResponse, readObject, sessionToken } from "@/lib/support-routes";

export const dynamic = "force-dynamic";

// CHANGE a ticket's status and/or priority. Only those two fields are read; the Support Service accepts just the documented status moves
// and records who changed what.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken();
  if (!token) return fail("You are not signed in.", 401);
  if (!UUID_RE.test(params.id)) return fail("Ticket not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const payload: Record<string, string> = {};
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !(STATUSES as readonly string[]).includes(body.status)) return fail("Choose a valid status.", 400);
    payload.status = body.status;
  }
  if (body.priority !== undefined) {
    if (typeof body.priority !== "string" || !(PRIORITIES as readonly string[]).includes(body.priority)) return fail("Choose a valid priority.", 400);
    payload.priority = body.priority;
  }
  if (Object.keys(payload).length === 0) return fail("Choose a status or a priority to change.", 400);
  const result = await supportRequest("PATCH", `/api/v1/support/admin/tickets/${params.id}`, token, payload);
  if (!result || result.status !== 200) return supportFailureResponse(result);
  return NextResponse.json({ ticket: result.data }, { status: 200, headers: NO_STORE });
}
