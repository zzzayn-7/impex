import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ORG_ID, orgAdmin, regularUser, stubAuthService, superAdmin } from "./helpers";

// A mutable cookie jar standing in for the incoming request's cookies.
const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined }),
}));

import OrganizationDashboard from "@/app/page";
import { config, middleware } from "@/middleware";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { getTenantAdmin, requireTenantAdmin } from "@/lib/tenant-session";

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  for (const key of Object.keys(jar)) delete jar[key];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const accountsByToken = () => {
  const stub = stubAuthService({});
  stub.issue("org-admin-token", { password: "", user: orgAdmin });
  stub.issue("super-admin-token", { password: "", user: superAdmin });
  stub.issue("user-token", { password: "", user: regularUser });
  stub.issue("inactive-admin-token", { password: "", user: { ...orgAdmin, is_active: false } });
  stub.issue("orphan-admin-token", { password: "", user: { ...orgAdmin, organization_id: null } });
  return stub;
};

describe("session cookie", () => {
  it("is named differently from the Super Admin cookie", () => {
    expect(TENANT_SESSION_COOKIE).toBe("impex_tenant_session");
    expect(TENANT_SESSION_COOKIE).not.toBe("impex_session");
  });
});

describe("requireTenantAdmin / getTenantAdmin", () => {
  it("redirects to /login without a session cookie, without calling the Auth Service", async () => {
    const { fetchMock } = accountsByToken();
    await expect(requireTenantAdmin()).rejects.toThrow("REDIRECT:/login");
    expect(await getTenantAdmin()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the administrator, with the organization taken from the Auth Service", async () => {
    accountsByToken();
    jar[TENANT_SESSION_COOKIE] = "org-admin-token";
    const admin = await requireTenantAdmin();
    expect(admin.full_name).toBe("Olivia Owner");
    expect(admin.organization_id).toBe(ORG_ID);
  });

  it("re-validates the account on every call, so a disabled account is locked out at once", async () => {
    const stub = accountsByToken();
    jar[TENANT_SESSION_COOKIE] = "org-admin-token";
    expect(await getTenantAdmin()).not.toBeNull();
    stub.issue("org-admin-token", { password: "", user: { ...orgAdmin, is_active: false } }); // disabled meanwhile
    expect(await getTenantAdmin()).toBeNull();
  });

  it.each([
    ["a Super Admin token in the tenant cookie", "super-admin-token"],
    ["a regular user token", "user-token"],
    ["an inactive administrator", "inactive-admin-token"],
    ["an administrator without an organization", "orphan-admin-token"],
    ["an unknown or expired token", "garbage"],
  ])("rejects %s", async (_label, token) => {
    accountsByToken();
    jar[TENANT_SESSION_COOKIE] = token;
    expect(await getTenantAdmin()).toBeNull();
    await expect(requireTenantAdmin()).rejects.toThrow("REDIRECT:/login");
  });

  it("ignores the Super Admin session cookie completely", async () => {
    const { fetchMock } = accountsByToken();
    jar["impex_session"] = "super-admin-token"; // the other portal's cookie, sent because both run on localhost
    expect(await getTenantAdmin()).toBeNull();
    await expect(requireTenantAdmin()).rejects.toThrow("REDIRECT:/login");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an unreachable Auth Service as not signed in", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    jar[TENANT_SESSION_COOKIE] = "org-admin-token";
    expect(await getTenantAdmin()).toBeNull();
  });
});

describe("middleware", () => {
  const request = (cookie?: string) =>
    new NextRequest("http://localhost:3001/", { headers: cookie ? { cookie } : {} });

  it("sends visitors without a tenant cookie to /login", () => {
    const res = middleware(request());
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("does not accept the Super Admin cookie", () => {
    const res = middleware(request("impex_session=super-admin-token"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("lets a request with a tenant cookie continue to the server-side check", () => {
    const res = middleware(request(`${TENANT_SESSION_COOKIE}=anything`));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("runs on protected pages but not on /login, /api or Next assets", () => {
    const matcher = new RegExp("^" + config.matcher[0] + "$");
    for (const path of ["/", "/anything", "/reports/2026"]) expect(matcher.test(path), path).toBe(true);
    for (const path of ["/login", "/login/", "/api/auth/login", "/api/auth/logout", "/_next/static/chunk.js", "/favicon.ico"]) {
      expect(matcher.test(path), path).toBe(false);
    }
  });
});

describe("placeholder dashboard page", () => {
  it("shows the administrator's name and organization id from the Auth Service", async () => {
    accountsByToken();
    jar[TENANT_SESSION_COOKIE] = "org-admin-token";
    const html = renderToStaticMarkup(await OrganizationDashboard());
    expect(html).toContain("Welcome, Olivia Owner");
    expect(html).toContain(ORG_ID);
    expect(html).toContain("Sign out");
    expect(html).not.toContain("org-admin-token"); // the session token is never rendered
  });

  it("redirects instead of rendering for anyone who is not an organization administrator", async () => {
    accountsByToken();
    for (const token of [undefined, "super-admin-token", "user-token"]) {
      if (token) jar[TENANT_SESSION_COOKIE] = token;
      else delete jar[TENANT_SESSION_COOKIE];
      await expect(OrganizationDashboard()).rejects.toThrow("REDIRECT:/login");
    }
  });
});
