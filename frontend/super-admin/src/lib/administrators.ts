import { NextResponse } from "next/server";

import { orgServiceUrl } from "@/lib/organizations";

// Server-side only. Talks to the Organization Service with the logged-in Super Admin's own token
// (read from the HttpOnly cookie by the caller). Nothing here is ever sent to the browser except
// the safe fields of an administrator record.

export type AdministratorStatus = "pending" | "active" | "expired";

export type Administrator = {
  id: string;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  full_name: string | null;
  email: string;
  role: string;
  status: AdministratorStatus;
  invited_at: string;
  expires_at: string;
  activated_at: string | null;
};

export type AdministratorList =
  | { ok: true; administrators: Administrator[] }
  | { ok: false; reason: "unauthorized" | "forbidden" | "unavailable" };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listAdministrators(token: string): Promise<AdministratorList> {
  try {
    const res = await fetch(`${orgServiceUrl()}/api/v1/organizations/administrators`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ok: false, reason: "unauthorized" };
    if (res.status === 403) return { ok: false, reason: "forbidden" };
    if (!res.ok) return { ok: false, reason: "unavailable" };
    return { ok: true, administrators: (await res.json()) as Administrator[] };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export type OrgServiceResult = { status: number; data: any } | null;

// Call the Organization Service as the Super Admin. null = the service could not be reached.
export async function orgServiceSend(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  token: string,
  body?: unknown
): Promise<OrgServiceResult> {
  try {
    const res = await fetch(`${orgServiceUrl()}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      // inviting sends an email while the request is open, so allow for a slow mail server
      signal: AbortSignal.timeout(20000),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

export const orgServicePost = (path: string, token: string, body?: unknown) => orgServiceSend("POST", path, token, body);

// Invites a person to administer an organization. The role is fixed by the backend; only an
// organization (by id), a name and an email can be supplied.
export function inviteAdministrator(token: string, organizationId: string, email: string, fullName?: string) {
  return orgServicePost(`/api/v1/organizations/${organizationId}/administrators`, token, {
    email,
    ...(fullName ? { full_name: fullName } : {}),
  });
}

// A safe, user-facing description of a failed Organization Service answer.
export function describeFailure(result: OrgServiceResult): { status: number; message: string } {
  if (!result) {
    return { status: 503, message: "The organization service is unavailable. Please try again shortly." };
  }
  const detail = typeof result.data?.detail === "string" ? (result.data.detail as string) : null;
  switch (result.status) {
    case 401:
      return { status: 401, message: "Your session has expired. Please sign in again." };
    case 400:
      return { status: 400, message: detail ?? "Please check the administrator's details." };
    case 403:
      return { status: 403, message: "You do not have permission to manage administrators." };
    case 404:
      return { status: 404, message: detail ?? "Not found." };
    case 409:
      return { status: 409, message: detail ?? "This administrator already exists." };
    case 422:
      return { status: 400, message: detail ?? "Please check the administrator's details." };
    case 502:
      return { status: 502, message: detail ?? "The invitation email could not be sent. Please try again." };
    case 503:
      return { status: 503, message: detail ?? "The service is temporarily unavailable. Please try again." };
    default:
      return { status: 502, message: "The request could not be completed. Please try again." };
  }
}

export function failureResponse(result: OrgServiceResult) {
  const { status, message } = describeFailure(result);
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
