// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
  usePathname: () => null,
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

import SuperAdminDashboard from "@/app/page";
import DashboardLayoutEditor from "@/components/dashboard-layout/layout-editor";
import { forgetSavedLayouts } from "@/components/dashboard-layout/layout-storage";
import PortalShell from "@/components/portal-shell";
import { forgetSavedTheme } from "@/components/theme/theme-provider";
import { ADMIN_WIDGETS } from "@/lib/dashboard-widgets";
import { SESSION_COOKIE } from "@/lib/session";
import { superAdmin } from "./helpers";

// The Super Admin Portal's personalised home page: its seven widgets (and only those), the same remove / Add Widgets / Restore All / Edit Layout
// behaviour as the Organization Portal, an independent saved arrangement, and the static demo figures staying exactly what they were.

const IDS = ADMIN_WIDGETS.map((w) => w.id);
const NAME = (id: string) => ADMIN_WIDGETS.find((w) => w.id === id)!.name;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const nodes = () => Object.fromEntries(IDS.map((id) => [id, (
  <section className="ix-glass" aria-label={NAME(id)}>
    <h3>{NAME(id)}</h3>
    <p>surface {id}</p>
    <a href={`/go/${id}`}>link {id}</a>
  </section>
)]));

let saves: { order: string[]; hidden: string[] }[];
let respond: (body: any) => Response;

beforeEach(() => {
  saves = [];
  forgetSavedLayouts();
  forgetSavedTheme();
  let revision = 1;
  respond = (body) => json(200, { layout: { version: 1, revision: ++revision, order: body.order, hidden: body.hidden } });
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any = {}) => {
    if (String(url).includes("/api/dashboard-layout")) { const body = JSON.parse(init.body); saves.push(body); return respond(body); }
    if (String(url).endsWith("/api/v1/auth/me")) return json(200, superAdmin);
    if (String(url).includes("/api/v1/support/")) return json(200, { unread: 0, open: 0, total: 0 });
    return json(404, {});
  }));
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.SUPPORT_SERVICE_URL = "http://support-service:8005";
  for (const key of Object.keys(jar)) delete jar[key];
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const mount = (saved: unknown = null, current: any = "dashboard") => render(
  <PortalShell user={{ ...superAdmin, dashboard_layout: saved } as any} current={current}>
    {current === "dashboard" ? <DashboardLayoutEditor nodes={nodes()} /> : <p>another page</p>}
  </PortalShell>,
);
const shown = () => Array.from(document.querySelectorAll<HTMLElement>("[data-widget-id]")).map((el) => el.dataset.widgetId!);
const card = (id: string) => document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!;
const dotsOf = (id: string) => within(card(id)).getByRole("button", { name: `Options for ${NAME(id)}` });
const surface = (id: string) => within(card(id)).getByText(`surface ${id}`);

describe("the Super Admin dashboard page", () => {
  it("renders all seven widgets by default, in the original order, with the same static demo figures", async () => {
    jar[SESSION_COOKIE] = "token";
    const html = renderToStaticMarkup(await SuperAdminDashboard());
    const ids = Array.from(html.matchAll(/data-widget-id="([^"]+)"/g), (m) => m[1]);
    expect(ids).toEqual(IDS);
    for (const text of ["Active Tenants", "24", "+3 this week", "System Uptime", "99.98%", "Last 30 days", "API Gateway Requests", "1.42M", "+12.4% vs last mo", "Pending Approvals", "Requires review", "Microservice Registry", "Docker Compose Stack", "API Documentation", "docker compose up --build", "Ping Health"]) expect(html, text).toContain(text);
    expect(html).not.toContain("org.overview"); // nothing of the Organization Portal
    expect(html).not.toContain("Welcome,");
  });

  it("the registry's table keeps its own controls: the health links are real links inside the widget", async () => {
    jar[SESSION_COOKIE] = "token";
    const html = renderToStaticMarkup(await SuperAdminDashboard());
    expect(html).toMatch(/<a href="\/api\/v1\/auth\/health"[^>]*>Ping Health<\/a>/);
  });
});

describe("the Super Admin Add Widgets button", () => {
  it("is in the header right before Customize Theme, on the dashboard only", async () => {
    mount();
    const labels = within(screen.getByRole("banner")).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels.indexOf("Add Widgets")).toBe(labels.indexOf("Customize Theme") - 1);
    cleanup();
    mount(null, "organizations");
    expect(screen.queryByRole("button", { name: "Add Widgets" })).toBeNull();
    expect(document.querySelectorAll("[data-widget-id]")).toHaveLength(0);
  });
});

describe("removing, adding back and arranging", () => {
  it("removes a card from its three-dot menu, lists it in 'Your Widgets', adds it back at the end and saves each step", async () => {
    const user = userEvent.setup();
    mount();
    expect(shown()).toEqual(IDS);
    await user.click(surface("admin.kpi.system-uptime"));
    expect(screen.queryByRole("menu")).toBeNull(); // the card's own surface does nothing
    await user.click(dotsOf("admin.kpi.system-uptime"));
    await user.click(screen.getByRole("menuitem", { name: "Remove from Home" }));
    expect(shown()).toEqual(IDS.filter((id) => id !== "admin.kpi.system-uptime"));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toEqual({ order: IDS.filter((id) => id !== "admin.kpi.system-uptime"), hidden: ["admin.kpi.system-uptime"] });

    await user.click(screen.getByRole("button", { name: "Add Widgets" }));
    const panel = screen.getByRole("dialog", { name: "Your Widgets" });
    const row = within(panel).getByRole("listitem");
    expect(within(row).getByText("System Uptime")).toBeTruthy();
    expect(within(row).getByText("Platform availability over the last 30 days.")).toBeTruthy();
    await user.click(within(row).getByRole("button", { name: "Add Widget: System Uptime" }));
    expect(shown()[shown().length - 1]).toBe("admin.kpi.system-uptime");
    expect(within(panel).getByText("All widgets are on your dashboard.")).toBeTruthy();
  });

  it("links inside a card keep working; the table's controls do not open the menu", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(within(card("admin.panel.microservice-registry")).getByRole("link"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Restore All Widgets, and the empty state when every card is removed", async () => {
    const user = userEvent.setup();
    mount({ version: 1, revision: 4, order: [], hidden: IDS });
    expect(screen.getByRole("heading", { name: "Your dashboard is empty" })).toBeTruthy();
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "Add Widgets" }));
    await user.click(screen.getByRole("button", { name: "Restore All Widgets" }));
    expect(shown()).toEqual(IDS);
    await waitFor(() => expect(saves[saves.length - 1]).toEqual({ order: IDS, hidden: [] }));
  });

  it("Edit Layout: from the three-dot menu, move with the keyboard, Save Layout stores the order", async () => {
    const user = userEvent.setup();
    mount();
    expect(fireEvent.contextMenu(surface("admin.kpi.active-tenants"))).toBe(true); // a right-click is left to the browser
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(within(card("admin.kpi.active-tenants")).getByRole("button", { name: "Options for Active Tenants" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit Layout" }));
    const bar = screen.getByRole("toolbar", { name: "Edit layout" });
    within(card("admin.kpi.active-tenants")).getByRole("button", { name: /^Move Active Tenants\./ }).focus();
    await user.keyboard("{End}");
    expect(shown()[IDS.length - 1]).toBe("admin.kpi.active-tenants");
    await user.click(within(bar).getByRole("button", { name: "Save Layout" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].order).toEqual([...IDS.slice(1), "admin.kpi.active-tenants"]);
  });

  it("applies this Super Admin's own saved arrangement, and ignores anything that is not an 'admin.' widget", () => {
    mount({ version: 1, revision: 3, order: ["org.overview", "admin.panel.api-documentation", "admin.kpi.active-tenants"], hidden: ["admin.panel.docker-compose"] });
    expect(shown()).toEqual(["admin.panel.api-documentation", "admin.kpi.active-tenants", ...IDS.filter((id) => !["admin.panel.api-documentation", "admin.kpi.active-tenants", "admin.panel.docker-compose"].includes(id))]);
    expect(shown()).not.toContain("admin.panel.docker-compose");
  });
});
