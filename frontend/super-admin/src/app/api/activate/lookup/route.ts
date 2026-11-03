import { NextRequest, NextResponse } from "next/server";

import { callOrgService, errorResponse, forwardFailure, looksLikeToken } from "@/lib/activation";

export const dynamic = "force-dynamic";

// PUBLIC: no Super Admin session required. The invitation token is the caller's credential.
// Validates the token and returns what the activation form may show. It does not consume the token.
export async function POST(req: NextRequest) {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return errorResponse(415, "invalid_request", "Invalid request.");
  }
  const body = await req.json().catch(() => null);
  if (!looksLikeToken(body?.token)) {
    return errorResponse(404, "invalid", "This invitation link is not valid.");
  }

  const result = await callOrgService("/internal/invitations/lookup", { token: body.token });
  if (!result || result.status !== 200) return forwardFailure(result);

  return NextResponse.json(
    {
      organizationName: result.data.organization_name,
      email: result.data.email,
      expiresAt: result.data.expires_at,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
