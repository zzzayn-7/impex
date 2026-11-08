// @vitest-environment jsdom
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

import PortalShell from "@/components/portal-shell";
import { NAV_ITEMS } from "@/lib/portal-nav";
import { superAdmin } from "./helpers";

afterEach(cleanup);

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf-8");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(tsx?|css)$/.test(name) ? [full] : [];
  });

const shell = (current: "dashboard" | "organizations" | "support" = "dashboard", unread = 0) =>
  render(<PortalShell user={superAdmin as any} current={current} supportUnread={unread}><p>PAGE BODY</p></PortalShell>);

describe("the Super Admin shell", () => {
  it("is the portal's atmosphere (.ix-dash) with ONE navigation, ONE header and the page inside <main>", () => {
    const { container } = shell();
    expect(container.querySelector(".ix-dash")).toBeTruthy();
    expect(screen.getAllByRole("navigation", { name: "Main" })).toHaveLength(1);
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(within(screen.getByRole("main")).getByText("PAGE BODY")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("offers the Super Admin destinations only: no organization-portal (tenant) navigation", () => {
    shell();
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")]);
    expect(links).toEqual([["Dashboard", "/"], ["Organizations", "/organizations"], ["Support Inbox", "/support"]]);
    expect(NAV_ITEMS).toHaveLength(3);
    for (const tenant of ["Inventory", "Invoices", "Purchase", "Finance", "Products"]) expect(nav.textContent).not.toContain(tenant);
  });

  it("marks the current destination with aria-current and a pale-yellow indicator", () => {
    shell("organizations");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const current = within(nav).getByRole("link", { name: "Organizations" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.className).toContain("bg-ix-butter/10");
    expect(current.querySelector("span.bg-ix-butter")).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBeNull();
  });

  it("is a 76px icon rail that grows to 256px on hover or focus WITHOUT moving the page, and a drawer below lg", () => {
    const { container } = shell();
    const aside = container.querySelector("aside#sa-sidebar")!;
    for (const cls of ["lg:w-[76px]", "lg:hover:w-[256px]", "lg:focus-within:w-[256px]", "lg:data-[pinned=true]:w-[256px]", "fixed"]) expect(aside.className, cls).toContain(cls);
    expect(aside.className).toContain("max-lg:invisible"); // closed drawer is unreachable by Tab
    expect(container.querySelector("main")!.parentElement!.className).toContain("lg:pl-[104px]"); // constant: the rail overlays, never pushes
  });

  it("every link keeps its label in the DOM while the rail is collapsed (accessible name) and has no native title tooltip", () => {
    shell();
    for (const link of within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link")) {
      expect(link.textContent!.trim().length).toBeGreaterThan(0);
      expect(link.getAttribute("title")).toBeNull();
    }
  });

  it("opens and closes the mobile drawer with the menu button and Escape, and the toggle pins the rail", () => {
    const { container } = shell();
    const aside = container.querySelector("aside#sa-sidebar")!;
    const menu = screen.getByRole("button", { name: "Open navigation" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(menu);
    expect(aside.getAttribute("data-mobile-open")).toBe("true");
    expect(screen.getAllByRole("button", { name: "Close navigation" }).length).toBeGreaterThan(0);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(aside.getAttribute("data-mobile-open")).toBe("false");

    const pin = screen.getByRole("button", { name: "Expand navigation" });
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pin);
    expect(aside.getAttribute("data-pinned")).toBe("true");
    expect(screen.getByRole("button", { name: "Collapse navigation" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows unread support tickets as a count (capped at 99+) and a quiet dot on the collapsed rail; nothing at zero", () => {
    const { container, unmount } = shell("support", 3);
    expect(container.querySelector('[aria-label="3 unread"]')!.textContent).toBe("3");
    unmount();
    shell("support", 250);
    expect(screen.getByText("99+")).toBeTruthy();
    cleanup();
    const { container: none } = shell("support", 0);
    expect(none.innerHTML).not.toContain("unread");
  });

  it("the header names the signed-in Super Admin (visible on larger screens, read by screen readers on small ones)", () => {
    shell();
    expect(screen.getByText("Root Admin")).toBeTruthy();
    expect(screen.getByText("root@impex.example")).toBeTruthy();
  });
});

describe("the Super Admin Portal uses the shared theme: ONE pale butter yellow accent", () => {
  const css = read("src/app/globals.css");
  const tailwind = read("tailwind.config.ts");

  it("defines the same tokens as the Organization Portal", () => {
    for (const token of [/--ix-accent:\s*#e8d8a4/i, /--ix-accent-hover:\s*#f0e4b8/i, /--ix-accent-rgb:\s*232 216 164/, /--ix-on-accent:\s*#172a32/i, /--ix-deep:\s*#172a32/i, /--ix-slate:\s*#324d58/i,
      /--ix-teal:\s*#568e8f/i, /--ix-text:\s*#edf4f1/i, /--ix-muted:\s*#b5cbc9/i, /--ix-radius-lg:\s*22px/, /--ix-radius-xl:\s*24px/, /--ix-dur-fast/]) expect(css).toMatch(token);
    for (const hex of ["#E8D8A4", "#172A32", "#324D58", "#568E8F", "#EDF4F1", "#B5CBC9"]) expect(tailwind.toUpperCase()).toContain(hex);
  });

  it("has no powder blue, mint, or other decorative accent colour left", () => {
    for (const gone of ["#96c5b8", "#a7c7d8", "#86b6aa", "accent-mint", "accent-blue", "data-section"]) expect(css.toLowerCase()).not.toContain(gone);
    expect(tailwind).toMatch(/indigo: butter/);
    expect(tailwind).toMatch(/emerald: butter/);
    for (const family of ["sky", "violet", "teal"]) expect(tailwind).toMatch(new RegExp(`${family}: mist`));
  });

  it("applies the glass skin to every Super Admin page (all authenticated pages are inside the shell; login and activation are .ix-dash too)", () => {
    for (const page of ["src/app/login/page.tsx", "src/app/activate/page.tsx", "src/app/support/loading.tsx"]) expect(read(page), page).toContain("ix-dash");
    for (const page of ["src/app/page.tsx", "src/app/organizations/page.tsx", "src/app/organizations/[id]/modules/page.tsx", "src/app/support/page.tsx", "src/app/support/[id]/page.tsx"]) {
      expect(read(page), page).toContain("PortalShell");
      expect(read(page), page).not.toContain("portal-header");
    }
  });

  it("no source file in the portal asks for sky / violet / teal / cyan / purple / pink / blue / green / orange colours by name", () => {
    const offenders = walk(join(root, "src")).filter((f) => !f.endsWith("globals.css")).filter((f) => /\b(?:bg|text|border|ring|from|to|via)-(?:cyan|blue|purple|pink|fuchsia|lime|green|orange|yellow|rose)-\d{2,3}/.test(readFileSync(f, "utf-8")));
    expect(offenders).toEqual([]);
  });

  it("module switches are real switches with a visible On/Off label (state is never colour alone)", () => {
    expect(css).toMatch(/input\[type="checkbox"\]\[role="switch"\][^{]*\{[^}]*appearance:\s*none/);
    expect(read("src/app/organizations/[id]/modules/module-manager.tsx")).toContain('(on ? "On" : "Off")');
  });

  it("printing stays black on white with no glass", () => {
    const printBlock = css.slice(css.lastIndexOf("@media print"));
    expect(printBlock).toMatch(/\.ix-dash::before\s*\{\s*display:\s*none/);
    expect(printBlock).toMatch(/backdrop-filter:\s*none\s*!important/);
  });

  // The two portals keep their own copies of the theme (no shared package). Where both are checked out together they must not drift apart.
  const sibling = join(root, "..", "dashboard");
  it.skipIf(!existsSync(join(sibling, "src/app/globals.css")))("globals.css and tailwind.config.ts are identical in both portals", () => {
    expect(css).toBe(readFileSync(join(sibling, "src/app/globals.css"), "utf-8"));
    expect(tailwind).toBe(readFileSync(join(sibling, "tailwind.config.ts"), "utf-8"));
    expect(read("src/components/ui/tooltip.tsx")).toBe(readFileSync(join(sibling, "src/components/ui/tooltip.tsx"), "utf-8"));
  });
});
