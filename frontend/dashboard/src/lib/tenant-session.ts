import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { TENANT_SESSION_COOKIE } from "@/lib/session";
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
