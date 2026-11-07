import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ORG_B_ID, ORG_ID, alphaOrg, betaOrg, orgAdmin, orgAdminB, stubBackend, superAdmin } from "./helpers";

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

import DashboardLayout from "@/app/(dashboard)/layout";
import DashboardPage from "@/app/(dashboard)/page";

// The dashboard is its layout (session, setup gate, frame) around its page (the data): rendered together, as a visitor gets them.
const OrganizationDashboard = async () => DashboardLayout({ children: await DashboardPage() });
import { fetchTenantOrganization } from "@/lib/organization";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const ORG_ENDPOINT = "http://organization-service:8001/api/v1/tenant/organization";

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  for (const key of Object.keys(jar)) delete jar[key];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const twoOrganizations = () =>
  stubBackend({
    "token-alpha": { user: orgAdmin, organization: { status: 200, body: alphaOrg } },
    "token-beta": { user: orgAdminB, organization: { status: 200, body: betaOrg } },
    "token-super": { user: superAdmin, organization: { status: 403, body: { detail: "nope" } } },
  });

const render = async () => renderToStaticMarkup(await OrganizationDashboard());

describe("fetchTenantOrganization", () => {
  it("sends only the Bearer token: no organization id in the URL, query, body or extra headers", async () => {
    const { organizationCalls } = twoOrganizations();
    const result = await fetchTenantOrganization("token-alpha");
    expect(result).toEqual({ ok: true, organization: alphaOrg });

    const [call] = organizationCalls();
    expect(call.url).toBe(ORG_ENDPOINT); // no path segment, no "?query"
    expect(call.method).toBe("GET");
    expect(call.body).toBeUndefined();
    expect(Object.keys(call.headers)).toEqual(["Authorization"]);
    expect(call.headers.Authorization).toBe("Bearer token-alpha");
    expect(call.url).not.toContain(ORG_ID);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [503, "unavailable"],
    [500, "unavailable"],
  ])("maps a %i answer to '%s'", async (status, reason) => {
    stubBackend({ t: { user: orgAdmin, organization: { status, body: {} } } });
    expect(await fetchTenantOrganization("t")).toEqual({ ok: false, reason });
  });

  it("treats an unreachable Organization Service as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await fetchTenantOrganization("t")).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("the dashboard page", () => {
  it("shows the real organization name and details, not just the id", async () => {
    twoOrganizations();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render();
    for (const expected of ["Alpha Trading GmbH", "alpha-trading", "DE", "DE111111111", "ops@alpha.example", "2026-11-01", ORG_ID, "Welcome, Olivia Owner", "Active"]) {
      expect(html, expected).toContain(expected);
    }
  });

  it("takes no parameters, so nothing from the browser can choose the organization", () => {
    expect(OrganizationDashboard.length).toBe(0);
  });

  it("calls the Organization Service with the tenant session token and nothing that names an organization", async () => {
    const { organizationCalls } = twoOrganizations();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await render();
    const calls = organizationCalls();
    expect(calls).toHaveLength(2); // the frame (layout) asks once for setup and identity, the page once for its figures
    for (const call of calls) {
      expect(call.url).toBe(ORG_ENDPOINT); // no query string, no organization id: the service derives the organization from the token
      expect(call.headers.Authorization).toBe("Bearer token-alpha");
    }
  });

  it("two organizations, two administrators: each page contains only its own organization's data", async () => {
    twoOrganizations();

    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const alphaHtml = await render();
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const betaHtml = await render();

    expect(alphaHtml).toContain("Alpha Trading GmbH");
    expect(betaHtml).toContain("Beta Logistics SARL");
    for (const leak of ["Beta Logistics", "beta-logistics", "ops@beta.example", "FR222222222", ORG_B_ID, "Bruno Beta"]) {
      expect(alphaHtml, `alpha page leaked: ${leak}`).not.toContain(leak);
    }
    for (const leak of ["Alpha Trading", "alpha-trading", "ops@alpha.example", "DE111111111", ORG_ID, "Olivia Owner"]) {
      expect(betaHtml, `beta page leaked: ${leak}`).not.toContain(leak);
    }
  });

  it("never renders the session token", async () => {
    twoOrganizations();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render()).not.toContain("token-alpha");
  });

  it("explains an inactive or unavailable organization (403) without showing any organization data", async () => {
    stubBackend({ t: { user: orgAdmin, organization: { status: 403, body: { detail: "Your organization is not active." } } } });
    jar[TENANT_SESSION_COOKIE] = "t";
    const html = await render();
    expect(html).toContain("currently inactive or unavailable");
    expect(html).toContain("Welcome, Olivia Owner");
    expect(html).toContain(ORG_ID); // the id comes from the Auth Service record
    expect(html).not.toContain("Alpha Trading");
  });

  it("shows a temporary-unavailable notice when the Organization Service is down (503)", async () => {
    stubBackend({ t: { user: orgAdmin, organization: { status: 503, body: {} } } });
    jar[TENANT_SESSION_COOKIE] = "t";
    const html = await render();
    expect(html).toContain("temporarily unavailable");
    expect(html).toContain("Welcome, Olivia Owner");
  });

  it("sends the user back to /login if the Organization Service says the session is no longer valid (401)", async () => {
    stubBackend({ t: { user: orgAdmin, organization: { status: 401, body: {} } } });
    jar[TENANT_SESSION_COOKIE] = "t";
    await expect(OrganizationDashboard()).rejects.toThrow("REDIRECT:/login");
  });

  it("never asks the Organization Service on behalf of a Super Admin", async () => {
    const { organizationCalls } = twoOrganizations();
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(OrganizationDashboard()).rejects.toThrow("REDIRECT:/login");
    expect(organizationCalls()).toHaveLength(0);
  });

  it("ignores the Super Admin portal's cookie", async () => {
    const { fetchMock } = twoOrganizations();
    jar["impex_session"] = "token-alpha";
    await expect(OrganizationDashboard()).rejects.toThrow("REDIRECT:/login");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
