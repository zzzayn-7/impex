import { NextRequest, NextResponse } from "next/server";

import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { QUANTITY_RE, UUID_RE, validateQuantity } from "@/lib/stock-validation";

// Shared by the /api/sales/* route handlers. Every handler: reads the tenant session from the HttpOnly cookie (no cookie =
// 401 and nothing is sent anywhere), accepts only the fields it lists, validates them, and lets the Sales Service decide
// everything that matters (the organization, product details, stock). The browser never supplies those.

export const NO_STORE = { "Cache-Control": "no-store" };

export function fail(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

export function sessionToken(req: NextRequest): string | undefined {
  return req.cookies.get(TENANT_SESSION_COOKIE)?.value;
}

/** The JSON object of a write request, or the error response to return. */
export async function readObject(req: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Invalid request.", 415);
  const body = (await req.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Invalid request.", 400);
  return body as Record<string, unknown>;
}

export const isResponse = (value: unknown): value is NextResponse => value instanceof NextResponse;

export const text = (value: unknown): string | undefined => (typeof value === "string" ? value.trim() : undefined);
export const collapse = (value: string) => value.replace(/\s+/g, " ");

export function checkUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/** Quantity as an exact string. (Whether fractions are allowed for the product's unit is decided by the Sales Service.) */
export function checkQuantity(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: false, message: "Enter the quantity as a number." };
  const problem = validateQuantity(value.trim(), true);
  return problem ? { ok: false, message: problem } : { ok: true, value: value.trim() };
}

export { QUANTITY_RE, UUID_RE };
