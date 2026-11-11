// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import SupportIndex from "@/app/support/support-index";
import NewTicketForm from "@/app/support/new/new-ticket-form";
import TicketConversation from "@/app/support/[id]/ticket-conversation";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-07T10:00:00+00:00";
const T1 = "a1111111-1111-4111-8111-aaaaaaaaaaaa";

const summary = (extra: Record<string, unknown> = {}) => ({
  id: T1, ticket_number: "SUP-000001", organization_name: "Alpha", requester_name: "Olivia Owner", subject: "Printer broken", category: "technical_issue", priority: "normal",
  status: "open", created_at: now, updated_at: now, last_reply_at: now, last_message_role: "organization-admin", resolved_at: null, message_count: 1, unread: false, ...extra,
});
const detail = (extra: Record<string, unknown> = {}) => ({
  ...summary(), can_reply: true,
  messages: [{ id: "m1", sender_role: "organization-admin", sender_name: "Olivia Owner", body: "The printer shows E-42.", created_at: now, read: true }], ...extra,
});
const page = (items: any[], extra: Record<string, unknown> = {}) => ({ ok: true as const, items, total: items.length, limit: 20, offset: 0, counts: { open: items.length }, unread: 0, ...extra });
const noFilters = { q: "", status: "" as const, category: "" as const, unread: false, page: 1 };

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

describe("SupportIndex", () => {
  it("shows requests with the new-reply badge and the reply banner; clicking it filters to unread", async () => {
    render(<SupportIndex list={page([summary({ unread: true, status: "waiting_for_customer" }), summary({ id: "x2", ticket_number: "SUP-000002", subject: "Other" })], { unread: 1 })} filters={noFilters} />);
    expect(screen.getByText("SUP-000001")).toBeTruthy();
    expect(screen.getByText("New reply")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Impex Support replied to 1 request");
    await userEvent.click(screen.getByRole("button", { name: "Show it" }));
    expect(router.push).toHaveBeenCalledWith("/support?unread=true");
  });

  it("search, status and category filters become URL parameters and reset the page", async () => {
    render(<SupportIndex list={page([summary()])} filters={{ ...noFilters, page: 3 }} />);
    await userEvent.type(screen.getByPlaceholderText("Ticket number or subject"), "  printer ");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(router.push).toHaveBeenLastCalledWith("/support?q=printer");
    await userEvent.selectOptions(screen.getByLabelText(/^Status/), "open");
    expect(router.push).toHaveBeenLastCalledWith("/support?status=open");
    await userEvent.selectOptions(screen.getByLabelText(/^Category/), "change_request");
    expect(router.push).toHaveBeenLastCalledWith("/support?category=change_request");
  });

  it("paginates and can clear filters", async () => {
    render(<SupportIndex list={{ ...page([summary()]), total: 45, offset: 20 }} filters={{ ...noFilters, status: "open", page: 2 }} />);
    expect(screen.getByText("Showing 21–21 of 45")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(router.push).toHaveBeenLastCalledWith("/support?status=open&page=3");
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(router.push).toHaveBeenLastCalledWith("/support?status=open");
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(router.push).toHaveBeenLastCalledWith("/support");
  });

  it("explains the empty list, an empty filtered list and an unavailable service", () => {
    const { unmount } = render(<SupportIndex list={page([])} filters={noFilters} />);
    expect(screen.getByText("You have not sent any request yet.")).toBeTruthy();
    unmount();
    const second = render(<SupportIndex list={page([])} filters={{ ...noFilters, q: "zzz" }} />);
    expect(screen.getByText("No requests match these filters.")).toBeTruthy();
    second.unmount();
    render(<SupportIndex list={{ ok: false, reason: "unavailable" }} filters={noFilters} />);
    expect(screen.getByRole("alert").textContent).toContain("Nothing was lost");
  });
});

describe("NewTicketForm", () => {
  async function fill(subject = "Printer is broken", message = "It shows E-42.") {
    await userEvent.type(screen.getByLabelText(/^Subject/), subject);
    await userEvent.selectOptions(screen.getByLabelText(/^Category/), "technical_issue");
    await userEvent.type(screen.getByLabelText(/^Message/), message);
  }

  it("checks the required fields before anything is sent", async () => {
    stubFetch(() => json(201, {}));
    render(<NewTicketForm />);
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(screen.getByText("Write a short subject (at least 3 characters).")).toBeTruthy();
    expect(screen.getByText("Choose a category.")).toBeTruthy();
    expect(screen.getByText("Describe your request.")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("shows what a Change Request means before it is sent", async () => {
    render(<NewTicketForm />);
    await userEvent.selectOptions(screen.getByLabelText(/^Category/), "change_request");
    expect(screen.getByRole("note").textContent).toMatch(/Nothing changes automatically/);
  });

  it("sends only subject, category, priority and message, with an Idempotency-Key, then opens the new ticket", async () => {
    stubFetch(() => json(201, { ticket: { id: T1 } }));
    render(<NewTicketForm />);
    await fill();
    await userEvent.selectOptions(screen.getByLabelText(/^Priority/), "high");
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/support/${T1}?sent=1`));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/support/tickets");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body)).toEqual({ subject: "Printer is broken", category: "technical_issue", priority: "high", message: "It shows E-42." });
    expect(keyOf(calls[0])).toBeTruthy();
  });

  it("a double click sends one request", async () => {
    let release: (r: Response) => void = () => undefined;
    stubFetch(() => new Promise<Response>((resolve) => { release = resolve; }));
    render(<NewTicketForm />);
    await fill();
    const button = screen.getByRole("button", { name: "Send request" });
    await userEvent.dblClick(button);
    expect(calls).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Sending…" }) as HTMLButtonElement).disabled).toBe(true);
    release(json(201, { ticket: { id: T1 } }));
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
  });

  it("keeps the same key after a lost connection and takes a new one after a refusal", async () => {
    let step = 0;
    stubFetch(() => {
      step += 1;
      if (step === 1) throw new Error("offline");
      if (step === 2) return json(422, { error: "The subject is too short.", fieldErrors: { subject: "Too short." } });
      return json(201, { ticket: { id: T1 } });
    });
    render(<NewTicketForm />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("Unable to reach the server. Please try again.");
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("The subject is too short.");
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(keyOf(calls[1])).toBe(keyOf(calls[0])); // a lost connection is retried as the same request
    expect(keyOf(calls[2])).not.toBe(keyOf(calls[1])); // a refused one was not accepted: new attempt, new key
  });

  it("sends the person to sign in again when the session has ended", async () => {
    stubFetch(() => json(401, { error: "Session expired." }));
    render(<NewTicketForm />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });
});

describe("TicketConversation", () => {
  it("shows the messages and sends a reply, with the answer shown immediately", async () => {
    const after = detail({
      status: "open",
      messages: [
        { id: "m1", sender_role: "organization-admin", sender_name: "Olivia Owner", body: "The printer shows E-42.", created_at: now, read: true },
        { id: "m2", sender_role: "organization-admin", sender_name: "Olivia Owner", body: "Still broken.", created_at: now, read: true },
      ],
    });
    stubFetch(() => json(201, { ticket: after, replayed: false }));
    render(<TicketConversation ticket={detail() as any} />);
    expect(screen.getByText("The printer shows E-42.")).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/^Your reply/), "Still broken.");
    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await screen.findByText("Message sent.");
    expect(calls[0].url).toBe(`/api/support/tickets/${T1}/messages`);
    expect(JSON.parse(calls[0].init.body)).toEqual({ body: "Still broken." });
    expect(keyOf(calls[0])).toBeTruthy();
    expect(screen.getByText("Still broken.", { selector: "[data-testid=message-body]" })).toBeTruthy();
    expect((screen.getByLabelText(/^Your reply/) as HTMLTextAreaElement).value).toBe("");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("refuses an empty reply and a double click sends once", async () => {
    let release: (r: Response) => void = () => undefined;
    stubFetch(() => new Promise<Response>((resolve) => { release = resolve; }));
    render(<TicketConversation ticket={detail() as any} />);
    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(screen.getByText("Write your message.")).toBeTruthy();
    expect(calls).toHaveLength(0);
    await userEvent.type(screen.getByLabelText(/^Your reply/), "Hello");
    await userEvent.dblClick(screen.getByRole("button", { name: "Send reply" }));
    expect(calls).toHaveLength(1);
    release(json(201, { ticket: detail(), replayed: false }));
    await screen.findByText("Message sent.");
  });

  it("shows a refusal and keeps the text so nothing typed is lost", async () => {
    stubFetch(() => json(429, { error: "Too many messages. Please wait a moment." }));
    render(<TicketConversation ticket={detail() as any} />);
    await userEvent.type(screen.getByLabelText(/^Your reply/), "Keep me");
    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await screen.findByText("Too many messages. Please wait a moment.");
    expect((screen.getByLabelText(/^Your reply/) as HTMLTextAreaElement).value).toBe("Keep me");
  });

  it("renders markup in messages as text and never as live elements", () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    const ticket = detail({ messages: [{ id: "x", sender_role: "super-admin", sender_name: "<b>staff</b>", body: evil, created_at: now, read: true }] });
    const { container } = render(<TicketConversation ticket={ticket as any} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByTestId("message-body").textContent).toBe(evil);
    expect((window as any).__pwned).toBeUndefined();
  });

  it("a closed ticket has no reply form and points to a new request", () => {
    render(<TicketConversation ticket={detail({ status: "closed", can_reply: false }) as any} />);
    expect(screen.queryByRole("button", { name: "Send reply" })).toBeNull();
    expect(screen.getByRole("note").textContent).toContain("This request is closed");
    expect(screen.getByRole("link", { name: "send a new request" }).getAttribute("href")).toBe("/support/new");
  });

  it("tells the customer when the team is waiting for them, and when it was just sent", () => {
    const { unmount } = render(<TicketConversation ticket={detail({ status: "waiting_for_customer" }) as any} />);
    expect(screen.getByText("Impex Support is waiting for your answer.")).toBeTruthy();
    unmount();
    render(<TicketConversation ticket={detail() as any} justSent />);
    expect(screen.getByRole("status").textContent).toContain("Your request SUP-000001 was sent to the Impex team");
  });
});

describe("deleting a request from my side", () => {
  beforeEach(() => { vi.stubGlobal("confirm", () => true); });

  it("the bin on the list asks first, says it is not unsent, hides it from my list only and refreshes", async () => {
    let asked = "";
    vi.stubGlobal("confirm", (message: string) => { asked = message; return true; });
    stubFetch(() => json(200, { ok: true }));
    render(<SupportIndex list={page([summary()])} filters={noFilters} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete SUP-000001 from my list" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe(`/api/support/tickets/${T1}/hide`);
    expect(calls[0].init.method).toBe("POST");
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(asked).toContain("not unsent");
  });

  it("answering No changes nothing", async () => {
    vi.stubGlobal("confirm", () => false);
    stubFetch(() => json(200, {}));
    render(<SupportIndex list={page([summary()])} filters={noFilters} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete SUP-000001 from my list" }));
    expect(calls).toHaveLength(0);
  });

  it("a refusal is shown and the list stays", async () => {
    stubFetch(() => json(404, { error: "Ticket not found." }));
    render(<SupportIndex list={page([summary()])} filters={noFilters} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete SUP-000001 from my list" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Ticket not found.");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("the open request has the same bin and takes you back to the list", async () => {
    stubFetch(() => json(200, { ok: true }));
    render(<TicketConversation ticket={detail() as any} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete this request from my list" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/support"));
    expect(calls[0].url).toBe(`/api/support/tickets/${T1}/hide`);
  });
});
