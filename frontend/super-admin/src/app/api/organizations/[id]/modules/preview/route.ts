import { NextRequest, NextResponse } from "next/server";

import { cleanChanges, modulesFailureResponse, orgRequest, UUID_RE } from "@/lib/modules";
import { NO_STORE, fail, isResponse, readObject, sessionToken } from "@/lib/support-routes";

export const dynamic = "force-dynamic";

// REVIEW a change: nothing is changed. Shows the result, what blocks it (a dependency, an operation in progress) and what to know first.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken();
  if (!token) return fail("You are not signed in.", 401);
  if (!UUID_RE.test(params.id)) return fail("Organization not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const changes = cleanChanges(body.changes);
  if (!changes) return fail("Choose at least one module change.", 400);
  const result = await orgRequest("POST", `/api/v1/organizations/${params.id}/modules/preview`, token, { changes });
  if (!result || result.status !== 200) return modulesFailureResponse(result);
  return NextResponse.json({ preview: result.data }, { status: 200, headers: NO_STORE });
}
