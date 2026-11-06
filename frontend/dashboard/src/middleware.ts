import { NextRequest, NextResponse } from "next/server";

import { setupNeed } from "@/lib/onboarding";
import { orgServiceUrl } from "@/lib/organization";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { authServiceUrl } from "@/lib/tenant-auth";

// 1. PAGES - fast first gate: no tenant session cookie -> /login. Only the tenant cookie counts; a Super Admin cookie ("impex_session")
//    does not open this portal. The real check (valid token + organization-admin role + active + organization, and first-time setup)
//    happens server-side in the layouts (requireTenantAdmin / loadWorkspace).
//
// 2. BUSINESS APIs - first-time setup is mandatory before business activity, and that is enforced here on the SERVER, not just by hiding
//    pages: until the organization AND the administrator are set up, the portal's business routes (products, warehouses, stock, scan,
//    sales, purchasing) answer 403 `setup_required`. Authentication, setup, Help & Support, the logo, health checks and everything else
//    stay reachable (they are not matched). If the setup state cannot be read, the answer is 503 (fail closed), never "assume complete".
//    The services behind keep enforcing authentication, roles and tenant isolation on their own.
const GATED_API = /^\/api\/(products|warehouses|stock|scan|sales|purchasing)(\/|$)/;

const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (status: number, error: string, code: string) => NextResponse.json({ error, code }, { status, headers: NO_STORE });

async function get(url: string, token: string): Promise<{ status: number; data: any } | null> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    return { status: res.status, data: res.ok ? await res.json().catch(() => null) : null };
  } catch {
    return null;
  }
}

export async function gateApi(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return NextResponse.next(); // the route answers 401 itself
  const me = await get(`${authServiceUrl()}/api/v1/auth/me`, token);
  if (!me || (me.status !== 200 && me.status !== 401)) return refuse(503, "We could not check your account setup right now. Please try again in a moment.", "setup_check_unavailable");
  if (me.status === 401 || !me.data || me.data.role !== "organization-admin") return NextResponse.next(); // the route and the services refuse them
  const org = await get(`${orgServiceUrl()}/api/v1/tenant/organization`, token);
  if (!org) return refuse(503, "We could not check your organization setup right now. Please try again in a moment.", "setup_check_unavailable");
  if (org.status === 401 || org.status === 403) return NextResponse.next(); // an inactive organization is refused by the services
  if (org.status !== 200 || !org.data) return refuse(503, "We could not check your organization setup right now. Please try again in a moment.", "setup_check_unavailable");
  if (setupNeed(me.data, org.data).required) return refuse(403, "Finish the first-time setup before using this part of Impex.", "setup_required");
  return NextResponse.next();
}

export async function middleware(req: NextRequest) {
  if (GATED_API.test(req.nextUrl.pathname)) return gateApi(req);
  if (req.cookies.has(TENANT_SESSION_COOKIE)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // pages (everything except login, the API, static files)
    "/((?!login$|login/|api/|_next/|favicon.ico$).*)",
    // the business APIs that setup gates
    "/api/(products|warehouses|stock|scan|sales|purchasing)/:path*",
    "/api/(products|warehouses|stock|scan|sales|purchasing)",
  ],
};
