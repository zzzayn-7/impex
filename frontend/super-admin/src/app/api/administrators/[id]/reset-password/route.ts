import { NextRequest, NextResponse } from "next/server";

import { UUID_RE, failureResponse, orgServicePost } from "@/lib/administrators";
import { getSessionToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

// RESET an administrator's password: the administrator forgot it. The Auth Service replaces it with a strong temporary password and the Organization Service emails that to the address the
// administrator registered with. The Super Admin only sees WHERE it was sent and until when; the password itself never comes back through here. The Organization Service checks that the
// administrator really belongs to the given organization and has activated their account.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = getSessionToken();
  if (!token) return fail("You are not signed in.", 401);

  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Invalid request.", 415);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const organizationId = typeof body?.organizationId === "string" ? body.organizationId.trim() : "";

  if (!UUID_RE.test(params.id)) return fail("Administrator not found.", 404);
  if (!UUID_RE.test(organizationId)) return fail("Invalid request.", 400);

  const result = await orgServicePost(`/api/v1/organizations/${organizationId}/administrators/${params.id}/reset-password`, token);
  if (!result || result.status !== 200) return failureResponse(result);

  // Only what the Super Admin may know: where it went and when it stops working.
  const sentTo = typeof result.data?.sent_to === "string" ? result.data.sent_to : null;
  const expiresAt = typeof result.data?.expires_at === "string" ? result.data.expires_at : null;
  return NextResponse.json({ sentTo, expiresAt }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
