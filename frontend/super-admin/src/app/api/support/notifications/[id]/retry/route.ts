import { NextRequest, NextResponse } from "next/server";

import { supportFailureResponse, supportRequest, UUID_RE } from "@/lib/support";
import { NO_STORE, fail, sessionToken } from "@/lib/support-routes";

export const dynamic = "force-dynamic";

// Another delivery attempt for a notification email that failed. The recipient was fixed when the ticket was saved; nothing is read here.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken();
  if (!token) return fail("You are not signed in.", 401);
  if (!UUID_RE.test(params.id)) return fail("Notification not found.", 404);
  const result = await supportRequest("POST", `/api/v1/support/admin/notifications/${params.id}/retry`, token);
  if (!result || result.status !== 200) return supportFailureResponse(result);
  return NextResponse.json({ notification: result.data }, { status: 200, headers: NO_STORE });
}
