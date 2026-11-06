// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { newIdempotencyKey } from "@/lib/support-browser";
import SupportInbox from "@/app/support/support-inbox";
import TicketPanel from "@/app/support/[id]/ticket-panel";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-07T10:00:00+00:00";
const T1 = "a1111111-1111-4111-8111-aaaaaaaaaaaa";

const summary = (extra: Record<string, unknown> = {}) => ({
  id: T1, ticket_number: "SUP-000001", organization_id: "o1", organization_name: "Alpha Trading GmbH", requester_name: "Olivia Owner", requester_email: "olivia@alpha.example", subject: "Printer broken",
  category: "technical_issue", category_label: "Technical Issue", priority: "normal", status: "open", status_label: "Open", created_at: now, updated_at: now, last_reply_at: now,
  last_message_role: "organization-admin", resolved_at: null, message_count: 1, unread: false, awaiting_staff: true, ...extra,
});
const detail = (extra: Record<string, unknown> = {}) => ({
  ...summary(), can_reply: true,
  messages: [{ id: "m1", sender_role: "organization-admin", sender_name: "Olivia Owner", body: "The printer shows E-42.", created_at: now, read: true }],
  events: [{ id: "e1", actor_role: "organization-admin", event_type: "created", old_value: null, new_value: null, created_at: now }],
  notifications: [{ id: "n1", notification_type: "new_ticket", recipient: "support@impex.example", delivery_status: "sent", attempts: 1, last_error: null, next_retry_at: now, sent_at: now, created_at: now }],
  ...extra,
});
const page = (items: any[], extra: Record<string, unknown> = {}) => ({ ok: true as const, items, total: items.length, limit: 25, offset: 0, counts: { open: items.length }, unread: 0, ...extra });
const noFilters = { q: "", status: "" as const, category: "" as const, priority: "" as const, unread: false, page: 1 };
const org = { id: "o1", name: "Alpha Trading GmbH", slug: "alpha-trading", isActive: true, contactEmail: "office@alpha.example", country: "DE" };

type Call = { url: string; init: any };
let calls: Call[] = [];
function stubFetch(handler: (url: string, init: any) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }));
}
const keyOf = (call: Call) => call.init.headers["Idempotency-Key"] as string;

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  router.push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SupportInbox", () => {
  it("lists tickets with the unread dot and per-status counts; a count button filters", async () => {
    render(<SupportInbox list={page([summary({ unread: true })], { counts: { open: 4, resolved: 2 }, unread: 1 })} filters={noFilters} />);
    expect(screen.getByRole("link", { name: /SUP-000001/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Unread" })).toBeTruthy();
    expect(screen.getByText("Alpha Trading GmbH")).toBeTruthy();
    const group = screen.getByRole("group", { name: "Tickets by status" });
    expect(within(group).getByRole("button", { name: /Open\s*4/ })).toBeTruthy();
    await userEvent.click(within(group).getByRole("button", { name: /Resolved\s*2/ }));
    expect(router.push).toHaveBeenLastCalledWith("/support?status=resolved");
  });

  it("search, filters and unread-only become address parameters and reset the page", async () => {
    render(<SupportInbox list={page([summary()])} filters={{ ...noFilters, page: 4 }} />);
    await userEvent.type(screen.getByPlaceholderText(/Ticket number, subject/), " alpha ");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(router.push).toHaveBeenLastCalledWith("/support?q=alpha");
    await userEvent.selectOptions(screen.getByLabelText(/^Priority/), "urgent");
    expect(router.push).toHaveBeenLastCalledWith("/support?priority=urgent");
    await userEvent.selectOptions(screen.getByLabelText(/^Category/), "change_request");
    expect(router.push).toHaveBeenLastCalledWith("/support?category=change_request");
    await userEvent.click(screen.getByLabelText("Unread only"));
    expect(router.push).toHaveBeenLastCalledWith("/support?unread=true");
  });

  it("paginates, and clears every filter", async () => {
    render(<SupportInbox list={{ ...page([summary()]), total: 60, offset: 25 }} filters={{ ...noFilters, status: "open", priority: "high", page: 2 }} />);
    expect(screen.getByText("Showing 26–26 of 60")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(router.push).toHaveBeenLastCalledWith("/support?status=open&priority=high&page=3");
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(router.push).toHaveBeenLastCalledWith("/support?status=open&priority=high");
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(router.push).toHaveBeenLastCalledWith("/support");
  });

  it("empty and error states", () => {
    const first = render(<SupportInbox list={page([])} filters={noFilters} />);
    expect(screen.getByText(/No support requests yet/)).toBeTruthy();
    first.unmount();
    const second = render(<SupportInbox list={page([])} filters={{ ...noFilters, q: "x" }} />);
    expect(screen.getByText("No tickets match these filters.")).toBeTruthy();
    second.unmount();
    render(<SupportInbox list={{ ok: false, reason: "unavailable" }} filters={noFilters} />);
    expect(screen.getByRole("alert").textContent).toContain("Nothing was lost");
  });

  it("renders text from customers as text, never as markup", () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const { container } = render(<SupportInbox list={page([summary({ subject: evil, organization_name: evil, requester_name: evil })])} filters={noFilters} />);
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(container.textContent).toContain(evil);
  });
});

describe("TicketPanel", () => {
  it("shows the organization, the requester, the messages, notification records and the activity", () => {
    render(<TicketPanel initial={detail() as any} organization={org} />);
    expect(screen.getByText("The printer shows E-42.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "olivia@alpha.example" }).getAttribute("href")).toBe("mailto:olivia@alpha.example");
    expect(screen.getByRole("link", { name: "office@alpha.example" })).toBeTruthy();
    expect(screen.getByText("alpha-trading", { exact: false })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Email notifications" })).getByText(/Sent · 1 attempt/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Activity" })).getByText("Ticket created")).toBeTruthy();
  });

  it("replies from the portal: sends text and the status choice with a key, shows the reply at once", async () => {
    const after = detail({
      status: "in_progress", status_label: "In Progress",
      messages: [
        { id: "m1", sender_role: "organization-admin", sender_name: "Olivia Owner", body: "The printer shows E-42.", created_at: now, read: true },
        { id: "m2", sender_role: "super-admin", sender_name: "Root Admin", body: "Please restart the spooler.", created_at: now, read: false },
      ],
    });
    stubFetch(() => json(201, { ticket: after, replayed: false }));
    render(<TicketPanel initial={detail() as any} organization={org} />);
    await userEvent.type(screen.getByLabelText(/^Your reply to Olivia Owner/), "Please restart the spooler.");
    await userEvent.selectOptions(screen.getByLabelText("After sending"), "in_progress");
    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await screen.findByText(/Reply sent/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`/api/support/tickets/${T1}/messages`);
    expect(JSON.parse(calls[0].init.body)).toEqual({ body: "Please restart the spooler.", status: "in_progress" });
    expect(keyOf(calls[0])).toBeTruthy();
    expect(screen.getByText("Please restart the spooler.", { selector: "[data-testid=message-body]" })).toBeTruthy();
    expect(screen.getAllByText("In Progress").length).toBeGreaterThan(0);
    expect((screen.getByLabelText(/^Your reply to/) as HTMLTextAreaElement).value).toBe("");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("without a status choice, only the text is sent (the service moves it to Waiting for Customer)", async () => {
    stubFetch(() => json(201, { ticket: detail({ status: "waiting_for_customer" }), replayed: false }));
    render(<TicketPanel initial={detail() as any} organization={org} />);
    expect((screen.getByLabelText("After sending") as HTMLSelectElement).textContent).toContain("Waiting for Customer (default)");
    await userEvent.type(screen.getByLabelText(/^Your reply to/), "Hello");
    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await screen.findByText(/Reply sent/);
    expect(JSON.parse(calls[0].init.body)).toEqual({ body: "Hello" });
  });

  it("refuses an empty reply; a double click sends once", async () => {
    let release: (r: Response) => void = () => undefined;
    stubFetch(() => new Promise<Response>((resolve) => { release = resolve; }));
    render(<TicketPanel initial={detail() as any} organization={org} />);
    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(screen.getByText("Write your reply.")).toBeTruthy();
    expect(calls).toHaveLength(0);
    await userEvent.type(screen.getByLabelText(/^Your reply to/), "Hi");
    await userEvent.dblClick(screen.getByRole("button", { name: "Send reply" }));
    expect(calls).toHaveLength(1);
    release(json(201, { ticket: detail(), replayed: false }));
    await screen.findByText(/Reply sent/);
  });

  it("keeps the text and the same key after a lost connection; a refusal takes a new key", async () => {
    let step = 0;
    stubFetch(() => {
      step += 1;
      if (step === 1) throw new Error("offline");
      if (step === 2) return json(409, { error: "A ticket cannot go from Resolved to Waiting for Customer.", code: "invalid_transition" });
      return json(201, { ticket: detail(), replayed: false });
    });
    render(<TicketPanel initial={detail() as any} organization={org} />);
    await userEvent.type(screen.getByLabelText(/^Your reply to/), "Keep me");
    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await screen.findByText("Unable to reach the server. Please try again.");
    expect((screen.getByLabelText(/^Your reply to/) as HTMLTextAreaElement).value).toBe("Keep me");
    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await screen.findByText("A ticket cannot go from Resolved to Waiting for Customer.");
    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await screen.findByText(/Reply sent/);
    expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
    expect(keyOf(calls[2])).not.toBe(keyOf(calls[1]));
  });

  it("status buttons offer only the allowed moves and call the update route", async () => {
    stubFetch(() => json(200, { ticket: detail({ status: "resolved", status_label: "Resolved" }) }));
    render(<TicketPanel initial={detail() as any} organization={org} />);
    const controls = screen.getByRole("region", { name: "Status and priority" });
    expect(within(controls).queryByRole("button", { name: "Reopen" })).toBeNull(); // an open ticket cannot be "reopened"
    for (const name of ["Mark In Progress", "Waiting for Customer", "Mark Resolved", "Close ticket"]) expect(within(controls).getByRole("button", { name })).toBeTruthy();
    await userEvent.click(within(controls).getByRole("button", { name: "Mark Resolved" }));
    await screen.findByText("Status changed to Resolved.");
    expect(calls[0].url).toBe(`/api/support/tickets/${T1}`);
    expect(calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init.body)).toEqual({ status: "resolved" });
    // now resolved: it can be reopened, not marked resolved again
    expect(within(controls).getByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(within(controls).queryByRole("button", { name: "Mark Resolved" })).toBeNull();
  });

  it("names the way back to Open honestly: Reopen only for a finished ticket", () => {
    const { unmount } = render(<TicketPanel initial={detail({ status: "waiting_for_customer", status_label: "Waiting for Customer" }) as any} organization={org} />);
    const controls = screen.getByRole("region", { name: "Status and priority" });
    expect(within(controls).getByRole("button", { name: "Mark Open" })).toBeTruthy();
    expect(within(controls).queryByRole("button", { name: "Reopen" })).toBeNull();
    unmount();
    render(<TicketPanel initial={detail({ status: "resolved", status_label: "Resolved" }) as any} organization={org} />);
    expect(within(screen.getByRole("region", { name: "Status and priority" })).getByRole("button", { name: "Reopen" })).toBeTruthy();
  });

  it("changes the priority", async () => {
    stubFetch(() => json(200, { ticket: detail({ priority: "urgent" }) }));
    render(<TicketPanel initial={detail() as any} organization={org} />);
    await userEvent.selectOptions(screen.getByLabelText("Priority"), "urgent");
    await screen.findByText("Priority updated.");
    expect(JSON.parse(calls[0].init.body)).toEqual({ priority: "urgent" });
    expect(screen.getByText("Urgent priority")).toBeTruthy();
  });

  it("shows a refused change and leaves the ticket as it was", async () => {
    stubFetch(() => json(409, { error: "A ticket cannot go from Closed to Resolved." }));
    render(<TicketPanel initial={detail() as any} organization={org} />);
    await userEvent.click(screen.getByRole("button", { name: "Mark Resolved" }));
    await screen.findByText("A ticket cannot go from Closed to Resolved.");
    expect(screen.getAllByText("Open").length).toBeGreaterThan(0);
  });

  it("a closed ticket has no reply form, only Reopen", async () => {
    stubFetch(() => json(200, { ticket: detail() }));
    render(<TicketPanel initial={detail({ status: "closed", status_label: "Closed", can_reply: false }) as any} organization={org} />);
    expect(screen.queryByRole("button", { name: "Send reply" })).toBeNull();
    expect(screen.getByRole("note").textContent).toContain("closed");
    const controls = screen.getByRole("region", { name: "Status and priority" });
    expect(within(controls).getAllByRole("button").map((b) => b.textContent)).toEqual(["Reopen"]);
    await userEvent.click(screen.getByRole("button", { name: "Reopen ticket" }));
    await waitFor(() => expect(JSON.parse(calls[0].init.body)).toEqual({ status: "open" }));
  });

  it("a failed notification email shows its error and can be retried", async () => {
    const failed = { id: "n9", notification_type: "staff_reply", recipient: "olivia@alpha.example", delivery_status: "failed", attempts: 8, last_error: "SMTP connection refused", next_retry_at: now, sent_at: null, created_at: now };
    stubFetch(() => json(200, { notification: { ...failed, delivery_status: "pending", attempts: 0, last_error: null } }));
    render(<TicketPanel initial={detail({ notifications: [failed] }) as any} organization={org} />);
    const box = screen.getByRole("region", { name: "Email notifications" });
    expect(within(box).getByText(/Failed · 8 attempts/)).toBeTruthy();
    expect(within(box).getByText("SMTP connection refused")).toBeTruthy();
    await userEvent.click(within(box).getByRole("button", { name: "Try again" }));
    await screen.findByText("Another delivery attempt has been scheduled.");
    expect(calls[0].url).toBe("/api/support/notifications/n9/retry");
    expect(within(box).getByText(/Waiting to send/)).toBeTruthy();
    expect(within(box).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("sends the person to sign in again when the session has ended", async () => {
    stubFetch(() => json(401, { error: "Session expired." }));
    render(<TicketPanel initial={detail() as any} organization={org} />);
    await userEvent.type(screen.getByLabelText(/^Your reply to/), "Hi");
    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("renders customer text as text and reminds that a Change Request changes nothing by itself", () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    const ticket = detail({ category: "change_request", category_label: "Change Request", messages: [{ id: "x", sender_role: "organization-admin", sender_name: "<b>Eve</b>", body: evil, created_at: now, read: false }] });
    const { container } = render(<TicketPanel initial={ticket as any} organization={null} />);
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByTestId("message-body").textContent).toBe(evil);
    expect((window as any).__pwned).toBeUndefined();
    expect(screen.getByRole("note").textContent).toContain("nothing was changed automatically");
    // the organization section still names the organization when its record cannot be read
    expect(screen.getByRole("region", { name: "Organization and requester" }).textContent).toContain("Alpha Trading GmbH");
  });
});

describe("idempotency keys over plain http", () => {
  it("work where crypto.randomUUID does not exist (a phone or another PC on the LAN)", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (array: Uint8Array) => real.getRandomValues(array) });
    const keys = new Set(Array.from({ length: 30 }, newIdempotencyKey));
    expect(keys.size).toBe(30);
    for (const key of keys) expect(key).toMatch(/^ui-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
