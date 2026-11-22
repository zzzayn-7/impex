// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace, push: vi.fn() }), usePathname: () => "/organizations" }));

import AdministratorActions from "@/app/organizations/administrator-actions";

// Organizations > an administrator > Reset password: for an administrator who has activated their account and forgot the password.

const ORG = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const ID = "9a1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f7";
const admin = (status: "pending" | "active" | "expired" = "active") => ({ id: ID, organizationId: ORG, email: "ada@example.org", fullName: "Ada Lovelace", status });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const user = () => userEvent.setup();

beforeEach(() => { refresh.mockReset(); replace.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Reset password", () => {
  it("is offered for an administrator who has activated their account, and only then", () => {
    render(<AdministratorActions admin={admin("active")} demoMode={false} />);
    expect(screen.getByRole("button", { name: "Reset password of ada@example.org" })).toBeTruthy();
    cleanup();
    for (const status of ["pending", "expired"] as const) {
      render(<AdministratorActions admin={admin(status)} demoMode={false} />);
      expect(screen.queryByRole("button", { name: /Reset password/ }), status).toBeNull(); // no password yet: Resend invitation is the way
      cleanup();
    }
  });

  it("asks first, saying what it does, and Cancel sends nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<AdministratorActions admin={admin()} demoMode={false} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Reset password of ada@example.org" }));
    const text = document.body.textContent ?? "";
    expect(text).toContain("ada@example.org");
    expect(text).toContain("current password stops working");
    expect(text).toContain("temporary");
    expect(text).toContain("choose their own");
    await u.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reset password of ada@example.org" })).toBeTruthy();
  });

  it("sends only the organization (the id is in the address), then says where the password went", async () => {
    const calls: { url: string; method: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => { calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) }); return json(200, { sentTo: "ada@example.org", expiresAt: "2026-11-23T10:00:00+00:00" }); }));
    render(<AdministratorActions admin={admin()} demoMode={false} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Reset password of ada@example.org" }));
    await u.click(screen.getByRole("button", { name: "Send new password" }));
    expect((await screen.findByRole("status")).textContent).toContain("A new temporary password was emailed to ada@example.org");
    expect(screen.getByRole("status").textContent).toContain("24 hours");
    expect(calls).toEqual([{ url: `/api/administrators/${ID}/reset-password`, method: "POST", body: { organizationId: ORG } }]);
    expect(document.body.textContent).not.toMatch(/Password:|Temp0/);
  });

  it("says why when it cannot be done (too soon, the email failed) and lets the Super Admin try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(429, { error: "A new password was sent a moment ago. Wait 42 seconds before sending another." })));
    render(<AdministratorActions admin={admin()} demoMode={false} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Reset password of ada@example.org" }));
    await u.click(screen.getByRole("button", { name: "Send new password" }));
    expect((await screen.findByRole("alert")).textContent).toContain("42 seconds");
    expect((screen.getByRole("button", { name: "Send new password" }) as HTMLButtonElement).disabled).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => json(502, { error: "The new password was set but the email could not be sent (x). Press Reset password again in a minute." })));
    await u.click(screen.getByRole("button", { name: "Send new password" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be sent"));
  });

  it("a double click sends one request, and an ended session goes to the login page", async () => {
    let finish: (r: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AdministratorActions admin={admin()} demoMode={false} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Reset password of ada@example.org" }));
    const send = screen.getByRole("button", { name: "Send new password" });
    await u.dblClick(send);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(json(401, { error: "x" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });
});
