import { NextRequest, NextResponse } from "next/server";

import { TENANT_SESSION_COOKIE } from "@/lib/session";

// Fast first gate: no tenant session cookie -> /login. Only the tenant cookie counts; a Super Admin
// cookie ("impex_session") does not open this portal. The real check (valid token + organization-admin
// role + active + organization) happens server-side in requireTenantAdmin().
export function middleware(req: NextRequest) {
  if (req.cookies.has(TENANT_SESSION_COOKIE)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // /api/* route handlers enforce their own rules and answer with JSON, not an HTML redirect.
  matcher: ["/((?!login$|login/|api/|_next/|favicon.ico$).*)"],
};
