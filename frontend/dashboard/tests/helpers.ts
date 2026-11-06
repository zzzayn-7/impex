import { vi } from "vitest";

export const ORG_ID = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";

export const orgAdmin = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "owner@acme.example",
  full_name: "Olivia Owner",
  role: "organization-admin",
  organization_id: ORG_ID,
  is_active: true,
  created_at: "2026-11-03T00:00:00+00:00",
  profile_setup_completed_at: "2026-11-03T00:05:00+00:00", // first-time onboarding done (the Auth Service's record)
};
export const superAdmin = { ...orgAdmin, id: "22222222-2222-4222-8222-222222222222", email: "root@impex.example", full_name: "Root Admin", role: "super-admin", organization_id: null };
export const regularUser = { ...orgAdmin, id: "33333333-3333-4333-8333-333333333333", email: "user@example.org", full_name: "Regular User", role: "user", organization_id: null };

export type Account = { password: string; user: Record<string, unknown>; loginStatus?: number; meStatus?: number };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Replaces fetch with a fake Auth Service: POST /api/v1/auth/login and GET /api/v1/auth/me.
export function stubAuthService(accounts: Record<string, Account>) {
  const tokens = new Map<string, Account>();
  const calls: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];

  const fetchMock = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method ?? "GET", headers, body });

    if (url.endsWith("/api/v1/auth/login")) {
      const account = accounts[body?.email];
      if (!account || account.password !== body.password) return json(401, { detail: "Invalid email or password" });
      if (account.loginStatus) return json(account.loginStatus, { detail: "nope" });
      const token = `token-for-${body.email}`;
      tokens.set(token, account);
      return json(200, { access_token: token, token_type: "bearer", expires_in: 3600 });
    }
    if (url.endsWith("/api/v1/auth/me")) {
      const account = tokens.get((headers.Authorization ?? "").replace("Bearer ", ""));
      if (!account) return json(401, { detail: "Invalid or expired token" });
      if (account.meStatus) return json(account.meStatus, { detail: "nope" });
      return json(200, account.user);
    }
    return json(404, { detail: "not found" });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls, tokens, issue: (token: string, account: Account) => tokens.set(token, account) };
}

export const standardAccounts = (): Record<string, Account> => ({
  "owner@acme.example": { password: "Str0ng!Passphrase", user: orgAdmin },
  "root@impex.example": { password: "Str0ng!Passphrase", user: superAdmin },
  "user@example.org": { password: "Str0ng!Passphrase", user: regularUser },
});


// ---- two organizations, for the tenant-isolation tests ------------------------------------------------
export const ORG_B_ID = "b2e5c1d4-7a8f-4c3b-9d21-0f6e5a4b3c2d";
export const orgAdminB = {
  ...orgAdmin,
  id: "44444444-4444-4444-8444-444444444444",
  email: "owner@beta.example",
  full_name: "Bruno Beta",
  organization_id: ORG_B_ID,
};
export const alphaOrg = {
  id: ORG_ID, name: "Alpha Trading GmbH", slug: "alpha-trading", country_code: "DE", tax_identifier: "DE111111111",
  contact_email: "ops@alpha.example", is_active: true, created_at: "2026-11-01T10:00:00+00:00",
  setup_status: "completed", has_logo: false, logo_version: null, // first-time onboarding done (the Organization Service's record)
  modules: ["inventory", "purchasing", "sales"], // what the Super Admin enabled
};
export const betaOrg = {
  id: ORG_B_ID, name: "Beta Logistics SARL", slug: "beta-logistics", country_code: "FR", tax_identifier: "FR222222222",
  contact_email: "ops@beta.example", is_active: true, created_at: "2026-11-02T10:00:00+00:00",
  setup_status: "completed", has_logo: false, logo_version: null,
  modules: ["inventory", "purchasing", "sales"],
};

export type BackendEntry = { user: Record<string, unknown>; organization?: { status: number; body?: unknown } };

// Replaces fetch with a fake Auth Service (/me) AND Organization Service (/api/v1/tenant/organization).
// Like the real services, the organization returned is decided by the token alone.
export function stubBackend(entries: Record<string, BackendEntry>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init.method ?? "GET", headers, body: init.body });
    const entry = entries[(headers.Authorization ?? "").replace("Bearer ", "")];
    if (url.endsWith("/api/v1/auth/me")) return entry ? json(200, entry.user) : json(401, { detail: "Invalid or expired token" });
    if (url.endsWith("/api/v1/tenant/organization")) {
      if (!entry) return json(401, { detail: "Missing, invalid or expired token" });
      const organization = entry.organization ?? { status: 503, body: {} };
      return json(organization.status, organization.body ?? {});
    }
    return json(404, { detail: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls, organizationCalls: () => calls.filter((c) => c.url.includes("/tenant/organization")) };
}
