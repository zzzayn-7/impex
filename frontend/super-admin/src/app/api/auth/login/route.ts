import { NextRequest, NextResponse } from "next/server";

import { authServiceUrl, fetchCurrentUser, isSuperAdmin } from "@/lib/auth";
import { SESSION_COOKIE, isSecureRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid request.", 400);
  }

  const { email, password } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    return fail("Email and password are required.", 400);
  }

  // 1. Authenticate against the Auth Service
  let loginRes: Response;
  try {
    loginRes = await fetch(`${authServiceUrl()}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return fail("The authentication service is unavailable. Please try again shortly.", 503);
  }

  if (loginRes.status === 401) return fail("Invalid email or password.", 401);
  if (loginRes.status === 422) return fail("Enter a valid email address and password.", 400);
  if (loginRes.status === 403) return fail("This account is disabled.", 403);
  if (!loginRes.ok) return fail("Sign-in failed. Please try again.", 502);

  const { access_token: token, expires_in: expiresIn } = (await loginRes.json()) as {
    access_token: string;
    expires_in: number;
  };

  // 2. Verify the token and the role BEFORE creating a session
  const user = await fetchCurrentUser(token);
  if (!user) return fail("Sign-in failed. Please try again.", 502);
  if (!isSuperAdmin(user)) {
    return fail("You do not have permission to access the Super Admin portal.", 403);
  }

  // 3. Store the token in an HttpOnly cookie (never exposed to browser JavaScript)
  const res = NextResponse.json({ user: { full_name: user.full_name, email: user.email } });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    path: "/",
    maxAge: expiresIn,
  });
  return res;
}
