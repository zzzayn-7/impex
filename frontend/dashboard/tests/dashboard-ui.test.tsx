// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import DashboardFrame from "@/components/dashboard/frame";
import { MenuButton, NavProvider, Sidebar } from "@/components/dashboard/sidebar";
import { navGroups, PAGE_ICON, PAGE_META } from "@/lib/dashboard-nav";

afterEach(cleanup);

const admin = { id: "u", email: "owner@acme.example", full_name: "Olivia Owner", role: "organization-admin", organization_id: "o", is_active: true, created_at: "x" } as any;
const organization = { name: "Alpha Trading GmbH", has_logo: false, modules: ["inventory", "sales", "finance"] };

function Shell({ modules = ["inventory", "sales", "finance"] }: { modules?: string[] }) {
  return (
    <NavProvider>
      <header><MenuButton /></header>
      <Sidebar groups={navGroups(modules)} currentHref="/" />
      <main><a href="/after">after the sidebar</a></main>
    </NavProvider>
  );
}
const aside = () => document.getElementById("ix-sidebar") as HTMLElement;

describe("the sidebar's structure", () => {
  it("is a labelled navigation whose every link has an accessible name and a route", () => {
    render(<Shell />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links.length).toBe(navGroups(["inventory", "sales", "finance"]).flatMap((g) => g.items).length);
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/^\//);
      expect(link.getAttribute("title")).toBeNull(); // no native tooltip: hovering or focusing the rail expands it, which shows the label itself
      expect(link.textContent!.trim().length).toBeGreaterThan(0); // the name is in the DOM, so a screen reader reads it while the rail is collapsed
    }
    expect(within(nav).getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Stock" }).getAttribute("aria-current")).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Products" }), "there is no standalone Products entry").toBeNull();
  });

  it("groups the pages, and lists only what is enabled", () => {
    render(<Shell modules={["inventory"]} />);
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Main", "Inventory", "Workspace"]);
    expect(screen.queryByRole("link", { name: "Sales Invoice" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Financial Overview" })).toBeNull();
    expect(screen.getByRole("link", { name: "Help & Support" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
  });

  it("the rail is fixed-width and expands as an overlay: the content column never gets a width that depends on the sidebar", () => {
    render(<Shell />);
    expect(aside().className).toMatch(/\bfixed\b/);
    expect(aside().className).toContain("lg:w-[76px]");
    expect(aside().className).toContain("lg:hover:w-[256px]");
    expect(aside().className).toContain("lg:focus-within:w-[256px]");
    expect(aside().className).toContain("lg:data-[pinned=true]:w-[256px]");
    expect(aside().className).toContain("lg:duration-200");
    render(<DashboardFrame admin={admin} organization={organization as any}>content</DashboardFrame>);
    const column = document.querySelector(".lg\\:pl-\\[104px\\]");
    expect(column).toBeTruthy(); // constant padding: 12px gap + 76px rail + 16px; expanding the rail (an overlay) moves nothing
    expect(column!.className).not.toMatch(/hover|focus|data-\[/);
  });

  it("labels are in the page but faded out while collapsed, and fade in on hover, focus or pinning", () => {
    render(<Shell />);
    const label = screen.getByText("Movements");
    expect(label.className).toContain("opacity-0");
    expect(label.className).toContain("group-hover:opacity-100");
    expect(label.className).toContain("group-focus-within:opacity-100");
    expect(label.className).toContain("group-data-[pinned=true]:opacity-100");
    expect(label.className).toContain("max-lg:opacity-100"); // in the mobile drawer they are always shown
  });
});

describe("keyboard use", () => {
  it("the toggle pins the sidebar open and shut, with its state announced", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    const toggle = screen.getByRole("button", { name: "Expand navigation" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(aside().getAttribute("data-pinned")).toBe("false");
    await user.click(toggle);
    expect(aside().getAttribute("data-pinned")).toBe("true");
    const collapse = screen.getByRole("button", { name: "Collapse navigation" });
    expect(collapse.getAttribute("aria-pressed")).toBe("true");
    await user.click(collapse);
    expect(aside().getAttribute("data-pinned")).toBe("false");
  });

  it("Tab reaches every link in order, and Escape closes an expanded rail and returns focus to the page", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open navigation" })); // the (mobile) menu button comes first in the document
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand navigation" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Dashboard" }));
    await user.click(screen.getByRole("button", { name: "Expand navigation" }));
    expect(aside().getAttribute("data-pinned")).toBe("true");
    screen.getByRole("link", { name: "Stock" }).focus();
    await user.keyboard("{Escape}");
    expect(aside().getAttribute("data-pinned")).toBe("false");
    expect(aside().contains(document.activeElement)).toBe(false); // focus left the rail, so :focus-within no longer holds it open
  });
});

describe("the mobile drawer (no hover involved)", () => {
  it("is closed and unreachable until the menu button opens it", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    expect(aside().getAttribute("data-mobile-open")).toBe("false");
    expect(aside().className).toContain("max-lg:invisible"); // visibility:hidden removes its links from the Tab order while closed
    expect(aside().className).toContain("max-lg:-translate-x-[110%]");
    const open = screen.getByRole("button", { name: "Open navigation" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(open.getAttribute("aria-controls")).toBe("ix-sidebar");
    await user.click(open);
    expect(aside().getAttribute("data-mobile-open")).toBe("true");
    expect(aside().className).toContain("max-lg:visible");
    expect(aside().className).toContain("max-lg:translate-x-0");
    const closers = screen.getAllByRole("button", { name: "Close navigation" }); // the header's menu button (now "close") and the backdrop
    expect(closers).toHaveLength(2);
    expect(closers.some((b) => b.getAttribute("aria-expanded") === "true" && b.getAttribute("aria-controls") === "ix-sidebar")).toBe(true);
  });

  it("closes with Escape, with the backdrop, and after choosing a page", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    const menu = () => screen.getByRole("button", { expanded: false, name: "Open navigation" });
    await user.click(menu());
    await user.keyboard("{Escape}");
    expect(aside().getAttribute("data-mobile-open")).toBe("false");
    await user.click(menu());
    const backdrop = document.querySelector("button[tabindex='-1']") as HTMLElement;
    expect(backdrop).toBeTruthy();
    await user.click(backdrop);
    expect(aside().getAttribute("data-mobile-open")).toBe("false");
    await user.click(menu());
    fireEvent.click(screen.getByRole("link", { name: "Sales Invoice" }));
    expect(aside().getAttribute("data-mobile-open")).toBe("false");
  });
});

describe("the header", () => {
  it("names the page in big bold type; on the right only the avatar and the red Sign out icon (no text, no control that does nothing)", () => {
    render(<DashboardFrame admin={admin} organization={organization as any}>content</DashboardFrame>);
    const header = screen.getByRole("banner");
    const title = within(header).getByRole("heading", { level: 1, name: "Dashboard" });
    expect(title.className).toContain("font-bold");
    expect(title.className).toContain("text-xl");
    expect(within(header).queryByRole("navigation", { name: "Breadcrumb" })).toBeNull(); // no "Organization / Dashboard" trail
    expect(header.textContent).not.toContain("Admin Portal");
    const avatar = within(header).getByRole("button", { name: "Account: Olivia Owner" });
    expect(avatar.textContent).toBe("OO");
    const signOut = within(header).getByRole("button", { name: "Sign out" });
    expect(signOut.textContent).toBe(""); // icon only
    expect(signOut.querySelector("svg")).toBeTruthy();
    expect(signOut.className).toContain("text-red-400");
    expect(signOut.className).not.toMatch(/\bborder\b/); // a bare icon: no circle or frame
    expect(within(header).queryByRole("searchbox")).toBeNull(); // no decorative search or notification bell
    expect(within(header).queryByRole("button", { name: /search|notification/i })).toBeNull();
    // the only controls: the phone menu button (hidden on large screens), the avatar and Sign out
    expect(within(header).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Open navigation", "Add Widgets", "Customize Theme", "Account: Olivia Owner", "Sign out"]);
  });

  it("every page's name is preceded by its own icon, in yellow, the same drawing its sidebar entry uses", () => {
    const sidebarPaths = (html: HTMLElement) => [...html.querySelectorAll("path")].map((p) => p.getAttribute("d")).join("|");
    const seen = new Set<string>();
    for (const key of Object.keys(PAGE_META) as Array<keyof typeof PAGE_META>) {
      const { unmount } = render(<DashboardFrame admin={admin} organization={{ ...organization, modules: ["inventory", "purchasing", "sales", "finance"] } as any} current={key}>content</DashboardFrame>);
      const header = screen.getByRole("banner");
      const heading = within(header).getByRole("heading", { level: 1 });
      expect(heading.textContent, key).toBe(PAGE_META[key].title);
      const icon = heading.parentElement!.querySelector("svg")!;
      expect(icon, key).toBeTruthy();
      expect(icon.getAttribute("class"), key).toContain("text-ix-accent-text"); // yellow
      expect(icon.getAttribute("aria-hidden"), key).toBe("true"); // decorative: the name is the heading's
      expect(!!(icon.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING), `${key}: icon first, then the name`).toBe(true);
      expect(heading.querySelector("svg"), key).toBeNull();
      const drawing = sidebarPaths(icon as unknown as HTMLElement);
      expect(drawing.length, key).toBeGreaterThan(0);
      seen.add(`${PAGE_ICON[key]}`);
      const link = [...document.querySelectorAll("aside a")].find((a) => a.getAttribute("href") === PAGE_META[key].href);
      if (link) expect(sidebarPaths(link.querySelector("svg") as unknown as HTMLElement), `${key}: same drawing as the sidebar`).toBe(drawing);
      unmount();
    }
    expect(seen.size).toBeGreaterThan(10); // the pages do not all share one icon
  });

  it("the avatar's card holds the name, the role, the user id and the organization, and shows on hover, focus and tap", async () => {
    const user = userEvent.setup();
    render(<DashboardFrame admin={admin} organization={organization as any}>content</DashboardFrame>);
    const card = screen.getByRole("group", { name: "Account details", hidden: true });
    expect(card.className).toContain("invisible"); // closed: not seen and not read out
    for (const text of ["Olivia Owner", "owner@acme.example", "Organization Admin", "u", "Alpha Trading GmbH"]) expect(within(card).getAllByText(text, { exact: true }).length, text).toBeGreaterThan(0);
    expect(within(card).getByText("Role")).toBeTruthy();
    expect(within(card).getByText("User ID")).toBeTruthy();
    const avatar = screen.getByRole("button", { name: "Account: Olivia Owner" });
    await user.hover(avatar);
    expect(card.className).toContain("visible");
    expect(card.className).not.toContain("invisible");
    await user.unhover(avatar);
    expect(card.className).toContain("invisible");
    act(() => avatar.focus()); // the keyboard
    expect(document.activeElement).toBe(avatar);
    expect(card.className).not.toContain("invisible");
    await user.keyboard("{Escape}");
    expect(card.className).toContain("invisible");
    expect(avatar.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the company's own logo beside its name in the card when it has one, and a monogram when not", () => {
    const { unmount } = render(<DashboardFrame admin={admin} organization={{ ...organization, has_logo: true, logo_version: "9" } as any}>content</DashboardFrame>);
    const logo = screen.getByAltText("Alpha Trading GmbH logo") as HTMLImageElement;
    expect(logo.getAttribute("src")).toBe("/api/organization/logo?v=9");
    expect(screen.getByRole("group", { name: "Account details", hidden: true }).contains(logo)).toBe(true);
    unmount();
    render(<DashboardFrame admin={admin} organization={organization as any}>content</DashboardFrame>);
    expect(screen.queryByAltText("Alpha Trading GmbH logo")).toBeNull();
    expect(within(screen.getByRole("group", { name: "Account details", hidden: true })).getByText("AT")).toBeTruthy();
  });

  it("without a readable organization the header still names the page, the card has no organization row, and no business page is listed", () => {
    render(<DashboardFrame admin={admin} organization={null}>content</DashboardFrame>);
    expect(within(screen.getByRole("banner")).getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Account details", hidden: true })).queryByText("Organization")).toBeNull();
    expect(screen.queryByRole("link", { name: "Stock" })).toBeNull();
    expect(screen.getByRole("link", { name: "Help & Support" })).toBeTruthy();
  });
});
