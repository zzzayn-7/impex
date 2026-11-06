import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { supportFailureResponse, supportRequest } from "@/lib/support";
import { MESSAGE_MAX } from "@/lib/support-labels";
import { IDEMPOTENCY_KEY_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

// FOLLOW UP on one of the signed-in administrator's own organization's tickets. Only the text is read (with an Idempotency-Key, so a double
// click records it once). Another organization's ticket answers "not found", exactly like an id that does not exist.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Ticket not found.", 404);
  const key = (req.headers.get("idempotency-key") ?? "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) return fail("Missing or invalid request key. Reload the page and try again.", 400);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) return fail("Write your message.", 400, { fieldErrors: { message: "Write your message." } });
  if (text.length > MESSAGE_MAX) return fail(`Use ${MESSAGE_MAX} characters or fewer.`, 400, { fieldErrors: { message: `Use ${MESSAGE_MAX} characters or fewer.` } });
  const result = await supportRequest("POST", `/api/v1/support/tickets/${params.id}/messages`, token, { body: text }, { "Idempotency-Key": key });
  if (!result || (result.status !== 201 && result.status !== 200)) return supportFailureResponse(result);
  return NextResponse.json({ ticket: result.data, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
