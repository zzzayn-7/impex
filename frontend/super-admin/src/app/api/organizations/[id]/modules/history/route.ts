import { NextRequest, NextResponse } from "next/server";

import { modulesFailureResponse, orgRequest, UUID_RE } from "@/lib/modules";
import { NO_STORE, fail, sessionToken } from "@/lib/support-routes";

export const dynamic = "force-dynamic";

// Who changed which module, and when (newest first).
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken();
  if (!token) return fail("You are not signed in.", 401);
  if (!UUID_RE.test(params.id)) return fail("Organization not found.", 404);
  const p = req.nextUrl.searchParams;
  const limit = Math.max(1, Math.min(200, parseInt(p.get("limit") ?? "50", 10) || 50));
  const offset = Math.max(0, parseInt(p.get("offset") ?? "0", 10) || 0);
  const result = await orgRequest("GET", `/api/v1/organizations/${params.id}/modules/history?limit=${limit}&offset=${offset}`, token);
  if (!result || result.status !== 200) return modulesFailureResponse(result);
  return NextResponse.json(result.data, { status: 200, headers: NO_STORE });
}
