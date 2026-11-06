import { NextRequest, NextResponse } from "next/server";

import { cleanChanges, modulesFailureResponse, orgRequest, UUID_RE } from "@/lib/modules";
import { NO_STORE, fail, isResponse, readObject, sessionToken } from "@/lib/support-routes";

export const dynamic = "force-dynamic";

// APPLY a reviewed change. The Organization Service re-checks everything (the Super Admin role, the dependencies, what is in progress and
// that nothing changed since the review) and records who made the change. Only the changes, the revision that was reviewed and an optional
// reason are read from the browser; the actor is the verified session, never a field.
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken();
  if (!token) return fail("You are not signed in.", 401);
  if (!UUID_RE.test(params.id)) return fail("Organization not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const changes = cleanChanges(body.changes);
  if (!changes) return fail("Choose at least one module change.", 400);
  if (typeof body.expected_revision !== "number" || !Number.isInteger(body.expected_revision) || body.expected_revision < 0) return fail("Review the change again before confirming.", 400);
  const payload: Record<string, unknown> = { changes, expected_revision: body.expected_revision };
  if (typeof body.reason === "string" && body.reason.trim()) payload.reason = body.reason.trim().slice(0, 500);
  const result = await orgRequest("PUT", `/api/v1/organizations/${params.id}/modules`, token, payload);
  if (!result || result.status !== 200) return modulesFailureResponse(result);
  return NextResponse.json({ state: result.data }, { status: 200, headers: NO_STORE });
}
