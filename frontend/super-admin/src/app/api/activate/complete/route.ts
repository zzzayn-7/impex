import { NextRequest, NextResponse } from "next/server";

import { callOrgService, errorResponse, forwardFailure, looksLikeToken } from "@/lib/activation";
import { passwordProblems } from "@/lib/password-policy";

export const dynamic = "force-dynamic";

// PUBLIC: no Super Admin session required. The invitation token is the caller's credential.
// Only the token, name and password are read from the request. The organization, email and role
// are decided by the backend from its own invitation record, so a caller cannot choose them.
export async function POST(req: NextRequest) {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return errorResponse(415, "invalid_request", "Invalid request.");
  }
  const body = await req.json().catch(() => null);
  if (!looksLikeToken(body?.token)) {
    return errorResponse(404, "invalid", "This invitation link is not valid.");
  }

  const fullName = typeof body.fullName === "string" ? body.fullName.trim().replace(/\s+/g, " ") : "";
  const password = typeof body.password === "string" ? body.password : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

  if (fullName.length < 2 || fullName.length > 255) {
    return errorResponse(400, "invalid_name", "Enter your full name (at least 2 characters).");
  }
  if (password !== confirmPassword) {
    return errorResponse(400, "password_mismatch", "The passwords do not match.");
  }
  // The invited email is not known here; the Auth Service re-checks the "no part of your email" rule.
  const problems = passwordProblems(password, "");
  if (problems.length > 0) {
    return errorResponse(422, "weak_password", "Password must contain: " + problems.join(", ").toLowerCase() + ".", { problems });
  }

  const result = await callOrgService("/internal/invitations/accept", { token: body.token, full_name: fullName, password });
  if (!result || result.status !== 201) return forwardFailure(result);

  return NextResponse.json(
    { organizationName: result.data.organization_name, email: result.data.email },
    { status: 201, headers: { "Cache-Control": "no-store" } }
  );
}
