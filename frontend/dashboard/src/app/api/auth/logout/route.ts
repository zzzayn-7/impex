import { NextRequest, NextResponse } from "next/server";

import { TENANT_SESSION_COOKIE, isSecureRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

// Clears only the tenant session cookie. A Super Admin session (a different cookie, a different app) is untouched.
export async function POST(req: NextRequest) {
  const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set({
    name: TENANT_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
