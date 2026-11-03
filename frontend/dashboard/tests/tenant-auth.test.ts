import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchCurrentUser, isTenantAdmin, signInTenantAdmin } from "@/lib/tenant-auth";
import { ORG_ID, orgAdmin, regularUser, stubAuthService, standardAccounts, superAdmin } from "./helpers";

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isTenantAdmin: the one rule for who may enter the organization portal", () => {
  it("accepts an active organization-admin that belongs to an organization", () => {
    expect(isTenantAdmin(orgAdmin)).toBe(true);
  });

  it.each([
    ["inactive account", { ...orgAdmin, is_active: false }],
    ["no organization id", { ...orgAdmin, organization_id: null }],
    ["empty organization id", { ...orgAdmin, organization_id: "" }],
    ["organization id that is not a UUID", { ...orgAdmin, organization_id: "acme" }],
    ["a Super Admin without an organization", superAdmin],
    ["a Super Admin that also has an organization id", { ...superAdmin, organization_id: ORG_ID }],
    ["a regular user", regularUser],
    ["a regular user that also has an organization id", { ...regularUser, organization_id: ORG_ID }],
    ["role with different casing", { ...orgAdmin, role: "Organization-Admin" }],
    ["role with trailing space", { ...orgAdmin, role: "organization-admin " }],
    ["is_active as a string", { ...orgAdmin, is_active: "true" }],
    ["missing role", { ...orgAdmin, role: undefined }],
    ["null", null],
    ["undefined", undefined],
    ["a string", "organization-admin"],
  ])("rejects %s", (_label, user) => {
    expect(isTenantAdmin(user)).toBe(false);
  });
});

describe("fetchCurrentUser", () => {
  it("asks the Auth Service /me with the token in the Authorization header only", async () => {
    const { calls, issue } = stubAuthService({});
    issue("abc", { password: "", user: orgAdmin });
    const user = await fetchCurrentUser("abc");
    expect(user?.organization_id).toBe(ORG_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://auth-service:8000/api/v1/auth/me");
    expect(calls[0].headers.Authorization).toBe("Bearer abc");
    expect(calls[0].url).not.toContain("abc"); // never in the URL
  });

  it("returns null for an invalid or expired token", async () => {
    stubAuthService({});
    expect(await fetchCurrentUser("expired")).toBeNull();
  });

  it("returns null when the Auth Service is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await fetchCurrentUser("abc")).toBeNull();
  });
});

describe("signInTenantAdmin", () => {
  it("signs in an organization administrator and takes the organization from the Auth Service", async () => {
    const { calls } = stubAuthService(standardAccounts());
    const result = await signInTenantAdmin("owner@acme.example", "Str0ng!Passphrase");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.organization_id).toBe(ORG_ID);
      expect(result.expiresIn).toBe(3600);
      expect(result.token).toBe("token-for-owner@acme.example");
    }
    expect(calls.map((c) => c.url)).toEqual([
      "http://auth-service:8000/api/v1/auth/login",
      "http://auth-service:8000/api/v1/auth/me",
    ]);
    expect(calls[0].body).toEqual({ email: "owner@acme.example", password: "Str0ng!Passphrase" });
    expect(calls[1].headers.Authorization).toBe("Bearer token-for-owner@acme.example");
  });

  it.each([
    ["a Super Admin", "root@impex.example"],
    ["a regular user", "user@example.org"],
  ])("refuses %s even with the correct password, and returns no token", async (_label, email) => {
    stubAuthService(standardAccounts());
    const result = await signInTenantAdmin(email, "Str0ng!Passphrase");
    expect(result).toEqual({
      ok: false,
      status: 403,
      message: "This account does not have access to the organization portal.",
    });
    expect(JSON.stringify(result)).not.toContain("token-for");
  });

  it("refuses an organization admin that the Auth Service reports as inactive", async () => {
    stubAuthService({ "owner@acme.example": { password: "p", user: { ...orgAdmin, is_active: false } } });
    expect(await signInTenantAdmin("owner@acme.example", "p")).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses an organization admin without an organization", async () => {
    stubAuthService({ "owner@acme.example": { password: "p", user: { ...orgAdmin, organization_id: null } } });
    expect(await signInTenantAdmin("owner@acme.example", "p")).toMatchObject({ ok: false, status: 403 });
  });

  it("gives the same answer for an unknown email and a wrong password", async () => {
    stubAuthService(standardAccounts());
    const wrongPassword = await signInTenantAdmin("owner@acme.example", "wrong");
    const unknownEmail = await signInTenantAdmin("nobody@example.org", "whatever");
    expect(wrongPassword).toEqual({ ok: false, status: 401, message: "Invalid email or password." });
    expect(unknownEmail).toEqual(wrongPassword);
  });

  it("maps a disabled account (403 from the Auth Service) and malformed input (422)", async () => {
    stubAuthService({ "owner@acme.example": { password: "p", user: orgAdmin, loginStatus: 403 } });
    expect(await signInTenantAdmin("owner@acme.example", "p")).toMatchObject({ ok: false, status: 403, message: "This account is disabled." });
    stubAuthService({ "x@y.z": { password: "p", user: orgAdmin, loginStatus: 422 } });
    expect(await signInTenantAdmin("x@y.z", "p")).toMatchObject({ ok: false, status: 400 });
  });

  it("reports an unreachable Auth Service as 503 and never signs anyone in", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await signInTenantAdmin("owner@acme.example", "p")).toMatchObject({ ok: false, status: 503 });
  });

  it("does not sign in when /me cannot be verified", async () => {
    stubAuthService({ "owner@acme.example": { password: "p", user: orgAdmin, meStatus: 500 } });
    expect(await signInTenantAdmin("owner@acme.example", "p")).toMatchObject({ ok: false, status: 502 });
  });
});
