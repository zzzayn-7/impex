import { NextRequest, NextResponse } from "next/server";

import { UUID_RE, failureResponse, inviteAdministrator } from "@/lib/administrators";
import { getSessionToken } from "@/lib/auth";
import { EMAIL_RE } from "@/lib/organization-validation";

export const dynamic = "force-dynamic";

function fail(error: string, status: number, fieldErrors?: Record<string, string>) {
  return NextResponse.json({ error, fieldErrors }, { status, headers: { "Cache-Control": "no-store" } });
}

// Add an administrator to an organization: creates a pending invitation and emails the activation link.
// Only an organization id, a name and an email are read from the browser. The role is always
// "organization-admin" and is decided by the backend; no token or service key is ever returned.
export async function POST(req: NextRequest) {
  // Must be signed in. The Organization Service re-verifies the Super Admin role on every call.
  const token = getSessionToken();
  if (!token) return fail("You are not signed in.", 401);

  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Invalid request.", 415);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return fail("Invalid request.", 400);

  const organizationId = typeof body.organizationId === "string" ? body.organizationId.trim() : "";
  const fullName = typeof body.fullName === "string" ? body.fullName.trim().replace(/\s+/g, " ") : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  const fieldErrors: Record<string, string> = {};
  if (!UUID_RE.test(organizationId)) fieldErrors.organizationId = "Select an organization.";
  if (fullName.length < 2 || fullName.length > 255) fieldErrors.fullName = "Enter the administrator's full name (at least 2 characters).";
  if (!EMAIL_RE.test(email) || email.length > 320) fieldErrors.email = "Enter a valid email address.";
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, fieldErrors);

  const result = await inviteAdministrator(token, organizationId, email, fullName);
  if (!result || result.status !== 201) return failureResponse(result);

  return NextResponse.json({ administrator: result.data }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
