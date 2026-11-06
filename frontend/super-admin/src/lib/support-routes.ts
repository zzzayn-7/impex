import { NextRequest, NextResponse } from "next/server";

import { getSessionToken } from "@/lib/auth";

export const NO_STORE = { "Cache-Control": "no-store" };
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:\-]{8,100}$/;

export function fail(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

export const sessionToken = () => getSessionToken() || null;

export async function readObject(req: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Invalid request.", 415);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Invalid request.", 400);
  return body;
}

export const isResponse = (value: unknown): value is NextResponse => value instanceof NextResponse;
