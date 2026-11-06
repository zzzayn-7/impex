import { NextRequest, NextResponse } from "next/server";

import { fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { supportFailureResponse, supportRequest } from "@/lib/support";
import { CATEGORIES, MESSAGE_MAX, PRIORITIES, STATUSES, SUBJECT_MAX } from "@/lib/support-labels";
import { IDEMPOTENCY_KEY_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

const oneOf = <T extends readonly string[]>(list: T, value: unknown): value is T[number] => typeof value === "string" && (list as readonly string[]).includes(value);

// List / search the signed-in administrator's OWN organization's tickets. The organization is derived by the Support Service from the
// session token; a parameter that names one is not read.
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const p = req.nextUrl.searchParams;
  const params = new URLSearchParams();
  const status = p.get("status");
  if (oneOf(STATUSES, status)) params.set("status", status);
  const category = p.get("category");
  if (oneOf(CATEGORIES, category)) params.set("category", category);
  if (p.get("unread") === "true") params.set("unread", "true");
  const q = (p.get("q") ?? "").trim().slice(0, 100);
  if (q) params.set("q", q);
  params.set("limit", String(Math.max(1, Math.min(100, parseInt(p.get("limit") ?? "20", 10) || 20))));
  params.set("offset", String(Math.max(0, parseInt(p.get("offset") ?? "0", 10) || 0)));
  const result = await supportRequest("GET", `/api/v1/support/tickets?${params}`, token);
  if (!result || result.status !== 200) return supportFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// OPEN a ticket. The browser sends an Idempotency-Key with every create (one per form attempt), so a double click or a retry returns the
// same ticket instead of a second one. Only the subject, the category, the priority and the message are read: the organization, the
// requester, the ticket number, the status and every email address are decided by the Support Service from the verified identity.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const key = (req.headers.get("idempotency-key") ?? "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) return fail("Missing or invalid request key. Reload the page and try again.", 400);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const fieldErrors: Record<string, string> = {};
  if (subject.length < 3 || subject.length > SUBJECT_MAX) fieldErrors.subject = `Write a subject of 3 to ${SUBJECT_MAX} characters.`;
  if (!oneOf(CATEGORIES, body.category)) fieldErrors.category = "Choose a category.";
  const priority = body.priority === undefined || body.priority === "" ? "normal" : body.priority;
  if (!oneOf(PRIORITIES, priority)) fieldErrors.priority = "Choose a priority.";
  if (message.length < 1) fieldErrors.message = "Describe your request.";
  else if (message.length > MESSAGE_MAX) fieldErrors.message = `Use ${MESSAGE_MAX} characters or fewer.`;
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });

  const result = await supportRequest("POST", "/api/v1/support/tickets", token, { subject, category: body.category, priority, message }, { "Idempotency-Key": key });
  if (!result || (result.status !== 201 && result.status !== 200)) return supportFailureResponse(result);
  // 201 = opened now, 200 = this exact request had already been processed (a retry): the browser treats both as success.
  return NextResponse.json({ ticket: result.data, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
