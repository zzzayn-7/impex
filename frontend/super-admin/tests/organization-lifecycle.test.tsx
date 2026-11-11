// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar: Record<string, string> = {};
const refresh = vi.fn();
const replace = vi.fn();
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); }, useRouter: () => ({ refresh, replace, push: vi.fn() }), usePathname: () => "/organizations" }));

import { POST as lockRoute } from "@/app/api/organizations/[id]/lock/route";
import { POST as unlockRoute } from "@/app/api/organizations/[id]/unlock/route";
import { POST as deleteRoute } from "@/app/api/organizations/[id]/delete/route";
import OrganizationActions from "@/app/organizations/organization-actions";

// Lock / unlock / delete an organization, from the Super Admin portal. The Organization Service decides (and records who did it); these routes forward only what is needed.

const ORG = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
let answer: (call: Call) => Response | null = () => json(200, {});
function stub(fn: (call: Call) => Response | null) {
  calls = [];
  answer = fn;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const response = answer(call);
    if (response === null) throw new Error("connection refused");
    return response;
  }));
}
const req = (url: string, body?: unknown) => new NextRequest(`http://localhost:3000${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id = ORG) => ({ params: { id } });

beforeEach(() => {
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  for (const key of Object.keys(jar)) delete jar[key];
  jar.impex_session = "token-super";
  refresh.mockClear();
  replace.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the lock and unlock routes", () => {
  it("lock forwards only the note, with the session token, and returns the organization", async () => {
    stub(() => json(200, { id: ORG, is_locked: true }));
    const res = await lockRoute(req(`/api/organizations/${ORG}/lock`, { reason: "  October invoice unpaid  ", is_locked: false, organization_id: "other", modules: [] }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organization: { id: ORG, is_locked: true } });
    expect(calls[0]).toMatchObject({ url: `http://organization-service:8001/api/v1/organizations/${ORG}/lock`, method: "POST", body: { reason: "October invoice unpaid" } });
    expect(calls[0].headers.Authorization).toBe("Bearer token-super");
  });

  it("unlock sends nothing from the browser", async () => {
    stub(() => json(200, { id: ORG, is_locked: false }));
    expect((await unlockRoute(req(`/api/organizations/${ORG}/unlock`, { is_locked: true }), ctx())).status).toBe(200);
    expect(calls[0]).toMatchObject({ url: `http://organization-service:8001/api/v1/organizations/${ORG}/unlock`, method: "POST", body: undefined });
  });

  it.each([["lock", lockRoute], ["unlock", unlockRoute]] as const)("%s needs a session and a real id, and never calls the service otherwise", async (_name, route) => {
    stub(() => json(200, {}));
    expect((await route(req("/x", {}), ctx("not-a-uuid"))).status).toBe(404);
    delete jar.impex_session;
    expect((await route(req("/x", {}), ctx())).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("maps the service's answers to plain messages", async () => {
    for (const [status, expected] of [[401, 401], [403, 403], [404, 404], [409, 409], [500, 502]] as const) {
      stub(() => json(status, { detail: status === 409 ? { code: "deletion_pending", message: "This organization is being deleted." } : "x" }));
      const res = await unlockRoute(req("/x"), ctx());
      expect(res.status).toBe(expected);
      if (status === 409) expect((await res.json()).error).toBe("This organization is being deleted.");
    }
    stub(() => null);
    expect((await lockRoute(req("/x", {}), ctx())).status).toBe(503);
  });
});

describe("the delete route", () => {
  it("needs the typed name, forwards only that, and reports what was removed", async () => {
    stub(() => json(200, { deleted: true, name: "Alpha Trading", organization_id: ORG, purged: { sales: { invoices: 3 } } }));
    expect((await deleteRoute(req("/x", {}), ctx())).status).toBe(400);
    expect((await deleteRoute(req("/x", { confirm_name: "   " }), ctx())).status).toBe(400);
    expect(calls).toHaveLength(0);
    const res = await deleteRoute(req("/x", { confirm_name: "Alpha Trading", force: true, organization_id: "other" }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, name: "Alpha Trading", purged: { sales: { invoices: 3 } } });
    expect(calls[0].body).toEqual({ confirm_name: "Alpha Trading" });
    expect(calls[0].url).toBe(`http://organization-service:8001/api/v1/organizations/${ORG}/delete`);
  });

  it("shows why a deletion did not finish (and that it can be run again), and a wrong name", async () => {
    stub(() => json(502, { detail: { code: "deletion_failed", service: "sales", message: "The organization was not deleted: the sales service could not delete its data. Run the deletion again to continue." } }));
    const failed = await deleteRoute(req("/x", { confirm_name: "Alpha Trading" }), ctx());
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: "deletion_failed", service: "sales", error: expect.stringContaining("Run the deletion again") });
    stub(() => json(422, { detail: { code: "confirmation_mismatch", message: "Type the organization's exact name to confirm the deletion." } }));
    const wrong = await deleteRoute(req("/x", { confirm_name: "alpha" }), ctx());
    expect(wrong.status).toBe(422);
    expect((await wrong.json()).code).toBe("confirmation_mismatch");
  });

  it("needs a session and a real id", async () => {
    stub(() => json(200, {}));
    expect((await deleteRoute(req("/x", { confirm_name: "A" }), ctx("nope"))).status).toBe(404);
    delete jar.impex_session;
    expect((await deleteRoute(req("/x", { confirm_name: "A" }), ctx())).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("the Lock / Unlock / Delete buttons of an organization", () => {
  const org = (over: Partial<{ isLocked: boolean; deletionPending: boolean }> = {}) => render(<OrganizationActions organization={{ id: ORG, name: "Alpha Trading", isLocked: false, deletionPending: false, ...over }} />);

  it("shows Lock and Delete for an unlocked organization, Unlock and Delete for a locked one, and Finish deleting when a deletion was left half done", () => {
    const { unmount } = org();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Lock", "Delete"]);
    unmount();
    const second = org({ isLocked: true });
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Unlock", "Delete"]);
    second.unmount();
    org({ isLocked: true, deletionPending: true });
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Finish deleting"]); // it cannot be unlocked while a deletion is pending
  });

  it("locking explains the effect, takes an optional note, and posts it", async () => {
    stub(() => json(200, { organization: {} }));
    const { container } = org();
    await userEvent.click(screen.getByRole("button", { name: "Lock" }));
    const dialog = screen.getByRole("dialog");
    expect(container.contains(dialog)).toBe(false); // drawn in the page itself, not inside the table (a panel with a backdrop filter would otherwise confine "fixed")
    expect(dialog.textContent).toContain("only use Settings and Help & Support");
    expect(dialog.textContent).toContain("Nothing is deleted");
    await userEvent.type(within(dialog).getByRole("textbox"), "October invoice unpaid");
    await userEvent.click(within(dialog).getByRole("button", { name: "Lock access" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({ url: `/api/organizations/${ORG}/lock`, method: "POST", body: { reason: "October invoice unpaid" } });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Alpha Trading is locked.");
  });

  it("unlocking asks once and posts", async () => {
    stub(() => json(200, { organization: {} }));
    org({ isLocked: true });
    await userEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({ url: `/api/organizations/${ORG}/unlock`, method: "POST" });
  });

  it("deleting lists everything that goes, and the button stays off until the exact name is typed", async () => {
    stub(() => json(200, { deleted: true }));
    org();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    for (const text of ["products, stock and every stock movement", "invoices and payments", "finance accounts", "Help & Support tickets", "administrators' accounts", "cannot be recovered"]) expect(dialog.textContent, text).toContain(text);
    const confirm = within(dialog).getByRole("button", { name: "Delete permanently" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const input = within(dialog).getByRole("textbox");
    await userEvent.type(input, "alpha trading");
    expect(confirm.disabled).toBe(true); // not the exact name
    await userEvent.clear(input);
    await userEvent.type(input, "Alpha Trading");
    expect(confirm.disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({ url: `/api/organizations/${ORG}/delete`, method: "POST", body: { confirm_name: "Alpha Trading" } });
    expect(screen.getByRole("status").textContent).toBe("Alpha Trading was deleted.");
  });

  it("a deletion that did not finish says why and stays open so it can be run again", async () => {
    stub(() => json(502, { error: "The organization was not deleted: the sales service could not delete its data. Run the deletion again to continue." }));
    org();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox"), "Alpha Trading");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Run the deletion again");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("Cancel and Escape close a dialog without calling anything; an expired session goes to sign-in", async () => {
    stub(() => json(401, {}));
    org();
    await userEvent.click(screen.getByRole("button", { name: "Lock" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Lock" }));
    await userEvent.click(screen.getByRole("button", { name: "Lock access" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });
});
