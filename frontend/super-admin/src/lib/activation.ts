import { NextResponse } from "next/server";

import { orgServiceUrl } from "@/lib/organizations";

// Server-side only. The key authenticates this portal to the Organization Service's internal
// activation API. It is never sent to, or readable by, the browser.
type OrgResult = { status: number; data: any };

export type ApiError = { code: string; message: string; problems?: string[] };

export function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ code, message, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function callOrgService(path: string, body: unknown): Promise<OrgResult | null> {
  const key = process.env.ORG_ACTIVATION_API_KEY;
  if (!key) return null; // misconfigured: treated as "unavailable"
  try {
    const res = await fetch(`${orgServiceUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": key },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

// Turns a failed Organization Service answer into a safe, user-facing response.
export function forwardFailure(result: OrgResult | null) {
  if (!result) {
    return errorResponse(503, "temporarily_unavailable", "Activation is temporarily unavailable. Please try again in a moment.");
  }
  const detail = result.data?.detail;
  if (detail && typeof detail === "object" && typeof detail.code === "string") {
    const status = [404, 409, 410, 422, 503].includes(result.status) ? result.status : 502;
    return errorResponse(status, detail.code, String(detail.message ?? "Request failed."), {
      problems: Array.isArray(detail.problems) ? detail.problems : undefined,
    });
  }
  if (result.status === 401 || result.status === 502 || result.status === 503) {
    return errorResponse(503, "temporarily_unavailable", "Activation is temporarily unavailable. Please try again in a moment.");
  }
  return errorResponse(502, "service_error", "Activation could not be completed. Please try again.");
}

export function looksLikeToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}
