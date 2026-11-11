import { NextResponse } from "next/server";

import { orgRequest, type ServiceResult } from "@/lib/modules";

// Server-side only. Lock / unlock / delete an organization: the Super Admin's three decisions about a customer (see the Organization Service's app/lifecycle.py).
// The Organization Service verifies the Super Admin role on every call and records who acted; the browser only sends the organization (from the address), an optional
// note (lock) or the typed name (delete). Nothing else is forwarded.

export const NO_STORE = { "Cache-Control": "no-store" };

export function lifecycleFailure(result: ServiceResult, what: string) {
  if (!result) return NextResponse.json({ error: `The organization service is unavailable. Nothing was changed; please try again in a moment.` }, { status: 503, headers: NO_STORE });
  const detail = result.data?.detail;
  const message = typeof detail === "string" ? detail : typeof detail === "object" && detail && typeof detail.message === "string" ? (detail.message as string) : null;
  const code = typeof detail === "object" && detail ? (detail.code as string | undefined) : undefined;
  switch (result.status) {
    case 401: return NextResponse.json({ error: "Your session has expired. Please sign in again." }, { status: 401, headers: NO_STORE });
    case 403: return NextResponse.json({ error: `Only a Super Admin can ${what}.` }, { status: 403, headers: NO_STORE });
    case 404: return NextResponse.json({ error: "Organization not found. It may already have been deleted." }, { status: 404, headers: NO_STORE });
    case 409: case 422: return NextResponse.json({ error: message ?? "That could not be done.", code }, { status: result.status, headers: NO_STORE });
    case 502: return NextResponse.json({ error: message ?? "The deletion did not finish. Run it again to continue.", code, service: detail?.service }, { status: 502, headers: NO_STORE });
    default: return NextResponse.json({ error: "That could not be completed. Nothing was changed. Please try again." }, { status: 502, headers: NO_STORE });
  }
}
