import { NextRequest, NextResponse } from "next/server";

import { lifecycleFailure, NO_STORE } from "@/lib/organization-lifecycle";
import { orgRequest, UUID_RE } from "@/lib/modules";
import { fail, isResponse, readObject, sessionToken } from "@/lib/support-routes";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // every service deletes its part: a large organization can take a while

// DELETE an organization FOR GOOD: every service deletes everything it owns, then the organization itself. Irreversible. The browser sends only the name the Super Admin typed;
// the Organization Service compares it with the real name (it is the one that decides), locks the organization first and can be repeated if a service was unreachable.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken();
  if (!token) return fail("You are not signed in.", 401);
  if (!UUID_RE.test(params.id)) return fail("Organization not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  if (typeof body.confirm_name !== "string" || !body.confirm_name.trim()) return fail("Type the organization's exact name to confirm the deletion.", 400);
  const result = await orgRequest("POST", `/api/v1/organizations/${params.id}/delete`, token, { confirm_name: body.confirm_name.slice(0, 255) }, 280000);
  if (!result || result.status !== 200) return lifecycleFailure(result, "delete an organization");
  return NextResponse.json({ deleted: true, name: result.data?.name, purged: result.data?.purged }, { status: 200, headers: NO_STORE });
}
