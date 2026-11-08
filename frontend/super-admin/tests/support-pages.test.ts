import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ORG_ID, orgAdmin, regularUser, superAdmin } from "./helpers";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import SupportLayout from "@/app/support/layout";
import SupportInboxPage from "@/app/support/page";
import TicketPage from "@/app/support/[id]/page";
import PortalShell from "@/components/portal-shell";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-07T10:00:00+00:00";
const T1 = "a1111111-1111-4111-8111-aaaaaaaaaaaa";
const T2 = "a1111111-1111-4111-8111-bbbbbbbbbbbb";

const summary = (id: string, number: string, extra: Record<string, unknown> = {}) => ({
  id, ticket_number: number, organization_id: ORG_ID, organization_name: "Alpha Trading GmbH", requester_name: "Olivia Owner", requester_email: "olivia@alpha.example", subject: "Printer broken",
  category: "technical_issue", category_label: "Technical Issue", priority: "normal", status: "open", status_label: "Open", created_at: now, updated_at: now, last_reply_at: now,
  last_message_role: "organization-admin", resolved_at: null, message_count: 1, unread: false, awaiting_staff: true, ...extra,
});
const items = [summary(T1, "SUP-000001", { unread: true }), summary(T2, "SUP-000002", { subject: "Enable invoicing", category: "change_request", category_label: "Change Request", priority: "urgent", organization_name: "Beta Logistics SARL", unread: false, awaiting_staff: false, status: "waiting_for_customer" })];
const detail = (s: any, extra: Record<string, unknown> = {}) => ({
  ...s, can_reply: true,
  messages: [{ id: "m1", sender_role: "organization-admin", sender_name: "Olivia Owner", body: "The printer shows E-42.", created_at: now, read: false }],
  events: [{ id: "e1", actor_role: "organization-admin", event_type: "created", old_value: null, new_value: null, created_at: now }],
  notifications: [{ id: "n1", notification_type: "new_ticket", recipient: "support@impex.example", delivery_status: "sent", attempts: 1, last_error: null, next_retry_at: now, sent_at: now, created_at: now }],
  ...extra,
});

const accounts: Record<string, any> = { "token-super": superAdmin, "token-org": orgAdmin, "token-user": regularUser };
let calls: string[] = [];
function stub(options: { support?: number; orgs?: number } = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push(url);
    const token = ((init.headers ?? {}).Authorization ?? "").replace("Bearer ", "");
    if (url.endsWith("/api/v1/auth/me")) return accounts[token] ? json(200, accounts[token]) : json(401, {});
    if (url.includes("/api/v1/organizations")) {
      return options.orgs ? json(options.orgs, {}) : json(200, [{ id: ORG_ID, name: "Alpha Trading GmbH", slug: "alpha-trading", country_code: "DE", tax_identifier: null, contact_email: "office@alpha.example", primary_admin_email: "olivia@alpha.example", is_active: true, created_at: now }]);
    }
    if (!url.includes("/api/v1/support/admin/")) return json(404, {});
    if (options.support) return json(options.support, { detail: "x" });
    const u = new URL(url);
    if (u.pathname === "/api/v1/support/admin/tickets") {
      const rows = items.filter((t) => (!u.searchParams.get("status") || t.status === u.searchParams.get("status")) && (!u.searchParams.get("unread") || t.unread));
      return json(200, { items: rows, total: rows.length, limit: 25, offset: 0, counts: { open: 1, waiting_for_customer: 1 }, unread: 1 });
    }
    if (u.pathname === "/api/v1/support/admin/summary") return json(200, { unread: 1, open: 1, total: 2 });
    const match = u.pathname.match(/\/tickets\/([^/]+)$/);
    const found = items.find((t) => t.id === match?.[1]);
    return found ? json(200, detail(found)) : json(404, { detail: "Ticket not found." });
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

describe("who may open the Support Inbox", () => {
  it.each([["no session", null], ["an organization administrator", "token-org"], ["a regular user", "token-user"], ["an expired token", "token-gone"]])("%s is sent to sign in, and the inbox is never requested", async (_label, token) => {
    stub();
    if (token) jar.impex_session = token;
    else delete jar.impex_session;
    await expect(render(SupportInboxPage({ searchParams: {} }))).rejects.toThrow("REDIRECT:/login");
    await expect(render(TicketPage({ params: { id: T1 } }))).rejects.toThrow("REDIRECT:/login");
    expect(calls.filter((c) => c.includes("/support/admin/"))).toHaveLength(0);
  });

  it("the layout above the loading boundary refuses everyone but a Super Admin, so the redirect is a real HTTP redirect", async () => {
    stub();
    expect(renderToStaticMarkup(await SupportLayout({ children: "INBOX" }))).toBe("INBOX");
    for (const token of [null, "token-org", "token-user", "token-gone"]) {
      if (token) jar.impex_session = token;
      else delete jar.impex_session;
      await expect(SupportLayout({ children: "INBOX" })).rejects.toThrow("REDIRECT:/login");
    }
  });

  it("an organization-portal cookie does not open the inbox", async () => {
    stub();
    delete jar.impex_session;
    jar.impex_tenant_session = "token-org";
    await expect(render(SupportInboxPage({ searchParams: {} }))).rejects.toThrow("REDIRECT:/login");
  });
});

describe("the navigation", () => {
  const shell = (current: "dashboard" | "organizations" | "support", supportUnread: number) =>
    renderToStaticMarkup(PortalShell({ user: superAdmin as any, current, supportUnread, children: "BODY" }));
  it("has a Support Inbox item that is marked current on support pages and shows unread tickets", () => {
    const html = shell("support", 3);
    expect(html).toContain('href="/support"');
    expect(html).toMatch(/aria-current="page"[^>]*>[\s\S]*?Support Inbox/);
    expect(html).toContain('aria-label="3 unread"');
    expect(shell("organizations", 0)).not.toContain("unread");
    expect(shell("dashboard", 250)).toContain("99+");
    // the two existing items remain
    expect(html).toContain('href="/organizations"');
    expect(html).toContain("Dashboard");
  });
});

describe("the inbox", () => {
  it("shows every organization's tickets with the required columns and the unread indicator", async () => {
    stub();
    const html = await render(SupportInboxPage({ searchParams: {} }));
    for (const expected of ["Support Inbox", "SUP-000001", "SUP-000002", "Alpha Trading GmbH", "Beta Logistics SARL", "Olivia Owner", "Printer broken", "Enable invoicing", "Technical Issue", "Change Request", "Urgent", "Waiting for Customer",
      "Submitted", "Latest activity", "2026-11-07 10:00 UTC", "Awaiting your reply", 'aria-label="Unread"', "Showing 1–2 of 2", "1 unread"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).toContain(`href="/support/${T1}"`);
    expect(html).toContain('aria-label="1 unread"'); // the nav badge
  });

  it("forwards only whitelisted filters", async () => {
    stub();
    await SupportInboxPage({ searchParams: { q: "printer", status: "open", priority: "urgent", category: "change_request", unread: "true", page: "2", organization_id: "x", limit: "999" } });
    const url = new URL(calls.find((c) => new URL(c).pathname === "/api/v1/support/admin/tickets")!);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "printer", status: "open", priority: "urgent", category: "change_request", unread: "true", limit: "25", offset: "25" });
  });

  it("explains an empty inbox, a filtered-empty one, an outage and a refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      if (url.endsWith("/auth/me")) return json(200, superAdmin);
      return json(200, { items: [], total: 0, limit: 25, offset: 0, counts: {}, unread: 0 });
    }));
    expect(await render(SupportInboxPage({ searchParams: {} }))).toContain("No support requests yet");
    expect(await render(SupportInboxPage({ searchParams: { q: "zzz" } }))).toContain("No tickets match these filters");
    stub({ support: 503 });
    expect(await render(SupportInboxPage({ searchParams: {} }))).toContain("Nothing was lost");
    stub({ support: 403 });
    expect(await render(SupportInboxPage({ searchParams: {} }))).toContain("Only a Super Admin");
    stub({ support: 401 });
    await expect(render(SupportInboxPage({ searchParams: {} }))).rejects.toThrow("REDIRECT:/login");
  });
});

describe("one ticket", () => {
  const page = (id: string) => render(TicketPage({ params: { id } }));

  it("shows the conversation, the organization identity and contact, the requester, the controls, notifications and activity", async () => {
    stub();
    const html = await page(T1);
    for (const expected of ["SUP-000001", "Printer broken", "The printer shows E-42.", "Alpha Trading GmbH", "alpha-trading", "DE", "office@alpha.example", "olivia@alpha.example", "mailto:olivia@alpha.example",
      "Send reply", "Mark In Progress", "Mark Resolved", "Close ticket", "Priority", "Email notifications", "New ticket → support team", "Sent", "Activity", "Ticket created"]) {
      expect(html, expected).toContain(expected);
    }
    expect(html).not.toContain("Reopen ticket");
  });

  it("a Change Request carries the reminder that nothing is changed automatically", async () => {
    stub();
    expect(await page(T2)).toContain("nothing was changed automatically");
    expect(await page(T1)).not.toContain("nothing was changed automatically");
  });

  it("an unknown ticket, a malformed id, an outage and a refusal are explained", async () => {
    stub();
    expect(await page("a1111111-1111-4111-8111-ffffffffffff")).toContain("Ticket not found.");
    expect(await page("../../etc/passwd")).toContain("Ticket not found.");
    stub({ support: 503 });
    expect(await page(T1)).toContain("Nothing was lost");
    stub({ support: 403 });
    expect(await page(T1)).toContain("Only a Super Admin");
    stub({ support: 401 });
    await expect(page(T1)).rejects.toThrow("REDIRECT:/login");
  });

  it("still opens when the Organization Service is down (the ticket carries the organization name)", async () => {
    stub({ orgs: 503 });
    const html = await page(T1);
    expect(html).toContain("Alpha Trading GmbH");
    expect(html).toContain("olivia@alpha.example");
  });
});
