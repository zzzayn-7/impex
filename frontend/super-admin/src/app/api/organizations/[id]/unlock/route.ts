import { NextRequest, NextResponse } from "next/server";

import { lifecycleFailure, NO_STORE } from "@/lib/organization-lifecycle";
import { orgRequest, UUID_RE } from "@/lib/modules";
import { fail, sessionToken } from "@/lib/support-routes";

export const dynamic = "force-dynamic";

// UNLOCK an organization: it has exactly the modules it had before it was locked. Nothing is read from the browser.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken();
  if (!token) return fail("You are not signed in.", 401);
  if (!UUID_RE.test(params.id)) return fail("Organization not found.", 404);
  const result = await orgRequest("POST", `/api/v1/organizations/${params.id}/unlock`, token);
  if (!result || result.status !== 200) return lifecycleFailure(result, "unlock an organization");
  return NextResponse.json({ organization: result.data }, { status: 200, headers: NO_STORE });
}
