import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { orgAdmin, regularUser, superAdmin } from "./helpers";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import ModulesPage from "@/app/organizations/[id]/modules/page";
import OrganizationsPage from "@/app/organizations/page";

const ORG = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-07T10:00:00+00:00";

const modulesState = (enabled: Record<string, boolean> = { inventory: true, purchasing: false, sales: true, finance: false }) => ({
  organization_id: ORG, organization_name: "Alpha Trading GmbH", revision: 7,
  modules: [
    { key: "inventory", name: "Inventory", description: "Products and stock.", features: ["Products", "Stock", "Scanning", "Movements"], requires: [], available: true, enabled: enabled.inventory, effective: enabled.inventory, updated_at: now, updated_by_name: "Sam Super" },
    { key: "purchasing", name: "Purchasing", description: "Buying.", features: ["Suppliers", "Purchase Orders", "Goods Receipts"], requires: ["inventory"], available: true, enabled: enabled.purchasing, effective: enabled.purchasing, updated_at: null, updated_by_name: null },
    { key: "sales", name: "Sales", description: "Selling.", features: ["Clients", "Delivery Lists", "Dispatches", "Invoices and Payments"], requires: ["inventory"], available: true, enabled: enabled.sales, effective: enabled.sales, updated_at: now, updated_by_name: "Sam Super" },
    { key: "finance", name: "Finance", description: "Planned.", features: ["Accounting"], requires: [], available: false, enabled: false, effective: false, updated_at: null, updated_by_name: null },
  ],
  permanent: [{ key: "support", name: "Help & Support", description: "Always available." }, { key: "authentication", name: "Authentication", description: "Sign-in." }],
});
const historyPage = { total: 2, items: [
  { id: "h1", module: "sales", module_name: "Sales", action: "enabled", old_enabled: false, new_enabled: true, changed_by_name: "Sam Super", changed_by_email: "sam@impex.example", reason: "Approved in SUP-000123", batch_id: "b1", created_at: now },
  { id: "h2", module: "inventory", module_name: "Inventory", action: "migrated", old_enabled: null, new_enabled: true, changed_by_name: "System", changed_by_email: null, reason: null, batch_id: "b0", created_at: now },
] };

const accounts: Record<string, any> = { "token-super": superAdmin, "token-org": orgAdmin, "token-user": regularUser };
let calls: string[] = [];
function stub(options: { modules?: number; history?: number } = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push(url);
    const token = ((init.headers ?? {}).Authorization ?? "").replace("Bearer ", "");
    if (url.endsWith("/api/v1/auth/me")) return accounts[token] ? json(200, accounts[token]) : json(401, {});
    if (url.includes("/modules/history")) return options.history ? json(options.history, {}) : json(200, historyPage);
    if (url.endsWith("/modules")) return options.modules ? json(options.modules, { detail: "x" }) : json(200, modulesState());
    if (url.includes("/api/v1/support/")) return json(200, { unread: 0, open: 0, total: 0 });
    if (url.endsWith("/api/v1/organizations")) return json(200, [{ id: ORG, name: "Alpha Trading GmbH", slug: "alpha-trading", country_code: "DE", tax_identifier: null, contact_email: "ops@alpha.example", primary_admin_email: null, is_active: true, created_at: now }]);
    if (url.endsWith("/administrators")) return json(200, []);
    return json(404, {});
  }));
}
const render = async (element: Promise<any>) => renderToStaticMarkup(await element);

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  process.env.SUPPORT_SERVICE_URL = "http://support-service:8005";
  for (const key of Object.keys(jar)) delete jar[key];
  jar.impex_session = "token-super";
});
afterEach(() => vi.unstubAllGlobals());

describe("who may open the module page", () => {
  it.each([["no session", null], ["an organization administrator", "token-org"], ["a regular user", "token-user"], ["an expired token", "token-gone"]])("%s is sent to sign in and nothing is requested", async (_label, token) => {
    stub();
    if (token) jar.impex_session = token;
    else delete jar.impex_session;
    await expect(render(ModulesPage({ params: { id: ORG } }))).rejects.toThrow("REDIRECT:/login");
    expect(calls.filter((c) => c.includes("/modules"))).toHaveLength(0);
  });
});

describe("the module page", () => {
  it("shows every module, what is enabled, dependencies, the permanent capabilities and the history", async () => {
    stub();
    const html = await render(ModulesPage({ params: { id: ORG } }));
    for (const expected of ["Module management", "Alpha Trading GmbH", "Inventory", "Purchasing", "Sales", "Finance", "Planned: not available yet", "Requires Inventory", "Last changed by Sam Super",
      "Products, Stock, Scanning, Movements", "Suppliers, Purchase Orders, Goods Receipts", "Clients, Delivery Lists, Dispatches, Invoices and Payments",
      "Always available", "Help &amp; Support", "Authentication", "History", "Approved in SUP-000123", "Kept when modules were introduced", "Review changes"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).toContain('aria-label="Inventory enabled"');
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*aria-label="Finance enabled"|<input[^>]*aria-label="Finance enabled"[^>]*disabled=""/); // planned: cannot be switched on
  });

  it("explains an unknown organization, an outage and a refusal, and a malformed id", async () => {
    stub({ modules: 404 });
    expect(await render(ModulesPage({ params: { id: ORG } }))).toContain("Organization not found.");
    stub({ modules: 503 });
    expect(await render(ModulesPage({ params: { id: ORG } }))).toContain("Nothing was changed");
    stub({ modules: 403 });
    expect(await render(ModulesPage({ params: { id: ORG } }))).toContain("Only a Super Admin");
    stub({ modules: 401 });
    await expect(render(ModulesPage({ params: { id: ORG } }))).rejects.toThrow("REDIRECT:/login");
    stub();
    expect(await render(ModulesPage({ params: { id: "../../x" } }))).toContain("Organization not found.");
    expect(calls.filter((c) => c.includes("/modules"))).toHaveLength(0);
  });

  it("still shows the modules when only the history is unavailable", async () => {
    stub({ history: 503 });
    const html = await render(ModulesPage({ params: { id: ORG } }));
    expect(html).toContain("Module management");
    expect(html).toContain("history could not be loaded");
  });
});

describe("the organizations screen", () => {
  it("links every organization to its module management", async () => {
    stub();
    const html = await render(OrganizationsPage());
    expect(html).toContain(`href="/organizations/${ORG}/modules"`);
    expect(html).toContain("Manage modules");
  });
});
