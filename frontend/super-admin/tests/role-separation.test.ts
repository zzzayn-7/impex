import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ORG_ID, orgAdmin, regularUser, stubAuthService, standardAccounts, superAdmin } from "./helpers";

// A mutable cookie jar standing in for the incoming request's cookies.
const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import { POST as login } from "@/app/api/auth/login/route";
import { getSuperAdmin, isSuperAdmin } from "@/lib/auth";
import { middleware } from "@/middleware";

const PASSWORD = "Str0ng!Passphrase";

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  for (const key of Object.keys(jar)) delete jar[key];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const loginRequest = (email: string, password = PASSWORD) =>
  new NextRequest("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

describe("Super Admin portal: who may enter", () => {
  it("accepts an active super-admin only", () => {
    expect(isSuperAdmin(superAdmin as any)).toBe(true);
    expect(isSuperAdmin({ ...superAdmin, is_active: false } as any)).toBe(false);
  });

  it.each([
    ["an organization administrator", orgAdmin],
    ["an organization administrator with an organization id", { ...orgAdmin, organization_id: ORG_ID }],
    ["a regular user", regularUser],
  ])("rejects %s", (_label, user) => {
    expect(isSuperAdmin(user as any)).toBe(false);
  });
});

describe("Super Admin login route", () => {
  it("signs in a Super Admin with the Super Admin cookie only", async () => {
    stubAuthService(standardAccounts());
    const res = await login(loginRequest("root@impex.example"));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^impex_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).not.toMatch(/impex_tenant_session/);
  });

  it.each([
    ["an organization administrator", "owner@acme.example"],
    ["a regular user", "user@example.org"],
  ])("refuses %s with the correct password and sets no cookie", async (_label, email) => {
    stubAuthService(standardAccounts());
    const res = await login(loginRequest(email));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("Super Admin session guard", () => {
  const withTokens = () => {
    const stub = stubAuthService({});
    stub.issue("super-token", { password: "", user: superAdmin });
    stub.issue("org-admin-token", { password: "", user: orgAdmin });
    return stub;
  };

  it("accepts a Super Admin token in the Super Admin cookie", async () => {
    withTokens();
    jar["impex_session"] = "super-token";
    expect((await getSuperAdmin())?.role).toBe("super-admin");
  });

  it("rejects an organization administrator's token even when placed in the Super Admin cookie", async () => {
    withTokens();
    jar["impex_session"] = "org-admin-token";
    expect(await getSuperAdmin()).toBeNull();
  });

  it("ignores the organization portal's cookie completely", async () => {
    const { fetchMock } = withTokens();
    jar["impex_tenant_session"] = "org-admin-token";
    expect(await getSuperAdmin()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("middleware does not accept the organization portal's cookie", () => {
    const res = middleware(new NextRequest("http://localhost:3000/", { headers: { cookie: "impex_tenant_session=abc" } }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});
