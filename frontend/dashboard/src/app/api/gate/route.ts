import { NextRequest, NextResponse } from "next/server";

import { decideGate } from "@/lib/api-gate";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

// The business API gate, as a route handler. On Vercel the Auth and Organization services are reached through service bindings, and a binding resolves only
// inside functions (never in middleware): so the middleware (src/middleware.ts) sends the caller's session cookie and the path it is checking HERE, and relays
// the answer. Everything else (local development, Docker) runs the same rules (lib/api-gate.ts) directly in the middleware and never calls this.
//
// It only ever looks at the caller's OWN session: no cookie means nothing to decide (the business route itself answers 401); the path only picks the module.
// It is not itself a gated route, so it cannot recurse, and it changes nothing.
export async function POST(req: NextRequest) {
  const token = req.cookies.get(TENANT_SESSION_COOKIE)?.value;
  const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
  const path = typeof body?.path === "string" && body.path.startsWith("/api/") && body.path.length <= 200 ? body.path : null;
  if (!token) return NextResponse.json({ refusal: null }, { headers: { "Cache-Control": "no-store" } });
  if (!path) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: { "Cache-Control": "no-store" } }); // never an implicit "allow"
  return NextResponse.json({ refusal: await decideGate(token, path) }, { headers: { "Cache-Control": "no-store" } });
}
