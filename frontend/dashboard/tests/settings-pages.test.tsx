import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { alphaOrg, betaOrg, orgAdmin, orgAdminB } from "./helpers";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import DashboardLayout from "@/app/(dashboard)/layout";
import DashboardPage from "@/app/(dashboard)/page";

// The dashboard is its layout (session, setup gate, frame) around its page (the data): rendered together, as a visitor gets them.
const OrganizationDashboard = async () => DashboardLayout({ children: await DashboardPage() });
import SettingsLayout from "@/app/settings/layout";
import SettingsPage from "@/app/settings/page";
import NewTicketPage from "@/app/support/new/page";
import PortalHeader from "@/components/portal-header";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-07T10:00:00+00:00";

const settingsOf = (over: Record<string, any> = {}) => ({
  version: 3, setup_status: "completed", updated_at: now,
  company: { name: "Alpha Trading GmbH", contact_email: "ops@alpha.example", contact_phone: "+49 30 1234567", address_street: "12 Harbour Road", address_city: "Hamburg", address_state: "HH", address_postal_code: "20095", website: "https://alpha.example", description: "We import machine parts." },
  restricted: { id: alphaOrg.id, slug: "alpha-trading", country_code: "DE", tax_identifier: "DE111111111", owner_email: "owner@alpha.example", status: "Active", created_at: "2026-11-01T10:00:00+00:00" },
  branding: { has_logo: true, logo_version: "1730000000000" },
  preferences: { default_currency: "EUR", timezone: "Europe/London", date_format: "DD/MM/YYYY", number_format: "dot_comma" },
  ...over,
});
const historyOf = () => ({ total: 2, items: [
  { id: "h1", section: "company", field: "name", old_value: "Alpha Trading", new_value: "Alpha Trading GmbH", changed_by_name: "Olivia Owner", changed_by_email: "owner@acme.example", source: "settings", version: 3, batch_id: "b2", created_at: "2026-11-05T22:30:00+00:00" },
  { id: "h2", section: "branding", field: "logo", old_value: "none", new_value: "added", changed_by_name: "Olivia Owner", changed_by_email: "owner@acme.example", source: "settings", version: 2, batch_id: "b1", created_at: "2026-11-04T08:00:00+00:00" },
] });

let calls: string[] = [];
type Options = { settings?: any; settingsStatus?: number; settingsBody?: any; modules?: string[] | undefined; org?: Record<string, unknown> };
function backend(options: Options = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push(url);
    const token = (init.headers?.Authorization ?? "").replace("Bearer ", "");
    const user = token === "token-alpha" ? orgAdmin : token === "token-beta" ? orgAdminB : null;
    if (url.endsWith("/api/v1/auth/me")) return user ? json(200, user) : json(401, {});
    if (!user) return json(401, {});
    const beta = token === "token-beta";
    if (url.endsWith("/api/v1/tenant/organization")) {
      const base = beta ? betaOrg : alphaOrg;
      return json(200, { ...base, ...(options.modules !== undefined ? { modules: options.modules } : {}), default_currency: "EUR", timezone: "Europe/London", date_format: "DD/MM/YYYY", number_format: "dot_comma", ...(options.org ?? {}) });
    }
    if (url.endsWith("/api/v1/tenant/settings")) {
      if (options.settingsStatus) return json(options.settingsStatus, options.settingsBody ?? { detail: "x" });
      return json(200, options.settings ?? (beta ? settingsOf({ company: { ...settingsOf().company, name: "Beta Logistics SARL", contact_email: "ops@beta.example" }, restricted: { ...settingsOf().restricted, id: betaOrg.id, slug: "beta-logistics", country_code: "FR" }, version: 1 }) : settingsOf()));
    }
    if (url.includes("/api/v1/tenant/settings/history")) return json(200, beta ? { items: [], total: 0 } : historyOf());
    return json(404, {});
  }));
}
const render = async (element: Promise<any>) => renderToStaticMarkup(await element);

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  for (const key of Object.keys(jar)) delete jar[key];
  jar[TENANT_SESSION_COOKIE] = "token-alpha";
});
afterEach(() => vi.unstubAllGlobals());

describe("the Settings page shows what the services hold, in five sections", () => {
  it("has the five sections, each filled from the organization's own records", async () => {
    backend({ modules: ["inventory", "sales"] });
    const html = await render(SettingsPage());
    for (const heading of ["Company profile", "Company branding", "Administrator profile", "Business preferences", "Enabled modules"]) expect(html, heading).toContain(heading);
    // company: every value comes from the service answer
    for (const value of ["Alpha Trading GmbH", "ops@alpha.example", "+49 30 1234567", "12 Harbour Road", "Hamburg", "HH", "20095", "https://alpha.example", "We import machine parts."]) expect(html, value).toContain(value);
    // preferences: the saved choices are the selected options
    expect(html).toMatch(/<option value="EUR" selected/);
    expect(html).toMatch(/<option value="Europe\/London" selected/);
    expect(html).toMatch(/<option value="DD\/MM\/YYYY" selected/);
    expect(html).toMatch(/<option value="dot_comma" selected/);
    // administrator: the account comes from the Auth Service
    for (const value of ["Olivia Owner", "owner@acme.example", "Organization administrator", orgAdmin.id, orgAdmin.organization_id]) expect(html, value).toContain(value);
  });

  it("shows the restricted facts read-only, each with a Request change link to Help & Support", async () => {
    backend();
    const html = await render(SettingsPage());
    for (const value of [alphaOrg.id, "alpha-trading", "DE", "DE111111111", "owner@alpha.example", "Active"]) expect(html, value).toContain(value);
    for (const key of ["slug", "country", "tax_id", "ownership", "status"]) expect(html).toContain(`href="/support/new?change=${key}"`);
    expect(html).not.toMatch(/<input[^>]*value="alpha-trading"/); // not editable
    expect(html).not.toMatch(/<input[^>]*value="DE111111111"/);
    expect(html).not.toMatch(/<input[^>]*value="owner@acme\.example"/); // the administrator's e-mail is not an input either
  });

  it("lists the modules: enabled, not enabled with Request access (Finance included), and the dependencies", async () => {
    backend({ modules: ["inventory", "sales"] });
    const html = await render(SettingsPage());
    expect(html).toMatch(/data-module="inventory" data-enabled="true"/);
    expect(html).toMatch(/data-module="sales" data-enabled="true"/);
    expect(html).toMatch(/data-module="purchasing" data-enabled="false"/);
    expect(html).toContain('href="/support/new?module=purchasing"'); // Request access: only opens a ticket
    expect(html).not.toContain('href="/support/new?module=sales"');
    expect(html).not.toContain('href="/support/new?module=inventory"');
    expect(html).not.toContain("Planned: not available yet"); // Finance is released now: a module like the others
    expect(html).toMatch(/data-module="finance" data-enabled="false"/);
    expect(html).toContain('href="/support/new?module=finance"'); // Request access: only opens a ticket, it enables nothing
    expect(html).toContain("Includes: Financial Overview, Accounts, Expenses, Journal Entries");
    expect(html).toContain("Purchasing and Sales both need Inventory");
    for (const permanent of ["Authentication", "Organization Management", "Onboarding", "Help &amp; Support"]) expect(html).toContain(permanent);
    expect(html).not.toMatch(/<input[^>]*type="checkbox"/); // nothing here can switch a module on
    expect(html).not.toMatch(/<button[^>]*>[^<]*(Enable|Disable)/);
  });

  it("stays open when every business module is disabled (and says so)", async () => {
    backend({ modules: [] });
    const html = await render(SettingsPage());
    expect(html).toContain("Company profile");
    expect(html).toMatch(/data-module="inventory" data-enabled="false"/);
    expect(html).toContain('href="/support/new?module=inventory"');
    expect(await render(SettingsLayout({ children: "SETTINGS-CONTENT" }))).toContain("SETTINGS-CONTENT");
  });

  it("an unknown module list (an outage) is shown as no module enabled, never as all", async () => {
    backend({ modules: undefined, org: { modules: "all" } });
    const html = await render(SettingsPage());
    expect(html).not.toMatch(/data-enabled="true"/);
  });

  it("the history is shown with who changed what and when, in the organization's own format", async () => {
    backend();
    const html = await render(SettingsPage());
    expect(html).toContain("Recent changes");
    expect(html).toContain("Company display name");
    expect(html).toContain("Alpha Trading → <span");
    expect(html).toContain("Alpha Trading GmbH</span>");
    expect(html).toContain("Logo added");
    expect(html).toContain("Olivia Owner");
    expect(html).toContain("05/11/2026 22:30"); // DD/MM/YYYY in Europe/London
  });

  it("nothing is hardcoded: two organizations see their own values only", async () => {
    backend();
    const alpha = await render(SettingsPage());
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const beta = await render(SettingsPage());
    expect(alpha).toContain("Alpha Trading GmbH");
    expect(alpha).not.toContain("Beta Logistics");
    expect(beta).toContain("Beta Logistics SARL");
    expect(beta).toContain("ops@beta.example");
    expect(beta).not.toContain("Alpha Trading");
    expect(beta).toContain("beta-logistics");
    expect(beta).toContain("No changes yet.");
  });

  it("asks the services for the signed-in session's data only (no organization or user id in any address)", async () => {
    backend();
    await render(SettingsPage());
    expect(calls.every((u) => !/organization_id|user_id|[?&]org=/.test(u))).toBe(true);
    expect(calls.filter((u) => u.includes("/tenant/settings")).length).toBe(2);
  });

  it("explains setup not finished (sends to /setup), an expired session, an inactive organization and an outage", async () => {
    backend({ settingsStatus: 403, settingsBody: { detail: { code: "setup_required", message: "x" } } });
    await expect(render(SettingsPage())).rejects.toThrow("REDIRECT:/setup");
    backend({ settingsStatus: 401 });
    await expect(render(SettingsPage())).rejects.toThrow("REDIRECT:/login");
    backend({ settingsStatus: 403, settingsBody: { detail: "Your organization is not active." } });
    expect(await render(SettingsPage())).toContain("currently inactive or unavailable");
    backend({ settingsStatus: 503 });
    expect(await render(SettingsPage())).toContain("Nothing was lost");
    delete jar[TENANT_SESSION_COOKIE];
    await expect(render(SettingsPage())).rejects.toThrow("REDIRECT:/login");
  });
});

describe("Settings in the portal", () => {
  it("is in the menu (marked current on its page), without recolouring or moving anything else", () => {
    const html = renderToStaticMarkup(<PortalHeader admin={orgAdmin as any} current="settings" organization={{ name: "Acme", modules: [] }} />);
    expect(html).toMatch(/<a[^>]*href="\/settings"[^>]*>Settings<\/a>/);
    expect(html).toMatch(/aria-current="page"[^>]*>Settings</);
    expect(html).toContain('href="/support"');
    expect(html).toContain("bg-slate-900/60"); // the header keeps its own theme: the ivory palette is scoped to the Settings content
  });

  it("the Settings content carries the scoped ivory theme", async () => {
    backend();
    const html = await render(SettingsPage());
    for (const color of ["#EEEDE8", "#426B58", "#1B211D", "#777F79", "#E4E8E2", "#658675"]) expect(html.toLowerCase()).toContain(color.toLowerCase());
    expect(html).toContain("bg-white"); // the cards are pure white (#FFFFFF)
  });

  it("the layout redirects an administrator whose setup is not finished, and an invalid session", async () => {
    backend({ org: { setup_status: "pending" } });
    await expect(render(SettingsLayout({ children: "X" }))).rejects.toThrow("REDIRECT:/setup");
    delete jar[TENANT_SESSION_COOKIE];
    await expect(render(SettingsLayout({ children: "X" }))).rejects.toThrow("REDIRECT:/login");
  });
});

describe("Request change and Request access open a prefilled Change Request in Help & Support", () => {
  const form = async (search: Record<string, string>) => renderToStaticMarkup(await NewTicketPage({ searchParams: search }));
  beforeEach(() => backend());

  it.each([["slug", "organization identifier (slug)"], ["country", "registered country or jurisdiction"], ["tax_id", "tax registration number"], ["ownership", "organization ownership"], ["status", "organization status"], ["other", "company information"]])("?change=%s", async (key, label) => {
    const html = await form({ change: key });
    expect(html).toContain(`value="Request to change our ${label}"`);
    expect(html).toMatch(/<option value="change_request" selected/);
    expect(html).toContain(`We would like to change our ${label}.`);
  });

  it("nothing in the address is ever used as text", async () => {
    for (const bad of ["<script>alert(1)</script>", "tax_id; DROP", "", "SLUG"]) expect(await form({ change: bad }), bad).not.toContain("Request to change");
    expect(await form({ change: "<img src=x onerror=alert(1)>" })).not.toContain("onerror=alert(1)");
  });
});

describe("the dashboard follows the organization's date format", () => {
  it("writes the registration date with its own format and time zone", async () => {
    backend({ modules: ["inventory"], org: { created_at: "2026-11-01T23:30:00+00:00", date_format: "DD/MM/YYYY", timezone: "Asia/Karachi" } });
    expect(renderToStaticMarkup(await OrganizationDashboard())).toContain("02/11/2026"); // 23:30 UTC is already 2 November in Karachi
    backend({ modules: ["inventory"], org: { created_at: "2026-11-01T23:30:00+00:00", date_format: "MM/DD/YYYY", timezone: "America/New_York" } });
    expect(renderToStaticMarkup(await OrganizationDashboard())).toContain("11/01/2026");
    backend({ modules: ["inventory"], org: { created_at: "2026-11-01T23:30:00+00:00", date_format: undefined, timezone: undefined } });
    expect(renderToStaticMarkup(await OrganizationDashboard())).toContain("2026-11-01"); // missing preferences: the defaults the portal always used
  });
});
