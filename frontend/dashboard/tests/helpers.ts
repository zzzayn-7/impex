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
