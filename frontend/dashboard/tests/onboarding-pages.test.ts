import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { alphaOrg, betaOrg, orgAdmin, orgAdminB, superAdmin } from "./helpers";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import OrganizationDashboard from "@/app/page";
import SetupPage from "@/app/setup/page";
import SetupLayout from "@/app/setup/layout";
import ProductsLayout from "@/app/products/layout";
import InvoicesLayout from "@/app/invoices/layout";
import PortalFrame from "@/components/portal-frame";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const DONE = "2026-11-03T00:05:00+00:00";

type Entry = { user: Record<string, unknown>; org: { status: number; body?: unknown } };
let calls: string[] = [];
function stubWorld(entries: Record<string, Entry>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push(url);
    const entry = entries[((init.headers ?? {}).Authorization ?? "").replace("Bearer ", "")];
    if (url.endsWith("/api/v1/auth/me")) return entry ? json(200, entry.user) : json(401, {});
    if (url.endsWith("/api/v1/tenant/organization")) return entry ? json(entry.org.status, entry.org.body ?? {}) : json(401, {});
    return json(404, {});
  }));
}
const render = async (element: Promise<any>) => renderToStaticMarkup(await element);

// the four states an administrator can be in
const state = (name: "ready" | "no-company" | "half-company" | "no-profile", over: { org?: any; user?: any } = {}): Entry => ({
  user: { ...orgAdmin, profile_setup_completed_at: name === "no-profile" || name === "no-company" ? null : DONE, ...over.user },
  org: {
    status: 200,
    body: { ...alphaOrg, setup_status: name === "no-company" ? "pending" : name === "half-company" ? "in_progress" : "completed", ...over.org },
  },
});

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  for (const key of Object.keys(jar)) delete jar[key];
  jar[TENANT_SESSION_COOKIE] = "t";
});
afterEach(() => vi.unstubAllGlobals());

// =====================================================================================================
// the dashboard
// =====================================================================================================
describe("the dashboard waits for setup", () => {
  it.each(["no-company", "half-company", "no-profile"] as const)("%s: redirects to /setup before showing anything", async (name) => {
    stubWorld({ t: state(name) });
    await expect(render(OrganizationDashboard())).rejects.toThrow("REDIRECT:/setup");
  });
  it("everything set up: the dashboard is shown", async () => {
    stubWorld({ t: state("ready") });
    expect(await render(OrganizationDashboard())).toContain("Welcome, Olivia Owner");
  });
  it("a missing record fails closed (it is not read as 'done')", async () => {
    const { profile_setup_completed_at: _drop, ...bare } = orgAdmin;
    stubWorld({ t: { user: bare, org: { status: 200, body: alphaOrg } } });
    await expect(render(OrganizationDashboard())).rejects.toThrow("REDIRECT:/setup");
    stubWorld({ t: { user: orgAdmin, org: { status: 200, body: { id: alphaOrg.id, name: "x" } } } });
    await expect(render(OrganizationDashboard())).rejects.toThrow("REDIRECT:/setup");
  });
  it("shows the configured company identity: its name in the header, its logo when it has one, a monogram when not", async () => {
    stubWorld({ t: state("ready", { org: { has_logo: true, logo_version: "1730000000000" } }) });
    const withLogo = await render(OrganizationDashboard());
    expect(withLogo).toContain('src="/api/organization/logo?v=1730000000000"');
    expect(withLogo).toContain("Alpha Trading GmbH logo");
    expect(withLogo).toContain("Admin Portal"); // the small line under the company name
    stubWorld({ t: state("ready") });
    const monogram = await render(OrganizationDashboard());
    expect(monogram).not.toContain("/api/organization/logo");
    expect(monogram).toContain(">AT<");
  });
  it("shows the administrator's own (updated) name in the header", async () => {
    stubWorld({ t: state("ready", { user: { full_name: "Ada Lovelace" } }) });
    const html = await render(OrganizationDashboard());
    expect(html).toContain("Ada Lovelace");
    expect(html).not.toContain("Olivia Owner");
  });
  it("two organizations: each header carries only its own company", async () => {
    stubWorld({
      a: { user: orgAdmin, org: { status: 200, body: { ...alphaOrg, has_logo: true, logo_version: "1" } } },
      b: { user: orgAdminB, org: { status: 200, body: betaOrg } },
    });
    jar[TENANT_SESSION_COOKIE] = "a";
    const a = await render(OrganizationDashboard());
    jar[TENANT_SESSION_COOKIE] = "b";
    const b = await render(OrganizationDashboard());
    expect(a).toContain("Alpha Trading GmbH");
    expect(a).not.toContain("Beta Logistics");
    expect(b).toContain("Beta Logistics SARL");
    expect(b).not.toContain("Alpha Trading");
    expect(b).not.toContain("/api/organization/logo");
  });
  it("an inactive organization is explained, not sent to setup (so there is no loop)", async () => {
    stubWorld({ t: { user: orgAdmin, org: { status: 403, body: { detail: "inactive" } } } });
    expect(await render(OrganizationDashboard())).toContain("currently inactive or unavailable");
  });
  it("when the Organization Service is down it says so; setup is never assumed complete and nothing is hidden by a redirect loop", async () => {
    stubWorld({ t: { user: orgAdmin, org: { status: 503, body: {} } } });
    expect(await render(OrganizationDashboard())).toContain("temporarily unavailable");
  });
  it("a disabled administrator, a Super Admin and a signed-out visitor go to the login page", async () => {
    stubWorld({ t: { user: { ...orgAdmin, is_active: false }, org: { status: 200, body: alphaOrg } }, s: { user: superAdmin, org: { status: 403, body: {} } } });
    await expect(render(OrganizationDashboard())).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "s";
    await expect(render(OrganizationDashboard())).rejects.toThrow("REDIRECT:/login");
    delete jar[TENANT_SESSION_COOKIE];
    await expect(render(OrganizationDashboard())).rejects.toThrow("REDIRECT:/login");
  });
  it("an expired session while asking about the company goes to the login page", async () => {
    stubWorld({ t: { user: orgAdmin, org: { status: 401, body: {} } } });
    await expect(render(OrganizationDashboard())).rejects.toThrow("REDIRECT:/login");
  });
});

// =====================================================================================================
// every other page (manual navigation before completion)
// =====================================================================================================
const LAYOUTS = ["clients", "delivery-lists", "dispatches", "goods-receipts", "invoices", "movements", "products", "purchase-orders", "scan", "stock", "suppliers", "warehouses"];

describe("typing a page's address cannot skip the wizard", () => {
  it.each(LAYOUTS)("%s: an incomplete setup is redirected to /setup", async (name) => {
    const layout = (await import(/* @vite-ignore */ `@/app/${name}/layout`)).default;
    for (const incomplete of ["no-company", "half-company", "no-profile"] as const) {
      stubWorld({ t: state(incomplete) });
      await expect(render(layout({ children: "PAGE-CONTENT" }))).rejects.toThrow("REDIRECT:/setup");
    }
    stubWorld({ t: state("ready") });
    expect(await render(layout({ children: "PAGE-CONTENT" }))).toContain("PAGE-CONTENT");
  });

  it("every page layout goes through the gate (this fails if a new layout skips it)", () => {
    const root = join(process.cwd(), "src", "app");
    const layouts = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(root, d.name, "layout.tsx"))).map((d) => d.name);
    // "setup" is the wizard itself; "support" deliberately does NOT redirect (a new administrator with an onboarding problem must be able to
    // ask for help): it is covered by its own tests below, but it still checks the session and loads the workspace.
    expect(layouts.sort()).toEqual([...LAYOUTS, "setup", "support"].sort());
    for (const name of layouts.filter((n) => n !== "setup")) {
      const source = readFileSync(join(root, name, "layout.tsx"), "utf-8");
      expect(/PortalFrame|loadWorkspace/.test(source), `${name}/layout.tsx must use PortalFrame or loadWorkspace`).toBe(true);
    }
  });

  it("when the Organization Service is down the page is replaced by a recoverable error with Sign out still there", async () => {
    stubWorld({ t: { user: orgAdmin, org: { status: 503, body: {} } } });
    for (const layout of [InvoicesLayout, ProductsLayout]) {
      const html = await render(layout({ children: "PAGE-CONTENT" }));
      expect(html).not.toContain("PAGE-CONTENT");
      expect(html).toContain("We couldn&#x27;t load your workspace just now");
      expect(html).toContain("Sign out");
    }
  });

  it("an inactive organization still shows the page, which explains it itself (today's behaviour)", async () => {
    stubWorld({ t: { user: orgAdmin, org: { status: 403, body: {} } } });
    expect(await render(PortalFrame({ current: "stock", children: "PAGE-CONTENT" }))).toContain("PAGE-CONTENT");
  });

  it("the header carries the company logo and name on every page", async () => {
    stubWorld({ t: state("ready", { org: { has_logo: true, logo_version: "9" } }) });
    const html = await render(InvoicesLayout({ children: "PAGE-CONTENT" }));
    expect(html).toContain('src="/api/organization/logo?v=9"');
    expect(html).toContain("Alpha Trading GmbH");
  });

  it("an expired session redirects to login; a Super Admin never gets in", async () => {
    stubWorld({ t: { user: orgAdmin, org: { status: 401, body: {} } }, s: { user: superAdmin, org: { status: 403, body: {} } } });
    await expect(render(InvoicesLayout({ children: "x" }))).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "s";
    await expect(render(InvoicesLayout({ children: "x" }))).rejects.toThrow("REDIRECT:/login");
  });
});

// =====================================================================================================
// /setup
// =====================================================================================================
describe("the /setup page", () => {
  it("everything already set up: straight to the dashboard", async () => {
    stubWorld({ t: state("ready") });
    await expect(render(SetupPage())).rejects.toThrow("REDIRECT:/");
  });

  it("a new company: the full wizard, prefilled from the Organization Service and the Auth Service", async () => {
    stubWorld({ t: state("no-company") });
    const html = await render(SetupPage());
    for (const expected of ["Welcome to Impex", "Let&#x27;s personalize your company workspace before you get started.", "Company logo", "Company name", 'value="Alpha Trading GmbH"', "Setup progress"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).not.toContain("Tell us about yourself");
  });

  it("resumes at the second step when the company part was already saved (an interrupted setup)", async () => {
    stubWorld({ t: state("half-company", { org: { has_logo: true, logo_version: "5" } }) });
    const html = await render(SetupPage());
    expect(html).toContain("Tell us about yourself");
    expect(html).toContain('value="Olivia Owner"');
    expect(html).toContain('aria-current="step"');
  });

  it("a half-saved company without a logo starts again at the first step", async () => {
    stubWorld({ t: state("half-company", { org: { has_logo: false } }) });
    expect(await render(SetupPage())).toContain("Welcome to Impex");
  });

  it("a new administrator of an already configured company sees only the short profile screen", async () => {
    stubWorld({ t: state("no-profile", { org: { has_logo: true, logo_version: "5" } }) });
    const html = await render(SetupPage());
    expect(html).toContain("Welcome, let&#x27;s confirm your name");
    expect(html).toContain("You are joining");
    expect(html).toContain("Alpha Trading GmbH");
    expect(html).toContain("Continue to Dashboard");
    expect(html).not.toContain("Choose a logo file");
    expect(html).not.toContain("Drag and drop");
    expect(html).not.toContain("Welcome to Impex");
  });

  it("sign out is available on every setup screen, and the page is not inside the portal navigation", async () => {
    stubWorld({ t: state("no-company") });
    const layout = renderToStaticMarkup(SetupLayout({ children: "SETUP-CONTENT" }));
    expect(layout).toContain("Sign out");
    expect(layout).toContain("SETUP-CONTENT");
    expect(layout).not.toContain("Products");
    expect(layout).toContain("#EEEDE8");
  });

  it("when the Organization Service is down: a recoverable error, no wizard, setup not assumed complete", async () => {
    stubWorld({ t: { user: orgAdmin, org: { status: 503, body: {} } } });
    const html = await render(SetupPage());
    expect(html).toContain("couldn&#x27;t load your setup");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Welcome to Impex");
  });

  it("an inactive organization is not stranded here: back to the page that explains it", async () => {
    stubWorld({ t: { user: orgAdmin, org: { status: 403, body: {} } } });
    await expect(render(SetupPage())).rejects.toThrow("REDIRECT:/");
  });

  it("is only for signed-in organization administrators", async () => {
    stubWorld({ t: { user: { ...orgAdmin, is_active: false }, org: { status: 200, body: alphaOrg } }, s: { user: superAdmin, org: { status: 403, body: {} } } });
    await expect(render(SetupPage())).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "s";
    await expect(render(SetupPage())).rejects.toThrow("REDIRECT:/login");
    delete jar[TENANT_SESSION_COOKIE];
    await expect(render(SetupPage())).rejects.toThrow("REDIRECT:/login");
  });

  it("two administrators of two companies each see only their own company in the wizard", async () => {
    stubWorld({
      a: { user: orgAdmin, org: { status: 200, body: { ...alphaOrg, setup_status: "pending" } } },
      b: { user: { ...orgAdminB, profile_setup_completed_at: null }, org: { status: 200, body: { ...betaOrg, setup_status: "pending" } } },
    });
    jar[TENANT_SESSION_COOKIE] = "a";
    const a = await render(SetupPage());
    jar[TENANT_SESSION_COOKIE] = "b";
    const b = await render(SetupPage());
    expect(a).toContain("Alpha Trading GmbH");
    expect(a).not.toContain("Beta Logistics");
    expect(b).toContain("Beta Logistics SARL");
    expect(b).not.toContain("Alpha Trading");
  });

  it("never renders the session token", async () => {
    stubWorld({ t: state("no-company") });
    expect(await render(SetupPage())).not.toContain('"t"');
  });
});

// =====================================================================================================
// no redirect loops
// =====================================================================================================
describe("the dashboard and /setup never send an administrator back and forth", () => {
  const where = async (fn: () => Promise<any>) => {
    try {
      await render(fn());
      return "page";
    } catch (e: any) {
      return String(e.message).replace("REDIRECT:", "");
    }
  };
  it.each([
    ["no-company", "/setup", "page"],
    ["half-company", "/setup", "page"],
    ["no-profile", "/setup", "page"],
    ["ready", "page", "/"],
  ] as const)("%s: dashboard -> %s, /setup -> %s", async (name, dashboard, setup) => {
    stubWorld({ t: state(name) });
    expect(await where(OrganizationDashboard)).toBe(dashboard);
    expect(await where(SetupPage)).toBe(setup);
  });
});
