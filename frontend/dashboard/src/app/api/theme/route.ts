import { NextRequest, NextResponse } from "next/server";

import { authServiceUrl } from "@/lib/tenant-auth";
import { TENANT_SESSION_COOKIE, THEME_COOKIE, isSecureRequest } from "@/lib/session";
import { encodeThemeCookie, isAccentId, isBackgroundId } from "@/lib/theme";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

// SAVE the signed-in person's own colour theme. Only two approved identifiers are read from the browser (a background and an accent): never a colour value, CSS
// or a user id. The person is the one the session token belongs to, and the Auth Service (the record) validates the identifiers again and saves them
// against that user alone. The cookie that lets the server paint the colours on the first byte is refreshed from what was actually saved.
export async function PUT(req: NextRequest) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return fail("You are not signed in.", 401);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid request.", 400);
  }
  const { background, accent } = (body ?? {}) as Record<string, unknown>;
  if (!isBackgroundId(background) || !isAccentId(accent)) return fail("Choose one of the available backgrounds and accent colors.", 400);

  let upstream: Response;
  try {
    upstream = await fetch(`${authServiceUrl()}/api/v1/auth/me/theme`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ background, accent }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return fail("The theme could not be saved just now. Please try again shortly.", 503);
  }
  if (upstream.status === 401) return fail("Your session has expired. Please sign in again.", 401);
  if (upstream.status === 422) return fail("Choose one of the available backgrounds and accent colors.", 400);
  if (!upstream.ok) return fail("The theme could not be saved. Please try again.", 502);

  const res = NextResponse.json({ theme: { background, accent } }, { headers: NO_STORE });
  res.cookies.set({ name: THEME_COOKIE, value: encodeThemeCookie({ background, accent }), httpOnly: false, secure: isSecureRequest(req), sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return res;
}
