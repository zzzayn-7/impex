import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as complete } from "@/app/api/activate/complete/route";

const TOKEN = "A".repeat(43);

function activationRequest() {
  return new NextRequest("http://localhost:3000/api/activate/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, fullName: "Olivia Owner", password: "Str0ng!Passphrase", confirmPassword: "Str0ng!Passphrase" }),
  });
}

beforeEach(() => {
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  process.env.ORG_ACTIVATION_API_KEY = "test-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ organization_name: "Acme Imports", email: "owner@acme.example" }), { status: 201 }))
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TENANT_PORTAL_URL;
});

describe("successful activation points to the organization login page", () => {
  it("defaults to the organization portal on port 3001", async () => {
    const res = await complete(activationRequest());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      organizationName: "Acme Imports",
      email: "owner@acme.example",
      loginUrl: "http://localhost:3001/login",
    });
  });

  it("uses TENANT_PORTAL_URL when configured (trailing slash tolerated)", async () => {
    process.env.TENANT_PORTAL_URL = "https://portal.impex.example/";
    const res = await complete(activationRequest());
    expect((await res.json()).loginUrl).toBe("https://portal.impex.example/login");
  });

  it("does not return the link when activation fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { code: "used", message: "This invitation has already been used." } }), { status: 410 })));
    const res = await complete(activationRequest());
    expect(res.status).toBe(410);
    expect(JSON.stringify(await res.json())).not.toContain("loginUrl");
  });
});
