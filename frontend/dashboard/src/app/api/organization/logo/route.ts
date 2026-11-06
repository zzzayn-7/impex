import { NextRequest, NextResponse } from "next/server";

import { fetchLogo } from "@/lib/onboarding";
import { fail, sessionToken } from "@/lib/sales-routes";

export const dynamic = "force-dynamic";

// The signed-in administrator's OWN organization's logo, for the portal header and the setup screens. There is no id, path or query
// that names an organization: the Organization Service derives it from the session token, so another company's logo cannot be
// requested. Only the validated PNG the service stored is passed on, as a plain image (`nosniff`, a CSP that forbids everything);
// no storage key or path ever reaches the browser. `?v=` is only a cache-buster and is ignored.
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const result = await fetchLogo(token, req.headers.get("if-none-match"));
  if (!result) return fail("The logo is temporarily unavailable.", 503);
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Cache-Control": "private, max-age=300",
    ...(result.etag ? { ETag: result.etag } : {}),
  };
  if (result.status === 304) return new NextResponse(null, { status: 304, headers });
  if (result.status === 404) return fail("No logo.", 404);
  if (result.status === 401) return fail("Your session has expired. Please sign in again.", 401);
  if (result.status === 403) return fail("You do not have access to this.", 403);
  if (result.status !== 200 || !result.body) return fail("The logo is temporarily unavailable.", 503);
  return new NextResponse(result.body, { status: 200, headers: { "Content-Type": "image/png", ...headers } });
}
