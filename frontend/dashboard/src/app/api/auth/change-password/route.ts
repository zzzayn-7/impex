import { NextRequest, NextResponse } from "next/server";

import { MAX_PASSWORD_LENGTH } from "@/lib/password-policy";
import { TENANT_SESSION_COOKIE, isSecureRequest } from "@/lib/session";
import { authServiceUrl } from "@/lib/tenant-auth";

export const dynamic = "force-dynamic";

function fail(message: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

// The signed-in administrator chooses their OWN password (required after the Super Admin reset it). Only the two passwords are read; the person is the one the session cookie belongs to
// (the Auth Service decides from the token, never from anything sent here). The Auth Service checks the current password and the strength rules and, because every older sign-in ends
// when the password changes, answers with a fresh one that replaces the cookie so the person stays signed in. Nothing is logged: passwords never leave these two calls.
export async function POST(req: NextRequest) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return fail("You are not signed in.", 401);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid request.", 400);
  }
  const { currentPassword, newPassword } = (body ?? {}) as Record<string, unknown>;
  if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) return fail("Enter your current password and a new one.", 400);
  if (currentPassword.length > MAX_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) return fail(`A password can have at most ${MAX_PASSWORD_LENGTH} characters.`, 400);

  let res: Response;
  try {
    res = await fetch(`${authServiceUrl()}/api/v1/auth/me/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return fail("The authentication service is unavailable. Please try again shortly.", 503);
  }
  const data = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; detail?: { code?: unknown; message?: unknown; problems?: unknown } | string } | null;
  if (res.status === 401) return fail("Your session has expired. Please sign in again.", 401);
  if (res.status === 403) return fail("The current password is not right.", 403, { code: "wrong_password" });
  if (res.status === 422 || res.status === 400) {
    const detail = typeof data?.detail === "object" && data?.detail ? data.detail : {};
    const message = typeof detail.message === "string" ? detail.message : "That password cannot be used.";
    return fail(message, 422, { code: typeof detail.code === "string" ? detail.code : "invalid_password", problems: Array.isArray(detail.problems) ? detail.problems : undefined });
  }
  if (!res.ok || typeof data?.access_token !== "string") return fail("The password could not be changed. Please try again.", 502);

  const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0 ? Math.floor(data.expires_in) : 3600;
  const out = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  out.cookies.set({ name: TENANT_SESSION_COOKIE, value: data.access_token, httpOnly: true, secure: isSecureRequest(req), sameSite: "lax", path: "/", maxAge: expiresIn });
  return out;
}
