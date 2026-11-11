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

  it("marks the current destination with aria-current and a pale-yellow pill and the small bar on the rail's left edge, with the icon centred in the pill", () => {
    shell("organizations");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const current = within(nav).getByRole("link", { name: "Organizations" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.className).toContain("bg-ix-accent-text/10");
    expect(current.querySelector("span.bg-ix-accent-text")).toBeTruthy();
    expect(current.querySelector("span.grid")!.className).toContain("w-[50px]"); // exactly the collapsed pill's width, so the icon is dead centre
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

  it("the header names the page in big bold type; on the right only the avatar (its card names the Super Admin) and the red Sign out icon", () => {
    shell("organizations");
    const header = screen.getByRole("banner");
    const title = within(header).getByRole("heading", { level: 1, name: "Organizations" });
    expect(title.className).toContain("font-bold");
    expect(within(header).queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    const card = within(header).getByRole("group", { name: "Account details", hidden: true });
    expect(card.className).toContain("invisible");
    for (const text of ["Root Admin", "root@impex.example", "Super Admin"]) expect(within(card).getAllByText(text).length, text).toBeGreaterThan(0);
    expect(within(card).getByText("User ID :")).toBeTruthy();
    const signOut = within(header).getByRole("button", { name: "Sign out" });
    expect(signOut.textContent).toBe("");
    expect(signOut.className).toContain("text-red-400");
    expect(within(header).getByRole("button", { name: /^Account: / }).textContent).toBe("RA");
  });

  it("each page's name is preceded by its own yellow icon (the one its sidebar entry uses)", () => {
    for (const key of ["dashboard", "organizations", "support"] as const) {
      const { unmount } = shell(key);
      const heading = within(screen.getByRole("banner")).getByRole("heading", { level: 1 });
      const icon = heading.parentElement!.querySelector("svg")!;
      expect(icon.getAttribute("class"), key).toContain("text-ix-accent-text");
      expect(!!(icon.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING), key).toBe(true);
      const link = within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link").find((l) => l.getAttribute("href") === NAV_ITEMS.find((i) => i.key === key)!.href)!;
      const paths = (el: Element) => [...el.querySelectorAll("path")].map((p) => p.getAttribute("d")).join("|");
      expect(paths(icon), key).toBe(paths(link.querySelector("svg")!)); // the same drawing as the sidebar
      unmount();
    }
  });

  it("clicking the avatar opens the card (hovering only blurs it), and Escape or a click elsewhere closes it", () => {
    shell();
    const avatar = screen.getByRole("button", { name: /^Account: / });
    const card = screen.getByRole("group", { name: "Account details", hidden: true });
    fireEvent.pointerEnter(avatar.parentElement!);
    fireEvent.focus(avatar);
    expect(card.className).toContain("invisible"); // neither hovering nor focusing opens it
    fireEvent.click(avatar);
    expect(card.className).not.toContain("invisible");
    fireEvent.pointerLeave(avatar.parentElement!);
    expect(card.className).not.toContain("invisible"); // and moving away does not close it
    fireEvent.keyDown(document, { key: "Escape" });
    expect(card.className).toContain("invisible");
    fireEvent.click(avatar);
    fireEvent.mouseDown(document.body);
    expect(card.className).toContain("invisible");
  });
});

describe("the Super Admin Portal uses the shared theme: ONE pale butter yellow accent", () => {
  const css = read("src/app/globals.css");
  const tailwind = read("tailwind.config.ts");

  it("defines the same tokens as the Organization Portal", () => {
    // the DEFAULT theme (original slate-teal + Pale Butter Yellow), as tokens on :root: the same values the Organization Portal has
    for (const token of [/--ix-accent-rgb:\s*232 216 164/, /--ix-accent-hover-rgb:\s*240 228 184/, /--ix-on-accent-rgb:\s*23 42 50/, /--ix-deep-rgb:\s*23 42 50/, /--ix-slate-rgb:\s*50 77 88/,
      /--ix-teal-rgb:\s*86 142 143/, /--ix-text-rgb:\s*237 244 241/, /--ix-muted-rgb:\s*181 203 201/, /--ix-radius-lg:\s*22px/, /--ix-radius-xl:\s*24px/, /--ix-dur-fast/]) expect(css).toMatch(token);
    // Tailwind holds no colour of its own: every colour is a variable, and the palettes live in lib/theme.ts
    expect(tailwind).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    for (const hex of ["#E8D8A4", "#172A32", "#35232E", "#E7F0F4", "#252B30", "#292938", "#202F3C"]) expect(read("src/lib/theme.ts").toUpperCase()).toContain(hex);
  });

  it("has no powder blue, mint, or other decorative accent colour left", () => {
    for (const gone of ["#96c5b8", "#a7c7d8", "#86b6aa", "accent-mint", "accent-blue", "data-section"]) expect(css.toLowerCase()).not.toContain(gone);
    expect(tailwind).toMatch(/indigo: ramp\("accent"\)/);
    expect(tailwind).toMatch(/emerald: ramp\("accent"\)/);
    for (const family of ["sky", "violet", "teal"]) expect(tailwind).toMatch(new RegExp(`${family}: ramp\\("mist"\\)`));
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

  it("text boxes, dropdowns and buttons share one 2.5rem control height (a box inside a table cell stays compact)", () => {
    expect(css).toMatch(/input\[type="search"\][^{]*:not\(td \*, th \*\)\s*\{\s*min-height:\s*2\.5rem/);
    expect(css).toMatch(/select:not\(\[multiple\]\):not\(\[size\]\)\s*\{[^}]*min-height:\s*2\.5rem/);
  });

  it("printing stays black on white with no glass", () => {
    const printBlock = css.slice(css.lastIndexOf("@media print"));
    expect(printBlock).toMatch(/\.ix-dash::before\s*\{\s*display:\s*none/);
    expect(printBlock).toMatch(/backdrop-filter:\s*none\s*!important/);
  });

  // The two portals keep their own copies of the SHARED theme (no shared package): globals.css, tailwind.config.ts and the tooltip must be identical,
  // wherever both folders are checked out together. Styling that belongs to ONE application (for example the Organization Portal's quantity selector)
  // does not go into globals.css: it lives in a stylesheet next to its component, so it can never make the shared files differ.
  const sibling = join(root, "..", "dashboard");
  const both = existsSync(join(sibling, "src/app/globals.css"));
  const other = (p: string) => readFileSync(join(sibling, p), "utf-8");

  it.skipIf(!both)("globals.css is identical in both portals (shared theme only: tokens, glass, fields, menus, print)", () => {
    expect(css, "frontend/super-admin/src/app/globals.css and frontend/dashboard/src/app/globals.css must be the same file. If a rule belongs to ONE portal's own component, put it in a stylesheet next to that component instead.").toBe(other("src/app/globals.css"));
  });

  it.skipIf(!both)("tailwind.config.ts and the tooltip are identical in both portals", () => {
    expect(tailwind).toBe(other("tailwind.config.ts"));
    expect(read("src/components/ui/tooltip.tsx")).toBe(other("src/components/ui/tooltip.tsx"));
    expect(read("src/components/profile-menu.tsx")).toBe(other("src/components/profile-menu.tsx")); // the header's avatar card
    // the runtime theme: palettes, customizer, provider and header button are identical copies too (each portal keeps only its own cookie name and routes)
    for (const file of ["src/lib/theme.ts", "src/components/theme/theme-provider.tsx", "src/components/theme/theme-customizer.tsx", "src/components/theme/theme-button.tsx"]) expect(read(file), file).toBe(other(file));
    expect(read("src/lib/session.ts")).toContain('THEME_COOKIE = "impex_theme"');
    expect(other("src/lib/session.ts")).toContain('THEME_COOKIE = "impex_tenant_theme"'); // never shared: cookies ignore ports
  });

  it.skipIf(!both)("the home-page customization (rules, components and stylesheet) is an identical copy in both portals; each portal keeps only its own widget registry and route", () => {
    const files = ["src/lib/dashboard-layout.ts", ...["add-widgets-panel.tsx", "dashboard-layout.css", "dashboard-widget.tsx", "layout-editor.tsx", "layout-provider.tsx", "layout-storage.ts", "widget-context-menu.tsx", "widget-icons.tsx"].map((f) => `src/components/dashboard-layout/${f}`)];
    for (const file of files) expect(read(file), file).toBe(other(file));
    expect(read("src/lib/dashboard-widgets.ts")).toContain("admin.kpi.active-tenants");
    expect(other("src/lib/dashboard-widgets.ts")).toContain("org.overview"); // never shared: each portal has its own widgets
    expect(read("src/lib/dashboard-widgets.ts")).not.toContain("org.overview");
    expect(other("src/lib/dashboard-widgets.ts")).not.toContain("admin.kpi");
  });

  it.skipIf(!both)("application-specific styling stays out of the shared stylesheet, and in its own file it only uses the shared tokens", () => {
    expect(css).not.toContain(".ix-qty"); // the Organization Portal's quantity selector
    const own = other("src/components/ui/quantity-input.css");
    expect(own).toContain(".ix-qty");
    const used = Array.from(new Set(Array.from(own.matchAll(/var\((--ix-[a-z0-9-]+)/g), (m) => m[1])));
    expect(used.length).toBeGreaterThan(0);
    for (const token of used) expect(css, `${token} must be a shared token`).toMatch(new RegExp(`${token}\\s*:`));
  });
});
