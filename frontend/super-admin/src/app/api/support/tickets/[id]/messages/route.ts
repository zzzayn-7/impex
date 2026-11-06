import { NextRequest, NextResponse } from "next/server";

import { supportFailureResponse, supportRequest, UUID_RE } from "@/lib/support";
import { MESSAGE_MAX, STATUSES, type TicketStatus } from "@/lib/support-labels";
import { IDEMPOTENCY_KEY_RE, NO_STORE, fail, isResponse, readObject, sessionToken } from "@/lib/support-routes";

export const dynamic = "force-dynamic";

// REPLY to a ticket from the portal. Only the text and an optional new status are read from the browser (with an Idempotency-Key, so a
// double click records the reply once). Who the reply is from, and who is emailed, is decided by the Support Service: the requester's
// address stored on the ticket. The browser never names a recipient.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken();
  if (!token) return fail("You are not signed in.", 401);
  if (!UUID_RE.test(params.id)) return fail("Ticket not found.", 404);
  const key = (req.headers.get("idempotency-key") ?? "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) return fail("Missing or invalid request key. Reload the page and try again.", 400);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) return fail("Write your reply.", 400);
  if (text.length > MESSAGE_MAX) return fail(`Use ${MESSAGE_MAX} characters or fewer.`, 400);
  const payload: { body: string; status?: TicketStatus } = { body: text };
  if (body.status !== undefined && body.status !== null && body.status !== "") {
    if (typeof body.status !== "string" || !(STATUSES as readonly string[]).includes(body.status)) return fail("Choose a valid status.", 400);
    payload.status = body.status as TicketStatus;
  }
  const result = await supportRequest("POST", `/api/v1/support/admin/tickets/${params.id}/messages`, token, payload, { "Idempotency-Key": key });
  if (!result || (result.status !== 201 && result.status !== 200)) return supportFailureResponse(result);
  return NextResponse.json({ ticket: result.data, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
