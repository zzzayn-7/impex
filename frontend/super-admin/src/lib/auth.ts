import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE, SUPER_ADMIN_ROLE } from "@/lib/session";

export type AuthUser = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
  created_at: string;
  // The Super Admin's own colour theme (identifiers of the approved palettes), or null when they never chose one.
  theme_background?: string | null;
  theme_accent?: string | null;
};

// Server-side only. Inside Docker this is the auth-service container; set in docker-compose.yml.
export function authServiceUrl(): string {
  return (process.env.AUTH_SERVICE_URL || "http://localhost:8000").replace(/\/$/, "");
}

export function isSuperAdmin(user: AuthUser): boolean {
  return user.role === SUPER_ADMIN_ROLE && user.is_active;
}

// Validates the token against the Auth Service (GET /api/v1/auth/me).
export async function fetchCurrentUser(token: string): Promise<AuthUser | null> {
  try {
    const res = await fetch(`${authServiceUrl()}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as AuthUser;
  } catch {
    return null;
  }
}

export function getSessionToken(): string | undefined {
  return cookies().get(SESSION_COOKIE)?.value;
}

// Returns the logged-in Super Admin, or null if there is no valid Super Admin session.
export async function getSuperAdmin(): Promise<AuthUser | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = await fetchCurrentUser(token);
  return user && isSuperAdmin(user) ? user : null;
}

export async function requireSuperAdmin(): Promise<AuthUser> {
  const user = await getSuperAdmin();
  if (!user) redirect("/login");
  return user;
}
