// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import DashboardFrame from "@/components/dashboard/frame";
import { MenuButton, NavProvider, Sidebar } from "@/components/dashboard/sidebar";
import { navGroups } from "@/lib/dashboard-nav";

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
  it("is a labelled navigation whose every link has an accessible name, a title and a route", () => {
    render(<Shell />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links.length).toBe(navGroups(["inventory", "sales", "finance"]).flatMap((g) => g.items).length);
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/^\//);
      expect(link.getAttribute("title")).toBe(link.textContent); // the full label, as the tooltip, even while only the icon shows
      expect(link.textContent!.trim().length).toBeGreaterThan(0); // the name is in the DOM, so a screen reader reads it while the rail is collapsed
    }
    expect(within(nav).getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Products" }).getAttribute("aria-current")).toBeNull();
  });

  it("groups the pages, and lists only what is enabled", () => {
    render(<Shell modules={["inventory"]} />);
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Main", "Inventory", "Workspace"]);
    expect(screen.queryByRole("link", { name: "Invoices" })).toBeNull();
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
    const label = screen.getByText("Products");
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
    screen.getByRole("link", { name: "Products" }).focus();
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
    fireEvent.click(screen.getByRole("link", { name: "Invoices" }));
    expect(aside().getAttribute("data-mobile-open")).toBe("false");
  });
});

describe("the header", () => {
  it("carries the company, the page title, the administrator and Sign out - and no control that does nothing", () => {
    render(<DashboardFrame admin={admin} organization={organization as any}>content</DashboardFrame>);
    const header = screen.getByRole("banner");
    expect(within(header).getByText("Alpha Trading GmbH")).toBeTruthy();
    expect(within(header).getByText("AT")).toBeTruthy(); // the monogram, since there is no logo
    expect(within(header).getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
    expect(within(header).getByText("Olivia Owner")).toBeTruthy();
    expect(within(header).getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(within(header).queryByRole("searchbox")).toBeNull(); // no decorative search or notification bell
    expect(within(header).queryByRole("button", { name: /search|notification/i })).toBeNull();
  });

  it("shows the company's own logo when it has one", () => {
    render(<DashboardFrame admin={admin} organization={{ ...organization, has_logo: true, logo_version: "9" } as any}>content</DashboardFrame>);
    const logo = screen.getByAltText("Alpha Trading GmbH logo") as HTMLImageElement;
    expect(logo.getAttribute("src")).toBe("/api/organization/logo?v=9");
  });

  it("falls back to the platform name when the organization could not be read, and lists no business page", () => {
    render(<DashboardFrame admin={admin} organization={null}>content</DashboardFrame>);
    expect(screen.getByText("IMPEX Organization Portal")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Products" })).toBeNull();
    expect(screen.getByRole("link", { name: "Help & Support" })).toBeTruthy();
  });
});
