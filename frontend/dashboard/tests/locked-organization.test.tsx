// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { alphaOrg, orgAdmin } from "./helpers";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({ usePathname: () => null,
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import ClientsLayout from "@/app/clients/layout";
import DashboardLayout from "@/app/(dashboard)/layout";
import FinanceLayout from "@/app/finance/layout";
import InvoicesLayout from "@/app/invoices/(sales)/layout";
import ProductsLayout from "@/app/products/layout";
import SettingsLayout from "@/app/settings/layout";
import StockLayout from "@/app/stock/layout";
import SupplierInvoicesLayout from "@/app/invoices/suppliers/layout";
import SuppliersLayout from "@/app/suppliers/layout";
import SupportLayout from "@/app/support/layout";
import { navGroups } from "@/lib/dashboard-nav";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

// A LOCKED organization (the Impex team's decision, e.g. the monthly payment is late): its administrators can sign in, but every module is off. Only Settings and Help & Support work.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function backend(org: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.endsWith("/api/v1/auth/me")) return (init.headers?.Authorization ?? "").endsWith("good") ? json(200, orgAdmin) : json(401, {});
    if (url.endsWith("/api/v1/tenant/organization")) return json(200, { ...alphaOrg, ...org });
    return json(404, {});
  }));
}
const LOCKED = { is_locked: true, modules: [] };

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  jar[TENANT_SESSION_COOKIE] = "good";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let rendered = false;
function Probe() {
  rendered = true;
  return <p>PAGE-CONTENT</p>;
}
const draw = async (layout: (p: any) => any) => renderToStaticMarkup(await layout({ children: <Probe /> }));

describe("the navigation of a locked organization", () => {
  it("lists only Help & Support and Settings: no Dashboard, no module", () => {
    const groups = navGroups(["inventory", "purchasing", "sales", "finance"], true);
    expect(groups.flatMap((g) => g.items.map((i) => [i.label, i.href]))).toEqual([["Help & Support", "/support"], ["Settings", "/settings"]]);
  });
  it("is unchanged for an organization that is not locked", () => {
    const labels = navGroups(["inventory"], false).flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toContain("Dashboard");
    expect(labels).toContain("Stock");
  });
});

describe.each([
  ["Dashboard", DashboardLayout],
  ["Products", ProductsLayout],
  ["Stock", StockLayout],
  ["Suppliers", SuppliersLayout],
  ["Suppliers Invoice", SupplierInvoicesLayout],
  ["Clients", ClientsLayout],
  ["Sales Invoice", InvoicesLayout],
  ["Finance", FinanceLayout],
] as [string, (p: any) => any][])("%s of a locked organization", (_label, layout) => {
  it("shows 'access locked', never renders the page, and the sidebar lists only Settings and Help & Support", async () => {
    backend(LOCKED);
    rendered = false;
    const html = await draw(layout);
    expect(html).toContain('data-organization-locked="true"');
    expect(html).toContain("Your organization&#x27;s access is locked");
    expect(html).not.toContain("PAGE-CONTENT");
    expect(rendered).toBe(false);
    const links = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(links.filter((href) => !["/support/new", "/settings"].includes(href) && !href.startsWith("/support") && !href.startsWith("/settings") && href !== "/")).toEqual([]);
    expect(html).not.toMatch(/href="\/(stock|products|clients|suppliers|finance|invoices)/);
    expect(html).not.toContain("Add Widgets"); // nothing on the home page to arrange
  });
});

describe("Settings and Help & Support of a locked organization", () => {
  it.each([["Settings", SettingsLayout], ["Help & Support", SupportLayout]] as [string, (p: any) => any][])("%s still works, with a reminder above it", async (_label, layout) => {
    backend(LOCKED);
    rendered = false;
    const html = await draw(layout);
    expect(rendered).toBe(true);
    expect(html).toContain("PAGE-CONTENT");
    expect(html).toContain('data-organization-locked="banner"');
    expect(html).not.toContain('data-organization-locked="true"');
  });
});

describe("an organization that is not locked", () => {
  it("is unaffected: modules work and there is no reminder", async () => {
    backend({ is_locked: false, modules: ["inventory"] });
    rendered = false;
    const html = await draw(StockLayout);
    expect(rendered).toBe(true);
    expect(html).not.toContain("data-organization-locked");
  });
});
