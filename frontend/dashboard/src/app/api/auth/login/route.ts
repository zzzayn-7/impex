import { NextRequest, NextResponse } from "next/server";

import { TENANT_SESSION_COOKIE, isSecureRequest } from "@/lib/session";
import { signInTenantAdmin } from "@/lib/tenant-auth";

export const dynamic = "force-dynamic";

function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid request.", 400);
  }

  // Only email and password are read. Any organization id (or anything else) sent by the browser is ignored:
  // the organization comes from the Auth Service's record of the authenticated user.
  const { email, password } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    return fail("Email and password are required.", 400);
  }

  const result = await signInTenantAdmin(email.trim(), password);
  if (!result.ok) return fail(result.message, result.status);

  // The token goes into an HttpOnly cookie, never into the response body or browser storage.
  const res = NextResponse.json(
    { user: { full_name: result.user.full_name } },
    { headers: { "Cache-Control": "no-store" } }
  );
  res.cookies.set({
    name: TENANT_SESSION_COOKIE,
    value: result.token,
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    path: "/",
    maxAge: result.expiresIn,
  });
  return res;
}
