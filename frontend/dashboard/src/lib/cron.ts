import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

// Scheduled work on Vercel. A serverless function cannot keep a background loop running, so two services that normally run one (the Finance Service's
// synchronisation and the Support Service's e-mail outbox) get a one-shot, internal endpoint, and a Vercel schedule (vercel.json "schedules") calls the
// route in THIS app, which holds the bindings to those services and calls the endpoint with the shared secret.
//
//   schedule --(POST + Authorization: Bearer CRON_SECRET)--> /api/cron/<job> --(binding, X-Internal-Key)--> service /internal/v1/...
//
// The /api/cron/* routes are PUBLIC addresses (a schedule requests the production URL), so each one first checks the CRON_SECRET that Vercel sends and
// refuses everything else. They change nothing themselves and take no input from the caller.

const NO_STORE = { "Cache-Control": "no-store" };
const answer = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: NO_STORE });

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Null when the request carries the right CRON_SECRET; otherwise the refusal. An unset or too-short secret refuses everything (never "open when unset"). */
export function authorizeCron(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < 16) return answer(503, { error: "Scheduled jobs are not configured." });
  const given = req.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) return answer(401, { error: "Unauthorized." });
  return null;
}

/** Calls one internal endpoint of a service with the shared secret and reports what happened (no secret is ever echoed back). */
export async function runInternalJob(serviceUrl: string, path: string): Promise<NextResponse> {
  const key = process.env.MODULE_INTERNAL_API_KEY ?? "";
  if (!key) return answer(503, { error: "Service authentication is not configured." });
  try {
    const res = await fetch(`${serviceUrl}${path}`, { method: "POST", headers: { "X-Internal-Key": key }, cache: "no-store", signal: AbortSignal.timeout(280_000) });
    const data = await res.json().catch(() => null);
    return res.ok ? answer(200, { ok: true, result: data }) : answer(502, { ok: false, upstream_status: res.status });
  } catch {
    return answer(502, { ok: false, error: "The service could not be reached." });
  }
}
