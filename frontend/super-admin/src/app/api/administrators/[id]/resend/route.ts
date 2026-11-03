import { NextRequest, NextResponse } from "next/server";

import { UUID_RE, failureResponse, orgServicePost } from "@/lib/administrators";
import { getSessionToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

// Resend an administrator's invitation: the previous link stops working and a fresh one is emailed.
// The Organization Service checks that the administrator really belongs to the given organization.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = getSessionToken();
  if (!token) return fail("You are not signed in.", 401);

  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Invalid request.", 415);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const organizationId = typeof body?.organizationId === "string" ? body.organizationId.trim() : "";

  if (!UUID_RE.test(params.id)) return fail("Administrator not found.", 404);
  if (!UUID_RE.test(organizationId)) return fail("Invalid request.", 400);

  const result = await orgServicePost(
    `/api/v1/organizations/${organizationId}/administrators/${params.id}/resend`,
    token
  );
  if (!result || result.status !== 201) return failureResponse(result);

  return NextResponse.json({ administrator: result.data }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
