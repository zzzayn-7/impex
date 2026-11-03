import { NextRequest, NextResponse } from "next/server";

import { UUID_RE, failureResponse, orgServiceSend } from "@/lib/administrators";
import { getSessionToken } from "@/lib/auth";
import { EMAIL_RE } from "@/lib/organization-validation";

export const dynamic = "force-dynamic";

function fail(error: string, status: number, fieldErrors?: Record<string, string>) {
  return NextResponse.json({ error, fieldErrors }, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBody(req: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Invalid request.", 415);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return fail("Invalid request.", 400);
  return body;
}

// EDIT an administrator's name and/or email. Only those two fields are read from the browser; the role
// and the organization can never be changed, and the Organization Service checks that the administrator
// belongs to the organization named in the request.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = getSessionToken();
  if (!token) return fail("You are not signed in.", 401);

  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const organizationId = typeof body.organizationId === "string" ? body.organizationId.trim() : "";
  if (!UUID_RE.test(params.id)) return fail("Administrator not found.", 404);
  if (!UUID_RE.test(organizationId)) return fail("Invalid request.", 400);

  const fullName = typeof body.fullName === "string" ? body.fullName.trim().replace(/\s+/g, " ") : undefined;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : undefined;
  if (fullName === undefined && email === undefined) return fail("Provide a name or an email to change.", 400);

  const fieldErrors: Record<string, string> = {};
  if (fullName !== undefined && (fullName.length < 2 || fullName.length > 255)) fieldErrors.fullName = "Enter the administrator's full name (at least 2 characters).";
  if (email !== undefined && (!EMAIL_RE.test(email) || email.length > 320)) fieldErrors.email = "Enter a valid email address.";
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, fieldErrors);

  const result = await orgServiceSend("PATCH", `/api/v1/organizations/${organizationId}/administrators/${params.id}`, token, {
    ...(fullName !== undefined ? { full_name: fullName } : {}),
    ...(email !== undefined ? { email } : {}),
  });
  if (!result || result.status !== 200) return failureResponse(result);

  return NextResponse.json({ administrator: result.data }, { headers: { "Cache-Control": "no-store" } });
}

// DELETE an administrator: their account (if activated) and their invitations are removed.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const token = getSessionToken();
  if (!token) return fail("You are not signed in.", 401);

  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const organizationId = typeof body.organizationId === "string" ? body.organizationId.trim() : "";
  if (!UUID_RE.test(params.id)) return fail("Administrator not found.", 404);
  if (!UUID_RE.test(organizationId)) return fail("Invalid request.", 400);

  const result = await orgServiceSend("DELETE", `/api/v1/organizations/${organizationId}/administrators/${params.id}`, token);
  if (!result || result.status !== 204) return failureResponse(result);

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
