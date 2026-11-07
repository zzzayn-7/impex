// Organization Settings, server-side only. Every call to the Organization Service (and to the Auth Service for the administrator's own name)
// carries nothing but the signed-in administrator's own session token as a Bearer header: no organization id, no user id. The services derive
// both from the verified token, so there is nothing here for a browser to tamper with. See docs/settings.md.
import type { DateFormat, NumberFormat } from "@/lib/format";
import { orgServiceUrl } from "@/lib/organization";
import { authServiceUrl } from "@/lib/tenant-auth";

export type CompanyData = {
  name: string; contact_email: string; contact_phone: string | null; address_street: string | null; address_city: string | null; address_state: string | null;
  address_postal_code: string | null; website: string | null; description: string | null;
};
export type RestrictedData = { id: string; slug: string; country_code: string; tax_identifier: string | null; owner_email: string | null; status: string; created_at: string };
export type SettingsData = {
  version: number;
  setup_status: string;
  updated_at: string | null;
  company: CompanyData;
  restricted: RestrictedData;
  branding: { has_logo: boolean; logo_version: string | null };
  preferences: { default_currency: string; timezone: string; date_format: DateFormat; number_format: NumberFormat };
};
export type HistoryItem = {
  id: string; section: "company" | "branding" | "preferences"; field: string; old_value: string | null; new_value: string | null;
  changed_by_name: string | null; changed_by_email: string | null; source: string; version: number; batch_id: string; created_at: string;
};
export type HistoryData = { items: HistoryItem[]; total: number };

export type ServiceResult = { status: number; data: any } | null; // null = the service could not be reached

async function call(base: string, method: string, path: string, token: string, body?: unknown, form?: FormData): Promise<ServiceResult> {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

export const settingsApi = {
  get: (token: string) => call(orgServiceUrl(), "GET", "/api/v1/tenant/settings", token),
  history: (token: string, limit = 25) => call(orgServiceUrl(), "GET", `/api/v1/tenant/settings/history?limit=${limit}`, token),
  patchCompany: (token: string, body: Record<string, unknown>) => call(orgServiceUrl(), "PATCH", "/api/v1/tenant/settings/company", token, body),
  patchPreferences: (token: string, body: Record<string, unknown>) => call(orgServiceUrl(), "PATCH", "/api/v1/tenant/settings/preferences", token, body),
  putLogo: (token: string, form: FormData) => call(orgServiceUrl(), "PUT", "/api/v1/tenant/settings/logo", token, undefined, form),
  deleteLogo: (token: string, expectedVersion: number) => call(orgServiceUrl(), "DELETE", `/api/v1/tenant/settings/logo?expected_version=${expectedVersion}`, token),
  // the administrator's OWN name: the Auth Service changes that one field of the person the token belongs to (never a role, e-mail,
  // organization or password, and never another user)
  saveProfile: (token: string, fullName: string) => call(authServiceUrl(), "PATCH", "/api/v1/auth/me/profile", token, { full_name: fullName }),
};

export type SettingsResult =
  | { ok: true; settings: SettingsData }
  | { ok: false; reason: "unauthorized" | "forbidden" | "setup-required" | "unavailable" };

const reasonOf = (result: ServiceResult): "unauthorized" | "forbidden" | "setup-required" | "unavailable" => {
  if (!result) return "unavailable";
  if (result.status === 401) return "unauthorized";
  if (result.status === 403) return result.data?.detail?.code === "setup_required" ? "setup-required" : "forbidden";
  return "unavailable";
};

export async function getSettings(token: string): Promise<SettingsResult> {
  const result = await settingsApi.get(token);
  return result?.status === 200 && result.data ? { ok: true, settings: result.data } : { ok: false, reason: reasonOf(result) };
}

export async function getHistory(token: string): Promise<HistoryData> {
  const result = await settingsApi.history(token);
  return result?.status === 200 && Array.isArray(result.data?.items) ? result.data : { items: [], total: 0 };
}

export type SettingsFailure = { status: number; message: string; code?: string; field?: string; current?: SettingsData };

/** `detail` is a string or {code, message, field?, current?} from our services; anything else becomes a generic, recoverable message. */
export function describeSettingsFailure(result: ServiceResult): SettingsFailure {
  if (!result) return { status: 503, message: "We couldn't reach the service just now. Nothing was changed; please try again in a moment.", code: "unavailable" };
  const detail = result.data?.detail;
  const code = typeof detail === "object" && detail && typeof detail.code === "string" ? detail.code : undefined;
  const text = typeof detail === "string" ? detail : typeof detail?.message === "string" ? detail.message : null;
  switch (result.status) {
    case 401: return { status: 401, message: "Your session has expired. Please sign in again.", code: "unauthorized" };
    case 400: return { status: 400, message: text ?? "Please check what you entered.", code };
    case 403: return { status: 403, message: text ?? "You do not have access to this.", code };
    case 404: return { status: 404, message: text ?? "That was not found.", code };
    case 409: return { status: 409, message: text ?? "That could not be saved.", code, current: detail?.current };
    case 413:
    case 415: return { status: result.status, message: text ?? "That file could not be used.", code };
    case 422:
      if (code && text) return { status: 400, message: text, code, field: typeof detail.field === "string" ? detail.field : undefined };
      return { status: 400, message: "Please check what you entered.", code: "invalid" };
    case 503: return { status: 503, message: text ?? "The service is temporarily unavailable. Nothing was changed; please try again.", code: code ?? "unavailable" };
    default: return { status: 502, message: "That could not be completed. Nothing was changed. Please try again.", code: "service_error" };
  }
}
