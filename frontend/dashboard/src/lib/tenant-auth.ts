import { ORGANIZATION_ADMIN_ROLE } from "@/lib/session";

// Server-side only. All authentication is delegated to the existing Auth Service; this app never
// stores users or checks passwords itself.

export type AuthUser = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  organization_id: string | null;
  is_active: boolean;
  created_at: string;
  // null until the administrator has confirmed their own profile (first-time onboarding). The Auth Service is the record.
  profile_setup_completed_at?: string | null;
  // The administrator's own colour theme (identifiers of the approved palettes), or null when they never chose one.
  theme_background?: string | null;
  theme_accent?: string | null;
  // The administrator's own home-page widget arrangement ({ version, revision, order, hidden }), or null when they never changed it.
  dashboard_layout?: unknown;
};

export type TenantAdmin = AuthUser & { role: "organization-admin"; organization_id: string; is_active: true };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function authServiceUrl(): string {
  return (process.env.AUTH_SERVICE_URL || "http://localhost:8000").replace(/\/$/, "");
}

// The one rule for who may use the organization portal. A Super Admin (or any other role) never passes,
// whatever else is true of the account.
export function isTenantAdmin(user: unknown): user is TenantAdmin {
  if (!user || typeof user !== "object") return false;
  const u = user as Partial<AuthUser>;
  return (
    u.role === ORGANIZATION_ADMIN_ROLE &&
    u.is_active === true &&
    typeof u.organization_id === "string" &&
    UUID_RE.test(u.organization_id)
  );
}

// Asks the Auth Service who the token belongs to (GET /api/v1/auth/me). Returns null for an invalid or
// expired token and when the service cannot be reached.
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

export type SignInResult =
  | { ok: true; token: string; expiresIn: number; user: TenantAdmin }
  | { ok: false; status: number; message: string };

const DEFAULT_SESSION_SECONDS = 3600;

export async function signInTenantAdmin(email: string, password: string): Promise<SignInResult> {
  // 1. Authenticate with the Auth Service
  let res: Response;
  try {
    res = await fetch(`${authServiceUrl()}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, status: 503, message: "The authentication service is unavailable. Please try again shortly." };
  }
  if (res.status === 401) return { ok: false, status: 401, message: "Invalid email or password." };
  if (res.status === 403) return { ok: false, status: 403, message: "This account is disabled." };
  if (res.status === 422) return { ok: false, status: 400, message: "Enter a valid email address and password." };
  if (!res.ok) return { ok: false, status: 502, message: "Sign-in failed. Please try again." };

  const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!body || typeof body.access_token !== "string") {
    return { ok: false, status: 502, message: "Sign-in failed. Please try again." };
  }
  const token = body.access_token;

  // 2. Verify who this is, from the Auth Service's own record (never from anything the browser sent)
  const user = await fetchCurrentUser(token);
  if (!user) return { ok: false, status: 502, message: "Sign-in failed. Please try again." };

  // 3. Only active organization administrators that belong to an organization may enter
  if (!isTenantAdmin(user)) {
    return { ok: false, status: 403, message: "This account does not have access to the organization portal." };
  }

  const expiresIn =
    typeof body.expires_in === "number" && body.expires_in > 0 ? Math.floor(body.expires_in) : DEFAULT_SESSION_SECONDS;
  return { ok: true, token, expiresIn, user };
}
