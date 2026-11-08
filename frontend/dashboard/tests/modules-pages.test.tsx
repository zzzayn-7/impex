// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
import DeliveryListsLayout from "@/app/delivery-lists/layout";
import DispatchesLayout from "@/app/dispatches/layout";
import GoodsReceiptsLayout from "@/app/goods-receipts/layout";
import InvoicesLayout from "@/app/invoices/layout";
import MovementsLayout from "@/app/movements/layout";
import DashboardLayout from "@/app/(dashboard)/layout";
import DashboardPage from "@/app/(dashboard)/page";

// The dashboard is its layout (session, setup gate, frame) around its page (the data): rendered together, as a visitor gets them.
const OrganizationDashboard = async () => DashboardLayout({ children: await DashboardPage() });
import ProductsLayout from "@/app/products/layout";
import PurchaseOrdersLayout from "@/app/purchase-orders/layout";
import ScanLayout from "@/app/scan/layout";
import StockLayout from "@/app/stock/layout";
import SuppliersLayout from "@/app/suppliers/layout";
import SupportLayout from "@/app/support/layout";
import NewTicketPage from "@/app/support/new/page";
import WarehousesLayout from "@/app/warehouses/layout";
import PortalShell from "@/components/dashboard/frame";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: string[] = [];
function backend(org: { status?: number; modules?: unknown; omitModules?: boolean } = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/v1/auth/me")) return (init.headers?.Authorization ?? "").endsWith("good") ? json(200, orgAdmin) : json(401, {});
    if (url.endsWith("/api/v1/tenant/organization")) {
      if (org.status) return json(org.status, { detail: "x" });
      const { modules: _ignored, ...rest } = alphaOrg;
      return json(200, org.omitModules ? rest : { ...rest, modules: org.modules ?? ["inventory", "purchasing", "sales"] });
    }
    return json(404, {});
  }));
}

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
  return <p>SECRET-PAGE-CONTENT</p>;
}
const layouts: [string, string, (p: any) => any, string[]][] = [
  ["inventory", "Products", ProductsLayout, ["inventory"]],
  ["inventory", "Warehouses", WarehousesLayout, ["inventory"]],
  ["inventory", "Stock", StockLayout, ["inventory"]],
  ["inventory", "Scan Product", ScanLayout, ["inventory"]],
  ["inventory", "Movements", MovementsLayout, ["inventory"]],
  ["purchasing", "Suppliers", SuppliersLayout, ["inventory", "purchasing"]],
  ["purchasing", "Purchase Orders", PurchaseOrdersLayout, ["inventory", "purchasing"]],
  ["purchasing", "Goods Receipts", GoodsReceiptsLayout, ["inventory", "purchasing"]],
  ["sales", "Clients", ClientsLayout, ["inventory", "sales"]],
  ["sales", "Delivery Lists", DeliveryListsLayout, ["inventory", "sales"]],
  ["sales", "Dispatches", DispatchesLayout, ["inventory", "sales"]],
  ["sales", "Invoices", InvoicesLayout, ["inventory", "sales"]],
];
const draw = async (layout: (p: any) => any) => renderToStaticMarkup(await layout({ children: <Probe /> }));

describe("a page whose module is not enabled is not shown", () => {
  it.each(layouts)("%s: %s answers 'access denied' and never renders the page", async (module, label, layout, needs) => {
    backend({ modules: [] });
    rendered = false;
    const html = await draw(layout);
    expect(rendered).toBe(false); // the page component was not even rendered: nothing of it is fetched or sent
    expect(html).not.toContain("SECRET-PAGE-CONTENT");
    expect(html).toContain(`data-module-denied="${module}"`);
    expect(html).toContain("is not enabled for your organization");
    expect(html).toContain(`href="/support/new?module=${module}"`); // a way to ask, which enables nothing by itself
    expect(html).toContain('href="/support"');
    expect(html).toContain("Alpha Trading GmbH"); // the frame (header, sign out) is still there
    // and the same page with the module (and what it needs) enabled
    backend({ modules: needs });
    rendered = false;
    const shown = await draw(layout);
    expect(rendered).toBe(true);
    expect(shown).toContain("SECRET-PAGE-CONTENT");
    expect(shown).not.toContain("data-module-denied");
  });

  it.each(layouts)("%s: %s is refused when only a module it depends on is missing", async (_module, _label, layout, needs) => {
    if (needs.length < 2) return;
    backend({ modules: needs.filter((m) => m !== "inventory") }); // e.g. Sales without Inventory
    expect(await draw(layout)).toContain("data-module-denied");
  });

  it.each(layouts)("%s: %s fails closed when the organization record has no module list", async (_m, _l, layout) => {
    backend({ omitModules: true });
    rendered = false;
    expect(await draw(layout)).toContain("data-module-denied");
    expect(rendered).toBe(false);
  });

  it("an unreachable Organization Service shows the recoverable error, not the page", async () => {
    backend({ status: 503 });
    rendered = false;
    const html = await draw(SuppliersLayout);
    expect(rendered).toBe(false);
    expect(html).toContain("couldn&#x27;t load your workspace");
  });

  it("an inactive organization keeps today's behaviour: the services refuse, and the page explains itself", async () => {
    backend({ status: 403 });
    expect(await draw(SuppliersLayout)).toContain("SECRET-PAGE-CONTENT");
  });

  it("needs a session first", async () => {
    backend();
    delete jar[TENANT_SESSION_COOKIE];
    await expect(draw(SuppliersLayout)).rejects.toThrow("REDIRECT:/login");
  });
});

describe("the navigation lists only what is enabled", () => {
  const nav = (modules: string[] | undefined, current: any = "dashboard") =>
    renderToStaticMarkup(<PortalShell admin={orgAdmin as any} current={current} organization={modules === undefined ? { name: "Acme" } : { name: "Acme", modules }}>{null}</PortalShell>);
  const labels = (html: string) => [...html.matchAll(/<a[^>]*href="[^"]*"[^>]*>(.*?)<\/a>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace("&amp;", "&"));
  const same = (actual: string[], expected: string[]) => expect([...actual].sort()).toEqual([...expected].sort());

  it("everything enabled: the whole menu", () => {
    same(labels(nav(["inventory", "purchasing", "sales"])),
      ["Dashboard", "Products", "Warehouses", "Stock", "Scan Product", "Movements", "Delivery Lists", "Dispatches", "Invoices", "Clients", "Suppliers", "Purchase Orders", "Goods Receipts", "Help & Support", "Settings"],
    );
  });
  it("only Inventory: no Purchasing or Sales entries", () => {
    same(labels(nav(["inventory"])), ["Dashboard", "Products", "Warehouses", "Stock", "Scan Product", "Movements", "Help & Support", "Settings"]);
  });
  it("Inventory and Sales", () => {
    const shown = labels(nav(["inventory", "sales"]));
    expect(shown).toContain("Invoices");
    expect(shown).not.toContain("Suppliers");
    expect(shown).not.toContain("Goods Receipts");
  });
  it("nothing enabled, an unknown list or no organization: only Dashboard and Help & Support", () => {
    same(labels(nav([])), ["Dashboard", "Help & Support", "Settings"]);
    same(labels(nav(undefined)), ["Dashboard", "Help & Support", "Settings"]);
    same(labels(renderToStaticMarkup(<PortalShell admin={orgAdmin as any} current="dashboard">{null}</PortalShell>)), ["Dashboard", "Help & Support", "Settings"]);
    same(labels(nav(["sales"])), ["Dashboard", "Help & Support", "Settings"]); // Sales without Inventory is not usable
  });
  it("Help & Support is always in the menu, and a disabled module's links are not in the page at all", () => {
    const html = nav([]);
    expect(html).toContain('href="/support"');
    for (const href of ["/products", "/suppliers", "/clients", "/invoices", "/dispatches"]) expect(html).not.toContain(`href="${href}"`);
  });
});

describe("the dashboard", () => {
  const page = async () => renderToStaticMarkup(await OrganizationDashboard());

  it("lists the enabled modules with their pages, and nothing else", async () => {
    backend({ modules: ["inventory", "sales"] });
    const html = await page();
    expect(html).toContain('data-module="inventory"');
    expect(html).toContain('data-module="sales"');
    expect(html).not.toContain('data-module="purchasing"');
    for (const href of ["/products", "/movements", "/clients", "/invoices"]) expect(html).toContain(`href="${href}"`);
    for (const href of ["/suppliers", "/purchase-orders", "/goods-receipts"]) expect(html).not.toContain(`href="${href}"`);
    expect(html).toContain('href="/support/new?module=other"');
  });

  it("says so when no module is enabled, and still offers Help & Support", async () => {
    backend({ modules: [] });
    const html = await page();
    expect(html).toContain("No business modules are enabled");
    expect(html).not.toContain("data-module=");
    expect(html).toContain('href="/support"');
  });

  it("an unknown list (an outage or an old service) lists no module", async () => {
    backend({ omitModules: true });
    expect(await page()).not.toContain("data-module=");
  });
});

describe("asking for a module from Help & Support", () => {
  beforeEach(() => backend());
  const form = async (module?: string | string[]) => renderToStaticMarkup(await NewTicketPage({ searchParams: module === undefined ? {} : { module } }));

  it("a module link pre-fills a Change Request with fixed wording", async () => {
    const html = await form("sales");
    expect(html).toContain('value="Request to activate the Sales module"');
    expect(html).toContain("Please enable the Sales module for our organization.");
    expect(html).toMatch(/<option value="change_request" selected/);
    expect((await form("other"))).toContain('value="Request to activate a module"');
  });

  it("nothing in the address is ever used as text", async () => {
    for (const bad of ["<script>alert(1)</script>", "sales; DROP", "support", "", ["sales", "x"].reverse()]) {
      const html = await form(bad as any);
      expect(html, String(bad)).not.toContain("alert(1)");
    }
    expect(await form("finance")).toContain('value="Request to activate the Finance module"'); // a real module key, fixed wording
    expect(await form()).not.toContain("Request to activate");
  });

  it("the page and the layout stay open when every module is off (Help & Support is permanent)", async () => {
    backend({ modules: [] });
    const html = renderToStaticMarkup(await SupportLayout({ children: <Probe /> }));
    expect(html).toContain("SECRET-PAGE-CONTENT");
    expect(html).not.toContain("data-module-denied");
  });
});

describe("the access-denied state", () => {
  it("explains that records are kept and offers the way to ask", async () => {
    backend({ modules: [] });
    const { container } = render(<div dangerouslySetInnerHTML={{ __html: await draw(SuppliersLayout) }} />);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Purchasing is not enabled for your organization");
    expect(screen.getByRole("link", { name: "Request access from the Impex team" }).getAttribute("href")).toBe("/support/new?module=purchasing");
    expect(screen.getByRole("link", { name: "Back to the dashboard" }).getAttribute("href")).toBe("/");
    expect(container.textContent).toContain("exactly as you left it");
  });
});
