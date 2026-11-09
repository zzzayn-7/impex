import { NextRequest, NextResponse } from "next/server";

import { GateRefusal, decideGate, gateUnavailable } from "@/lib/api-gate";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

// 1. PAGES - fast first gate: no tenant session cookie -> /login. Only the tenant cookie counts; a Super Admin cookie ("impex_session")
//    does not open this portal. The real check (valid token + organization-admin role + active + organization, and first-time setup)
//    happens server-side in the layouts (requireTenantAdmin / loadWorkspace).
//
// 2. BUSINESS APIs - first-time setup is mandatory before business activity, and that is enforced here on the SERVER, not just by hiding
//    pages: until the organization AND the administrator are set up, the portal's business routes (products, stock, scan,
//    sales, purchasing, finance) answer 403 `setup_required`. Authentication, setup, Help & Support, the logo, health checks and everything else
//    stay reachable (they are not matched). If the setup state cannot be read, the answer is 503 (fail closed), never "assume complete".
//    The services behind keep enforcing authentication, roles and tenant isolation on their own.
const GATED_API = /^\/api\/(products|stock|scan|sales|purchasing|finance)(\/|$)/;

//    The rules themselves live in lib/api-gate.ts. WHERE they run depends on the platform: locally and in Docker they run right here. On Vercel the Auth and
//    Organization services are reached through service bindings, which resolve only inside functions and NEVER in middleware, so there the middleware sends the
//    caller's session cookie and the path to the /api/gate route handler (same deployment, same rules) and relays its answer. Either way: fail closed.
const NO_STORE = { "Cache-Control": "no-store" };
const respond = ({ status, body }: GateRefusal) => NextResponse.json(body, { status, headers: NO_STORE });

/** True where service bindings are the only way to reach the services (they do not resolve in middleware). */
const viaGateRoute = () => Boolean(process.env.VERCEL || process.env.IMPEX_GATE_VIA_ROUTE);

async function askGateRoute(req: NextRequest, token: string): Promise<GateRefusal | null> {
  try {
    const res = await fetch(`${req.nextUrl.origin}/api/gate`, {
      method: "POST",
      headers: { cookie: `${TENANT_SESSION_COOKIE}=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: req.nextUrl.pathname }),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const data = res.ok ? await res.json().catch(() => null) : null;
    if (!data || !("refusal" in data)) return gateUnavailable();
    const refusal = data.refusal;
    return refusal && typeof refusal.status === "number" && refusal.body && typeof refusal.body === "object" ? (refusal as GateRefusal) : null;
  } catch {
    return gateUnavailable();
  }
}

export async function gateApi(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return NextResponse.next(); // the route answers 401 itself
  const refusal = viaGateRoute() ? await askGateRoute(req, token) : await decideGate(token, req.nextUrl.pathname);
  return refusal ? respond(refusal) : NextResponse.next();
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
    "/api/(products|stock|scan|sales|purchasing|finance)/:path*",
    "/api/(products|stock|scan|sales|purchasing|finance)",
  ],
};
