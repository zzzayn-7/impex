// First-time onboarding: the ONE rule that decides whether an administrator must go through the setup screens, plus the
// server-side calls the setup routes make. Server-side only.
//
// The records of truth are in the services, never in the browser:
//   * the company's setup state is the Organization Service's (organizations.setup_status);
//   * the administrator's own profile confirmation is the Auth Service's (users.profile_setup_completed_at).
// A cookie, localStorage or sessionStorage value is never consulted. The organization and the user are derived from the verified
// session token by those services; nothing here accepts an organization id or a user id from the browser.
import type { TenantOrganization } from "@/lib/organization";
import { orgServiceUrl } from "@/lib/organization";
import type { AuthUser } from "@/lib/tenant-auth";
import { authServiceUrl } from "@/lib/tenant-auth";

export type SetupNeed =
  | { required: false }
  | { required: true; mode: "full" | "profile" }; // full: company + you + review.  profile: only "you" (the company is already set up)

/** Fail closed: anything but an explicit "completed" / a confirmation time means the step is still to do. */
export function setupNeed(admin: Pick<AuthUser, "profile_setup_completed_at">, organization: Pick<TenantOrganization, "setup_status">): SetupNeed {
  if (organization.setup_status !== "completed") return { required: true, mode: "full" };
  if (!admin.profile_setup_completed_at) return { required: true, mode: "profile" };
  return { required: false };
}

// ---- calls to the services (Bearer token only) --------------------------------------------------------------------------
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

export const org = {
  status: (token: string) => call(orgServiceUrl(), "GET", "/api/v1/tenant/onboarding", token),
  saveCompany: (token: string, name: string, currency?: string) => call(orgServiceUrl(), "PUT", "/api/v1/tenant/onboarding/company", token, { name, ...(currency ? { default_currency: currency } : {}) }),
  uploadLogo: (token: string, form: FormData) => call(orgServiceUrl(), "PUT", "/api/v1/tenant/onboarding/logo", token, undefined, form),
  removeLogo: (token: string) => call(orgServiceUrl(), "DELETE", "/api/v1/tenant/onboarding/logo", token),
  complete: (token: string, companyName: string, currency?: string) => call(orgServiceUrl(), "POST", "/api/v1/tenant/onboarding/complete", token, { company_name: companyName, ...(currency ? { default_currency: currency } : {}) }),
};

export const auth = {
  saveProfile: (token: string, fullName: string) => call(authServiceUrl(), "PATCH", "/api/v1/auth/me/profile", token, { full_name: fullName }),
  completeProfile: (token: string, fullName?: string) => call(authServiceUrl(), "POST", "/api/v1/auth/me/profile/complete", token, fullName === undefined ? {} : { full_name: fullName }),
};

/** The logo as raw bytes for the browser (through this portal's own route). */
export async function fetchLogo(token: string, ifNoneMatch: string | null): Promise<{ status: number; body: ArrayBuffer | null; etag: string | null } | null> {
  try {
    const res = await fetch(`${orgServiceUrl()}/api/v1/tenant/organization/logo`, {
      headers: { Authorization: `Bearer ${token}`, ...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status !== 200) return { status: res.status, body: null, etag: res.headers.get("etag") };
    return { status: 200, body: await res.arrayBuffer(), etag: res.headers.get("etag") };
  } catch {
    return null;
  }
}

// ---- failures, turned into safe answers for the browser --------------------------------------------------------------------------
export type SetupFailure = { status: number; message: string; code?: string };

/** `detail` is either a string or {code, message} from our services; anything else becomes a generic, recoverable message. */
export function describeSetupFailure(result: ServiceResult, what: "company" | "profile" | "logo" = "company"): SetupFailure {
  if (!result) return { status: 503, message: "We couldn't reach the service just now. Nothing was lost; please try again in a moment.", code: "unavailable" };
  const detail = result.data?.detail;
  const code = typeof detail === "object" && detail && typeof detail.code === "string" ? detail.code : undefined;
  const text = typeof detail === "string" ? detail : typeof detail?.message === "string" ? detail.message : null;
  switch (result.status) {
    case 401:
      return { status: 401, message: "Your session has expired. Please sign in again.", code: "unauthorized" };
    case 403:
      return { status: 403, message: text ?? "You do not have access to this.", code };
    case 409:
    case 413:
    case 415:
      return { status: result.status, message: text ?? "That could not be saved.", code };
    case 422:
      if (code) return { status: 400, message: text ?? "Some values were rejected.", code };
      return { status: 400, message: what === "logo" ? "That file could not be used as a logo." : "Please check what you entered.", code: "invalid" };
    case 503:
      return { status: 503, message: text ?? "The service is temporarily unavailable. Nothing was lost; please try again.", code: code ?? "unavailable" };
    default:
      return { status: 502, message: "That could not be completed. Please try again.", code: "service_error" };
  }
}
