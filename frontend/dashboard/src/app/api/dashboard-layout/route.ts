import { NextRequest, NextResponse } from "next/server";

import { readSubmission, withRetained } from "@/lib/dashboard-layout";
import { availableOrgWidgets } from "@/lib/dashboard-widgets";
import { fetchTenantOrganization } from "@/lib/organization";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { authServiceUrl, fetchCurrentUser, isTenantAdmin } from "@/lib/tenant-auth";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

// SAVE the signed-in administrator's own home-page arrangement: which widgets are shown, in what order, and which are removed. Only two lists of widget
// identifiers are read from the browser, never HTML, CSS, a component or a user id. The person is the one the session token belongs to.
//   - Every identifier must be one of the widgets THIS administrator may use right now: that depends on the modules the Super Admin enabled for the
//     organization, which is read here, on the server (a browser cannot claim a module). A widget of a module that is switched off cannot be saved.
//   - What the person chose earlier for widgets they cannot use right now is carried along (at the end), so switching a module off and on again does
//     not lose it.
//   - The Auth Service (the record) validates the identifiers a second time against its own list for this role and stores them for this user alone.
export async function PUT(req: NextRequest) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return fail("You are not signed in.", 401);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid request.", 400);
  }

  const [organization, user] = await Promise.all([fetchTenantOrganization(token), fetchCurrentUser(token)]);
  if (!user || (!organization.ok && organization.reason === "unauthorized")) return fail("Your session has expired. Please sign in again.", 401);
  if (!isTenantAdmin(user)) return fail("This account does not have access to the organization portal.", 403);
  // Without the organization's module list nobody can say which widgets are allowed, so nothing is saved (the page keeps working as it was).
  const modules = organization.ok ? organization.organization.modules : undefined;
  if (!organization.ok && organization.reason === "unavailable") return fail("Your layout could not be saved just now. Please try again shortly.", 503);
  const available = availableOrgWidgets(modules, organization.ok).map((w) => w.id);

  const submission = readSubmission(body, available);
  if (!submission.ok) return fail("That layout is not available for your account.", 400);
  const merged = withRetained(submission, user.dashboard_layout, available);

  let upstream: Response;
  try {
    upstream = await fetch(`${authServiceUrl()}/api/v1/auth/me/dashboard-layout`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(merged),
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
