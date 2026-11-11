import { NextRequest, NextResponse } from "next/server";

import { lifecycleFailure, NO_STORE } from "@/lib/organization-lifecycle";
import { orgRequest, UUID_RE } from "@/lib/modules";
import { fail, isResponse, readObject, sessionToken } from "@/lib/support-routes";

export const dynamic = "force-dynamic";

// LOCK an organization (e.g. its monthly payment is late): its administrators can still sign in, but no module works for them: only Settings and Help & Support.
// Nothing is deleted and the module settings are kept, so unlocking restores everything. Only the optional note is read from the browser.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken();
  if (!token) return fail("You are not signed in.", 401);
  if (!UUID_RE.test(params.id)) return fail("Organization not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const payload: Record<string, unknown> = {};
  if (typeof body.reason === "string" && body.reason.trim()) payload.reason = body.reason.trim().slice(0, 500);
  const result = await orgRequest("POST", `/api/v1/organizations/${params.id}/lock`, token, payload);
  if (!result || result.status !== 200) return lifecycleFailure(result, "lock an organization");
  return NextResponse.json({ organization: result.data }, { status: 200, headers: NO_STORE });
}
