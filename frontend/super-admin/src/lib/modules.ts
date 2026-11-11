import { NextResponse } from "next/server";

import { orgServiceUrl } from "@/lib/organizations";

// Server-side only. Talks to the Organization Service with the signed-in Super Admin's own token (the HttpOnly cookie). The service
// verifies the Super Admin role with the Auth Service on every call; nothing here decides who may change a module.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ModuleKey = "inventory" | "purchasing" | "sales" | "finance";

export type ModuleView = {
  key: ModuleKey;
  name: string;
  description: string;
  features: string[];
  requires: ModuleKey[];
  available: boolean;
  enabled: boolean;
  effective: boolean;
  updated_at: string | null;
  updated_by_name: string | null;
};
export type PermanentView = { key: string; name: string; description: string };
export type ModulesState = { organization_id: string; organization_name: string; revision: number; modules: ModuleView[]; permanent: PermanentView[] };

export type Blocker = { code: string; module: ModuleKey; message: string; counts?: { code: string; label: string; count: number }[] };
export type Warning = { module: ModuleKey; code: string; label: string; count: number };
export type Preview = {
  revision: number;
  changes: { module: ModuleKey; name: string; from_enabled: boolean; to_enabled: boolean }[];
  blockers: Blocker[];
  warnings: Warning[];
  can_apply: boolean;
};
export type HistoryItem = {
  id: string;
  module: ModuleKey;
  module_name: string;
  action: "seeded" | "migrated" | "enabled" | "disabled";
  old_enabled: boolean | null;
  new_enabled: boolean;
  changed_by_name: string | null;
  changed_by_email: string | null;
  reason: string | null;
  batch_id: string;
  created_at: string;
};
export type HistoryPage = { items: HistoryItem[]; total: number };

export type ModulesResult<T> = { ok: true; data: T } | { ok: false; reason: "unauthorized" | "forbidden" | "not-found" | "unavailable" };
export type ServiceResult = { status: number; data: any } | null; // null = the service could not be reached

export async function orgRequest(method: "GET" | "POST" | "PUT", path: string, token: string, body?: unknown, timeoutMs = 20000): Promise<ServiceResult> {
  try {
    const res = await fetch(`${orgServiceUrl()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      // a preview asks the Purchasing and Sales services what is in progress: allow for that
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

function failure(result: ServiceResult): { ok: false; reason: "unauthorized" | "forbidden" | "not-found" | "unavailable" } {
  const status = result?.status;
  return { ok: false, reason: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not-found" : "unavailable" };
}

export async function getModules(token: string, organizationId: string): Promise<ModulesResult<ModulesState>> {
  const result = await orgRequest("GET", `/api/v1/organizations/${organizationId}/modules`, token);
  return result?.status === 200 && result.data ? { ok: true, data: result.data } : failure(result);
}

export async function getHistory(token: string, organizationId: string, limit = 50, offset = 0): Promise<ModulesResult<HistoryPage>> {
  const result = await orgRequest("GET", `/api/v1/organizations/${organizationId}/modules/history?limit=${limit}&offset=${offset}`, token);
  return result?.status === 200 && result.data ? { ok: true, data: result.data } : failure(result);
}

/** A safe, user-facing description of a failed Organization Service answer. */
export function describeModulesFailure(result: ServiceResult): { status: number; message: string; code?: string; detail?: any } {
  if (!result) return { status: 503, message: "The organization service is unavailable. Nothing was changed; please try again in a moment." };
  const detail = result.data?.detail;
  const code = typeof detail === "object" && detail ? (detail.code as string | undefined) : undefined;
  const text = typeof detail === "string" ? detail : typeof detail === "object" && detail && typeof detail.message === "string" ? (detail.message as string) : null;
  switch (result.status) {
    case 401: return { status: 401, message: "Your session has expired. Please sign in again." };
    case 403: return { status: 403, message: "Only a Super Admin can manage modules." };
    case 404: return { status: 404, message: "Organization not found." };
    case 409: return { status: 409, message: text ?? "That change could not be applied.", code, detail };
    case 422: return { status: 422, message: text ?? "Please check the change.", code };
    case 503: return { status: 503, message: "The organization service is unavailable. Nothing was changed; please try again in a moment." };
    default: return { status: 502, message: "That could not be completed. Nothing was changed. Please try again." };
  }
}

export function modulesFailureResponse(result: ServiceResult) {
  const { status, message, code, detail } = describeModulesFailure(result);
  const extra = code === "blocked" && Array.isArray(detail?.blockers) ? { blockers: detail.blockers } : {};
  return NextResponse.json({ error: message, code, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

const MODULE_KEYS = ["inventory", "purchasing", "sales", "finance"];

/** Only known module keys with true/false are forwarded: nothing else from the browser reaches the Organization Service. */
export function cleanChanges(value: unknown): Record<string, boolean> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, boolean> = {};
  for (const [key, wanted] of Object.entries(value as Record<string, unknown>)) {
    if (!MODULE_KEYS.includes(key) || typeof wanted !== "boolean") return null;
    out[key] = wanted;
  }
  return Object.keys(out).length > 0 ? out : null;
}
