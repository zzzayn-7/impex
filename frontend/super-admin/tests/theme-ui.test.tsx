// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

import PortalShell from "@/components/portal-shell";
import { forgetSavedTheme } from "@/components/theme/theme-provider";
import { ACCENTS, BACKGROUNDS, type ThemeChoice } from "@/lib/theme";
import { superAdmin } from "./helpers";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: Array<{ url: string; method: string; body: any }>;
const html = () => document.documentElement;
const painted = () => ({ bg: html().getAttribute("data-ix-bg"), accent: html().getAttribute("data-ix-accent"), scheme: html().getAttribute("data-ix-scheme") });

beforeEach(() => {
  forgetSavedTheme();
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const call = { url: String(input), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return json(200, { theme: call.body });
  }));
  for (const name of ["data-ix-bg", "data-ix-accent", "data-ix-scheme"]) html().removeAttribute(name);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const shell = (saved?: ThemeChoice) => render(
  <PortalShell user={{ ...superAdmin, theme_background: saved?.background ?? null, theme_accent: saved?.accent ?? null } as any} current="organizations"><p>PAGE BODY</p></PortalShell>,
);

describe("the Super Admin Portal's theme customization", () => {
  it("has the palette button beside the profile picture, named 'Customize Theme', with a tooltip; the header is otherwise unchanged", async () => {
    const user = userEvent.setup();
    shell();
    const header = screen.getByRole("banner");
    expect(within(header).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Open navigation", "Customize Theme", expect.stringMatching(/^Account: /), null, "Sign out"]); // null: the "Appearance" entry inside the avatar's card
    expect(within(header).getByRole("heading", { level: 1 }).textContent).toBe("Organizations");
    await user.hover(within(header).getByRole("button", { name: "Customize Theme" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Customize Theme");
  });

  it("paints the Super Admin's own saved theme, and the default when none was chosen", () => {
    shell({ background: "burgundy", accent: "champagne-gold" });
    expect(painted()).toEqual({ bg: "burgundy", accent: "champagne-gold", scheme: "dark" });
    cleanup();
    shell();
    expect(painted()).toEqual({ bg: "original", accent: "pale-butter", scheme: "dark" });
  });

  it("opens the same customizer (5 + 1 backgrounds, 8 accents, preview, Apply / Cancel / Reset) and saves through this portal's route", async () => {
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByRole("button", { name: "Customize Theme" }));
    const panel = screen.getByRole("dialog", { name: "Customize Appearance" });
    expect(within(panel).getAllByRole("radio")).toHaveLength(BACKGROUNDS.length + ACCENTS.length);
    await user.click(within(panel).getByRole("radio", { name: /Ice/ }));
    await user.click(within(panel).getByRole("radio", { name: /Muted Copper/ }));
    expect(painted()).toEqual({ bg: "ice", accent: "muted-copper", scheme: "light" });
    await user.click(within(panel).getByRole("button", { name: "Apply Theme" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toEqual([{ url: "/api/theme", method: "PUT", body: { background: "ice", accent: "muted-copper" } }]);
    expect((await screen.findByRole("status")).textContent).toContain("Theme saved.");
  });

  it("Cancel restores the saved theme", async () => {
    const user = userEvent.setup();
    shell({ background: "graphite", accent: "frost-blue" });
    await user.click(screen.getByRole("button", { name: "Customize Theme" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("radio", { name: /Burgundy/ }));
    expect(painted().bg).toBe("burgundy");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(painted()).toEqual({ bg: "graphite", accent: "frost-blue", scheme: "dark" });
    expect(calls).toEqual([]);
  });

  it("the profile card offers 'Appearance' (the Super Admin Portal has no Settings page), which opens the same customizer", async () => {
    const user = userEvent.setup();
    shell();
    const card = screen.getByRole("group", { name: "Account details", hidden: true });
    const entry = within(card).getByRole("button", { name: /Appearance/, hidden: true });
    expect(entry.textContent).toContain("Customize Theme");
    fireEvent.pointerEnter(card.parentElement!);
    await user.click(entry);
    expect(screen.getByRole("dialog", { name: "Customize Appearance" })).toBeTruthy();
  });

  it("no Settings module was added: the navigation is exactly what it was", () => {
    shell();
    const links = within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")]);
    expect(links).toEqual([["Dashboard", "/"], ["Organizations", "/organizations"], ["Support Inbox", "/support"]]);
  });
});
