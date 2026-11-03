import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { stubAuthService, standardAccounts } from "./helpers";

const PASSWORD = "Str0ng!Passphrase";

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function loginRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3001/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const setCookie = (res: Response) => res.headers.get("set-cookie") ?? "";

describe("POST /api/auth/login", () => {
  it("rejects malformed or incomplete requests without calling the Auth Service", async () => {
    const { fetchMock } = stubAuthService(standardAccounts());
    expect((await login(loginRequest("{not json"))).status).toBe(400);
    expect((await login(loginRequest({}))).status).toBe(400);
    expect((await login(loginRequest({ email: "owner@acme.example" }))).status).toBe(400);
    expect((await login(loginRequest({ email: "  ", password: "x" }))).status).toBe(400);
    expect((await login(loginRequest({ email: 5, password: {} }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs in an organization administrator with a separate, HttpOnly session cookie", async () => {
    stubAuthService(standardAccounts());
    const res = await login(loginRequest({ email: "owner@acme.example", password: PASSWORD }));
    expect(res.status).toBe(200);

    const cookie = setCookie(res);
    expect(cookie).toMatch(/^impex_tenant_session=token-for-owner%40acme\.example;/); // "@" is percent-encoded in cookies
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=3600/);
    expect(cookie).not.toMatch(/Secure/i); // plain http://localhost in development
    expect(cookie).not.toMatch(/impex_session=/); // never the Super Admin cookie
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("never returns the token in the response body", async () => {
    stubAuthService(standardAccounts());
    const res = await login(loginRequest({ email: "owner@acme.example", password: PASSWORD }));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ user: { full_name: "Olivia Owner" } });
    expect(text).not.toContain("token-for");
  });

  it("marks the cookie Secure when the original request was HTTPS", async () => {
    stubAuthService(standardAccounts());
    const res = await login(loginRequest({ email: "owner@acme.example", password: PASSWORD }, { "x-forwarded-proto": "https" }));
    expect(setCookie(res)).toMatch(/Secure/i);
  });

  it("ignores an organization id (or role) supplied by the browser", async () => {
    const { calls } = stubAuthService(standardAccounts());
    const res = await login(
      loginRequest({
        email: "owner@acme.example",
        password: PASSWORD,
        organization_id: "00000000-0000-4000-8000-000000000000",
        organizationId: "00000000-0000-4000-8000-000000000000",
        role: "organization-admin",
      })
    );
    expect(res.status).toBe(200);
    expect(calls[0].body).toEqual({ email: "owner@acme.example", password: PASSWORD }); // nothing else is forwarded
    expect(await res.text()).not.toContain("00000000-0000");
  });

  it("does not let a browser-supplied organization id turn a non-admin into an admin", async () => {
    stubAuthService(standardAccounts());
    const res = await login(loginRequest({ email: "user@example.org", password: PASSWORD, organization_id: "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6", role: "organization-admin" }));
    expect(res.status).toBe(403);
    expect(setCookie(res)).toBe("");
  });

  it.each([
    ["a Super Admin", "root@impex.example"],
    ["a regular user", "user@example.org"],
  ])("refuses %s with the correct password and sets no cookie", async (_label, email) => {
    stubAuthService(standardAccounts());
    const res = await login(loginRequest({ email, password: PASSWORD }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("This account does not have access to the organization portal.");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers 401 without a cookie for a wrong password", async () => {
    stubAuthService(standardAccounts());
    const res = await login(loginRequest({ email: "owner@acme.example", password: "wrong" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers 503 without a cookie when the Auth Service is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const res = await login(loginRequest({ email: "owner@acme.example", password: PASSWORD }));
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /api/auth/logout", () => {
  it("expires only the tenant session cookie", async () => {
    const res = await logout(new NextRequest("http://localhost:3001/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(200);
    const cookie = setCookie(res);
    expect(cookie).toMatch(/^impex_tenant_session=;/);
    expect(cookie).toMatch(/Max-Age=0/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).not.toMatch(/impex_session=/); // the Super Admin cookie is not touched
  });

  it("works without any session (idempotent)", async () => {
    const first = await logout(new NextRequest("http://localhost:3001/api/auth/logout", { method: "POST" }));
    const second = await logout(new NextRequest("http://localhost:3001/api/auth/logout", { method: "POST" }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
