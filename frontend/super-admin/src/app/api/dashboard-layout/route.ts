import { NextRequest, NextResponse } from "next/server";

import { authServiceUrl, fetchCurrentUser, isSuperAdmin } from "@/lib/auth";
import { readSubmission } from "@/lib/dashboard-layout";
import { ADMIN_WIDGET_IDS } from "@/lib/dashboard-widgets";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

// SAVE the signed-in Super Admin's own home-page arrangement: which widgets are shown, in what order, and which are removed. Only two lists of widget
// identifiers are read from the browser, never HTML, CSS, a component or a user id. The person is the one the session token belongs to, and only this
// portal's own ("admin.") widgets are accepted; the Auth Service (the record) validates them again for the Super Admin role and stores them for this user alone.
export async function PUT(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return fail("You are not signed in.", 401);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid request.", 400);
  }
  const submission = readSubmission(body, ADMIN_WIDGET_IDS);
  if (!submission.ok) return fail("That layout is not available for your account.", 400);

  const user = await fetchCurrentUser(token);
  if (!user) return fail("Your session has expired. Please sign in again.", 401);
  if (!isSuperAdmin(user)) return fail("This account does not have access to the Super Admin portal.", 403);

  let upstream: Response;
  try {
    upstream = await fetch(`${authServiceUrl()}/api/v1/auth/me/dashboard-layout`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ order: submission.order, hidden: submission.hidden }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return fail("Your layout could not be saved just now. Please try again shortly.", 503);
  }
  if (upstream.status === 401) return fail("Your session has expired. Please sign in again.", 401);
  if (upstream.status === 422) return fail("That layout is not available for your account.", 400);
  if (!upstream.ok) return fail("Your layout could not be saved. Please try again.", 502);

  const profile = (await upstream.json().catch(() => null)) as { dashboard_layout?: unknown } | null;
  return NextResponse.json({ layout: profile?.dashboard_layout ?? null }, { headers: NO_STORE });
}
