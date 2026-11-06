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

import SupportLayout from "@/app/support/layout";
import SupportPage from "@/app/support/page";
import NewTicketPage from "@/app/support/new/page";
import TicketPage from "@/app/support/[id]/page";
import SetupLayout from "@/app/setup/layout";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-07T10:00:00+00:00";
const T_A = "a1111111-1111-4111-8111-aaaaaaaaaaaa";
const T_A2 = "a1111111-1111-4111-8111-bbbbbbbbbbbb";
const T_B = "b2222222-2222-4222-8222-bbbbbbbbbbbb";
const DONE = "2026-11-03T00:05:00+00:00";

const summary = (id: string, number: string, org: string, extra: Record<string, unknown> = {}) => ({
  id, ticket_number: number, organization_name: org, requester_name: "Olivia Owner", subject: "Printer broken", category: "technical_issue", category_label: "Technical Issue", priority: "normal",
  status: "open", status_label: "Open", created_at: now, updated_at: now, last_reply_at: now, last_message_role: "organization-admin", resolved_at: null, message_count: 1, unread: false, ...extra,
});
const detail = (s: ReturnType<typeof summary>, extra: Record<string, unknown> = {}) => ({
  ...s, can_reply: s.status !== "closed",
  messages: [{ id: "m1", sender_role: "organization-admin", sender_name: "Olivia Owner", body: "The printer shows E-42.\nTried twice.", created_at: now, read: false }], ...extra,
});

const fresh = () => ({
  "token-alpha": {
    user: orgAdmin, org: { status: 200, body: alphaOrg },
    tickets: [summary(T_A, "SUP-000001", "Alpha Trading GmbH", { unread: true, last_message_role: "super-admin", status: "waiting_for_customer", status_label: "Waiting for You", message_count: 2 }), summary(T_A2, "SUP-000002", "Alpha Trading GmbH", { subject: "Enable invoicing", category: "change_request", category_label: "Change Request" })],
    details: {} as Record<string, any>,
  },
  "token-beta": { user: orgAdminB, org: { status: 200, body: betaOrg }, tickets: [summary(T_B, "SUP-000003", "Beta Logistics SARL", { subject: "Beta secret problem" })], details: {} as Record<string, any> },
});
function build() {
  const w = fresh();
  w["token-alpha"].details[T_A] = detail(w["token-alpha"].tickets[0] as any, {
    messages: [
      { id: "m1", sender_role: "organization-admin", sender_name: "Olivia Owner", body: "The printer shows E-42.\nTried twice.", created_at: now, read: true },
      { id: "m2", sender_role: "super-admin", sender_name: "Root Admin", body: "Please restart the spooler.", created_at: now, read: false },
    ],
  });
  w["token-alpha"].details[T_A2] = detail(w["token-alpha"].tickets[1] as any);
  w["token-beta"].details[T_B] = detail(w["token-beta"].tickets[0] as any);
  return w;
}
let world = build();

let calls: string[] = [];
function stubWorld(options: { support?: number; orgStatus?: number; profile?: string | null; setup?: string } = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push(url);
    const token = ((init.headers ?? {}).Authorization ?? "").replace("Bearer ", "");
    const entry = (world as any)[token] ?? (token === "token-super" ? { user: superAdmin, org: { status: 403, body: {} } } : undefined);
    if (url.endsWith("/api/v1/auth/me")) return entry ? json(200, options.profile === undefined ? entry.user : { ...entry.user, profile_setup_completed_at: options.profile }) : json(401, {});
    if (url.endsWith("/api/v1/tenant/organization")) {
      if (!entry) return json(401, {});
      return options.orgStatus ? json(options.orgStatus, {}) : json(entry.org.status, { ...entry.org.body, ...(options.setup ? { setup_status: options.setup } : {}) });
    }
    if (!url.includes("/api/v1/support/")) return json(404, {});
    if (options.support) return json(options.support, { detail: "x" });
    if (!entry) return json(401, {});
    const path = new URL(url).pathname.replace("/api/v1/support", "");
    const params = new URL(url).searchParams;
    if (path === "/tickets") {
      const items = entry.tickets.filter((t: any) => (!params.get("status") || t.status === params.get("status")) && (!params.get("unread") || t.unread));
      return json(200, { items, total: items.length, limit: Number(params.get("limit")), offset: Number(params.get("offset")), counts: { open: 1, in_progress: 0, waiting_for_customer: 1, resolved: 0, closed: 0 }, unread: entry.tickets.filter((t: any) => t.unread).length });
    }
    const match = path.match(/^\/tickets\/([^/]+)$/);
    if (match) return entry.details[match[1]] ? json(200, entry.details[match[1]]) : json(404, { detail: "Ticket not found." });
    return json(404, {});
  }));
}
const render = async (element: Promise<any>) => renderToStaticMarkup(await element);

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  process.env.SUPPORT_SERVICE_URL = "http://support-service:8005";
  world = build();
  for (const key of Object.keys(jar)) delete jar[key];
  jar[TENANT_SESSION_COOKIE] = "token-alpha";
});
afterEach(() => vi.unstubAllGlobals());

describe("the Help & Support layout", () => {
  it("is in the navigation, marked current, with the company branding", async () => {
    stubWorld();
    const html = await render(SupportLayout({ children: "PAGE-CONTENT" }));
    expect(html).toContain('href="/support"');
    expect(html).toContain("Help &amp; Support");
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Help &amp; Support<\/a>|<a[^>]*>Help &amp; Support<\/a>/);
    expect(html).toContain("PAGE-CONTENT");
    expect(html).toContain("Alpha Trading GmbH");
  });

  it("is reachable while first-time setup is unfinished: no redirect, with a way back to the wizard", async () => {
    for (const options of [{ setup: "pending" }, { setup: "in_progress" }, { profile: null }]) {
      stubWorld(options);
      const html = await render(SupportLayout({ children: "PAGE-CONTENT" }));
      expect(html).toContain("PAGE-CONTENT");
      expect(html).toContain("Back to setup");
      expect(html).toContain('href="/setup"');
    }
    stubWorld();
    expect(await render(SupportLayout({ children: "x" }))).not.toContain("Back to setup");
  });

  it("still requires a signed-in organization administrator", async () => {
    stubWorld();
    delete jar[TENANT_SESSION_COOKIE];
    await expect(render(SupportLayout({ children: "x" }))).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(render(SupportLayout({ children: "x" }))).rejects.toThrow("REDIRECT:/login");
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ orgStatus: 401 });
    await expect(render(SupportLayout({ children: "x" }))).rejects.toThrow("REDIRECT:/login");
  });

  it("shows the page even when the Organization Service is down (the page explains its own errors)", async () => {
    stubWorld({ orgStatus: 503 });
    expect(await render(SupportLayout({ children: "PAGE-CONTENT" }))).toContain("PAGE-CONTENT");
  });

  it("the setup screens carry a Contact support link, so help is one click away", () => {
    const html = renderToStaticMarkup(SetupLayout({ children: "X" }));
    expect(html).toContain('href="/support"');
    expect(html).toContain("Need help? Contact support");
    expect(html).toContain("Sign out");
  });
});

describe("the Help & Support list", () => {
  it("lists the organization's tickets with number, subject, category, status, activity and the reply indicator", async () => {
    stubWorld();
    const html = await render(SupportPage({ searchParams: {} }));
    for (const expected of ["Help &amp; Support", "SUP-000001", "SUP-000002", "Printer broken", "Enable invoicing", "Technical Issue", "Change Request", "Waiting for You", "Open", "New reply", "New request", "Showing 1–2 of 2", "Impex Support replied to 1 request"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).toContain(`href="/support/${T_A}"`);
    expect(html).toContain("2026-11-07 10:00 UTC");
  });

  it("two organizations: each sees only its own tickets", async () => {
    stubWorld();
    const a = await render(SupportPage({ searchParams: {} }));
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const b = await render(SupportPage({ searchParams: {} }));
    expect(a).toContain("Printer broken");
    expect(a).not.toContain("Beta secret problem");
    expect(b).toContain("Beta secret problem");
    expect(b).not.toContain("Printer broken");
    expect(b).not.toContain("SUP-000001");
  });

  it("passes only whitelisted filters to the service", async () => {
    stubWorld();
    await SupportPage({ searchParams: { q: "printer", status: "open", category: "change_request", unread: "true", page: "2", organization_id: T_B, priority: "urgent" } });
    const url = new URL(calls.find((c) => new URL(c).pathname === "/api/v1/support/tickets")!);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "printer", status: "open", category: "change_request", unread: "true", limit: "20", offset: "20" });
    calls.length = 0;
    await SupportPage({ searchParams: { status: "x", category: "' OR 1=1", unread: "yes", page: "banana", q: "a".repeat(300) } });
    const clean = new URL(calls.find((c) => new URL(c).pathname === "/api/v1/support/tickets")!);
    expect([...clean.searchParams.keys()].sort()).toEqual(["limit", "offset", "q"]);
    expect(clean.searchParams.get("q")!.length).toBe(100);
  });

  it("has meaningful empty, filtered-empty, forbidden, unavailable and expired states", async () => {
    world["token-alpha"].tickets = [];
    stubWorld();
    expect(await render(SupportPage({ searchParams: {} }))).toContain("You have not sent any request yet");
    expect(await render(SupportPage({ searchParams: { q: "zzz" } }))).toContain("No requests match these filters");
    world = build();
    stubWorld({ support: 403 });
    expect(await render(SupportPage({ searchParams: {} }))).toContain("currently inactive or unavailable");
    stubWorld({ support: 503 });
    expect(await render(SupportPage({ searchParams: {} }))).toContain("Nothing was lost");
    stubWorld({ support: 401 });
    await expect(SupportPage({ searchParams: {} })).rejects.toThrow("REDIRECT:/login");
    world = build();
  });

  it("the new-request page needs a session", async () => {
    stubWorld();
    expect(await render(NewTicketPage())).toContain("New request");
    delete jar[TENANT_SESSION_COOKIE];
    await expect(NewTicketPage()).rejects.toThrow("REDIRECT:/login");
  });
});

describe("one ticket", () => {
  const page = (id: string, sent?: string) => render(TicketPage({ params: { id }, searchParams: sent ? { sent } : {} }));

  it("shows the conversation: the question, Impex Support's reply, the status and the reply form", async () => {
    stubWorld();
    const html = await page(T_A);
    for (const expected of ["SUP-000001", "Waiting for You", "Printer broken", "Technical Issue", "The printer shows E-42.", "Please restart the spooler.", "Impex Support", "Olivia Owner", "Impex Support is waiting for your answer", "Send reply"]) {
      expect(html, expected).toContain(expected);
    }
  });

  it("a ticket nobody has answered says so", async () => {
    stubWorld();
    expect(await page(T_A2)).toContain("The Impex team has not replied yet");
  });

  it("confirms a just-sent request", async () => {
    stubWorld();
    const html = await page(T_A2, "1");
    expect(html).toContain("Your request SUP-000002 was sent to the Impex team");
  });

  it("a closed ticket has no reply form and points to a new request", async () => {
    world["token-alpha"].details[T_A2] = detail(summary(T_A2, "SUP-000002", "Alpha", { status: "closed", status_label: "Closed" }) as any);
    stubWorld();
    const html = await page(T_A2);
    expect(html).toContain("This request is closed");
    expect(html).not.toContain("Send reply");
    world = build();
  });

  it("another organization's ticket is shown exactly like one that does not exist", async () => {
    stubWorld();
    const foreign = await page(T_B);
    const missing = await page("b2222222-2222-4222-8222-ffffffffffff");
    expect(foreign).toBe(missing);
    expect(foreign).toContain("Request not found.");
    expect(foreign).not.toContain("Beta");
    expect(await page("not-an-id")).toContain("Request not found.");
  });

  it("explains an outage, an inactive organization and an expired session", async () => {
    stubWorld({ support: 503 });
    expect(await page(T_A)).toContain("Nothing was lost");
    stubWorld({ support: 403 });
    expect(await page(T_A)).toContain("currently inactive or unavailable");
    stubWorld({ support: 401 });
    await expect(page(T_A)).rejects.toThrow("REDIRECT:/login");
  });

  it("renders message text as text: markup in a message is escaped, never live", async () => {
    world["token-alpha"].details[T_A2] = detail(summary(T_A2, "SUP-000002", "Alpha") as any, {
      messages: [{ id: "x", sender_role: "organization-admin", sender_name: "<img src=x onerror=alert(1)>", body: '<script>alert("x")</script> <b onclick=evil()>bold</b>', created_at: now, read: false }],
    });
    stubWorld();
    const html = await page(T_A2);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b onclick");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    world = build();
  });
});
