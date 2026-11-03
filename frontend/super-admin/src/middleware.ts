import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/lib/session";

// Fast first gate: no session cookie -> /login.
// The real check (token valid + role is super-admin) happens server-side via requireSuperAdmin().
export function middleware(req: NextRequest) {
  if (req.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // /api/* route handlers enforce auth themselves and answer with JSON 401, not an HTML redirect.
  matcher: ["/((?!login$|login/|activate$|activate/|api/|_next/|favicon.ico$).*)"],
};
