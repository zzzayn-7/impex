import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { TenantOrganization, fetchTenantOrganization } from "@/lib/organization";
import { SetupNeed, setupNeed } from "@/lib/onboarding";
import { TenantAdmin, fetchCurrentUser, isTenantAdmin } from "@/lib/tenant-auth";

// The logged-in organization administrator, or null. The user is re-validated against the Auth Service
// on every call, so a disabled account or an expired token stops working immediately. Only the tenant
// cookie is read: a Super Admin session cookie is invisible here.
export async function getTenantAdmin(): Promise<TenantAdmin | null> {
  const token = cookies().get(TENANT_SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = await fetchCurrentUser(token);
  return isTenantAdmin(user) ? user : null;
}

// The tenant session token, used as the Bearer token for server-side calls to tenant APIs.
export function getTenantToken(): string | undefined {
  return cookies().get(TENANT_SESSION_COOKIE)?.value;
}

export async function requireTenantAdmin(): Promise<TenantAdmin> {
  const user = await getTenantAdmin();
  if (!user) redirect("/login");
  return user;
}

// Where an administrator stands once signed in, decided from the services' own records on EVERY request (never from a cookie):
//   ready        - setup is complete (or the organization is inactive: the pages then explain that themselves, as before)
//   setup        - company and/or personal setup is incomplete: send them to /setup
//   unavailable  - the Organization Service could not answer: show a recoverable error; NEVER treat setup as complete
export type Workspace =
  | { kind: "ready"; admin: TenantAdmin; organization: TenantOrganization | null }
  | { kind: "setup"; admin: TenantAdmin; organization: TenantOrganization; need: Extract<SetupNeed, { required: true }> }
  | { kind: "unavailable"; admin: TenantAdmin };

export async function loadWorkspace(admin: TenantAdmin): Promise<Workspace> {
  const result = await fetchTenantOrganization(getTenantToken() ?? "");
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    // An inactive organization (403) keeps today's behaviour: the pages show their own "inactive or unavailable" explanation.
    return result.reason === "forbidden" ? { kind: "ready", admin, organization: null } : { kind: "unavailable", admin };
  }
  const need = setupNeed(admin, result.organization);
  return need.required ? { kind: "setup", admin, organization: result.organization, need } : { kind: "ready", admin, organization: result.organization };
}
