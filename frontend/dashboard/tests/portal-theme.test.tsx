// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { alphaOrg, orgAdmin } from "./helpers";

const nav = vi.hoisted(() => ({ path: "/" as string | null }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
}));
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name === "impex_tenant_session" ? { name, value: "t" } : undefined) }) }));

import PortalShell from "@/components/dashboard/frame";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm";
import { buttonClass, Field, LinkButton, SearchField, TextInput } from "@/components/ui/controls";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader, StatusBadge, TabNavigation } from "@/components/ui/page";
import { DataTable, Pagination, TableHead, Th } from "@/components/ui/table";
import { activeHref, navGroups, PAGE_META } from "@/lib/dashboard-nav";
import { NAV_MODULE } from "@/lib/modules";

afterEach(() => {
  cleanup();
  nav.path = "/";
});

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf-8");
const admin = { full_name: "Olivia Owner", email: "o@x.y" } as any;
const org = (modules: string[]) => ({ name: "Acme", modules });
const shell = (current: keyof typeof PAGE_META, modules = ["inventory", "purchasing", "sales", "finance"]) =>
  renderToStaticMarkup(<PortalShell admin={admin} current={current} organization={org(modules)}><p>BODY</p></PortalShell>);

function walk(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, found);
    else if (/\.(tsx?|css)$/.test(name)) found.push(path);
  }
  return found;
}

describe("one shell for the whole portal", () => {
  it("has exactly one sidebar, one header and one main area, whatever the page", () => {
    for (const key of Object.keys(PAGE_META) as (keyof typeof PAGE_META)[]) {
      const html = shell(key);
      expect(html.match(/<aside /g), key).toHaveLength(1);
      expect(html.match(/<header /g), key).toHaveLength(1);
      expect(html.match(/<main /g), key).toHaveLength(1);
      expect(html.match(/<nav aria-label="Main"/g), key).toHaveLength(1);
      expect(html).toContain("BODY");
      expect(html).toContain("Sign out");
    }
  });

  it("the legacy header is gone: no component renders a second navigation", () => {
    expect(existsSync(join(root, "src/components/portal-header.tsx"))).toBe(false);
    const offenders = walk(join(root, "src")).filter((f) => /PortalHeader|portal-header/.test(readFileSync(f, "utf-8")));
    expect(offenders).toEqual([]);
  });

  it("every section layout goes through the one frame (none builds its own header or main)", () => {
    const appDir = join(root, "src/app");
    const layouts = readdirSync(appDir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(appDir, d.name, "layout.tsx"))).map((d) => d.name);
    for (const name of layouts.filter((n) => n !== "setup")) {
      const source = readFileSync(join(appDir, name, "layout.tsx"), "utf-8");
      expect(source, `${name}/layout.tsx`).toContain("PortalFrame");
      expect(source, `${name}/layout.tsx`).not.toMatch(/<main|<header|<aside|<nav /);
    }
  });

  it("every page key knows its title, route and section, and every module page key is in the module registry", () => {
    for (const [key, meta] of Object.entries(PAGE_META)) {
      expect(meta.title && meta.href.startsWith("/"), key).toBeTruthy();
      if (key in NAV_MODULE) expect(["inventory", "purchasing", "sales", "finance"], key).toContain(meta.section);
    }
  });

  it("the header names the page, the company and the administrator", () => {
    const html = shell("invoices");
    expect(html).toMatch(/<h1[^>]*>Invoices<\/h1>/);
    expect(html).toContain("Acme");
    expect(html).toContain("Olivia Owner");
  });

  it("the shell is hidden when printing (an invoice or a label prints clean)", () => {
    const html = shell("invoices");
    expect(html).toMatch(/<aside[^>]*print:hidden/);
    expect(html).toMatch(/<header class="print:hidden/);
    expect(html).toContain("print:pl-0");
  });
});

describe("the current page is highlighted, nested routes included", () => {
  const groups = navGroups(["inventory", "purchasing", "sales", "finance"]);
  it.each([
    ["/", "/"], ["/invoices", "/invoices"], ["/invoices/123/edit", "/invoices"], ["/invoices/new", "/invoices"], ["/products/abc/codes", "/products"],
    ["/finance", "/finance"], ["/finance/accounts", "/finance/accounts"], ["/finance/journal/new", "/finance/journal"], ["/finance/expenses/9", "/finance/expenses"],
    ["/purchase-orders/7", "/purchase-orders"], ["/support/new", "/support"], ["/settings", "/settings"],
  ])("%s -> %s", (path, expected) => {
    expect(activeHref(path, groups, "/fallback")).toBe(expected);
  });
  it("an address that is not in the menu falls back to the page's own entry; '/' never matches everything", () => {
    expect(activeHref("/nowhere", groups, "/stock")).toBe("/stock");
    expect(activeHref(null, groups, "/stock")).toBe("/stock");
    expect(activeHref("/invoicesX", groups, "/stock")).toBe("/stock"); // a prefix must end at a path boundary
  });
  it("the sidebar marks exactly that entry (and only one)", () => {
    nav.path = "/finance/journal/abc";
    render(<PortalShell admin={admin} current="finance" organization={org(["finance"])}>x</PortalShell>);
    const marked = screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page");
    expect(marked.map((l) => l.getAttribute("href"))).toEqual(["/finance/journal"]);
  });
  it("only enabled modules are listed, and Settings and Help & Support always are", () => {
    render(<PortalShell admin={admin} current="settings" organization={org([])}>x</PortalShell>);
    const links = screen.getAllByRole("link").map((l) => l.getAttribute("href"));
    expect(links).toEqual(["/", "/support", "/settings"]);
  });
});

describe("each part of the portal has its own decorative accent", () => {
  const section = (key: keyof typeof PAGE_META) => /data-section="([a-z]+)"/.exec(shell(key))?.[1];
  it("Inventory powder blue, Purchasing pale butter, Sales sea-glass mint; the rest keep the foundation's sea-glass", () => {
    for (const key of ["products", "warehouses", "stock", "scan", "movements"] as const) expect(section(key), key).toBe("inventory");
    for (const key of ["suppliers", "purchasing", "receipts"] as const) expect(section(key), key).toBe("purchasing");
    for (const key of ["clients", "deliveries", "dispatches", "invoices"] as const) expect(section(key), key).toBe("sales");
    for (const key of ["dashboard", "finance", "support", "settings"] as const) expect(section(key), key).toBeUndefined();
  });
  it("the CSS defines those accents once, as tokens", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/--ix-accent-yellow:\s*#e8d8a4/i);
    expect(css).toMatch(/--ix-accent-mint:\s*#96c5b8/i);
    expect(css).toMatch(/--ix-accent-blue:\s*#a7c7d8/i);
    expect(css).toMatch(/data-section="inventory"\][^}]*167 199 216/);
    expect(css).toMatch(/data-section="purchasing"\][^}]*232 216 164/);
    expect(css).toMatch(/data-section="sales"\][^}]*150 197 184/);
    const tailwind = read("tailwind.config.ts");
    for (const hex of ["#E8D8A4", "#96C5B8", "#A7C7D8", "#172A32", "#324D58", "#568E8F", "#86B6AA", "#A6C1B2", "#D8E8E3", "#EDF4F1", "#B5CBC9"]) expect(tailwind.toUpperCase(), hex).toContain(hex);
  });
  it("the accent hex codes live ONLY in the theme files (the CSS tokens, the Tailwind palette and the chart palette), not scattered through components", () => {
    const allowed = ["src/app/globals.css", "tailwind.config.ts", "src/components/dashboard/charts.tsx"].map((p) => join(root, p));
    const scattered = walk(join(root, "src")).filter((f) => !allowed.includes(f)).filter((f) => /#E8D8A4|#96C5B8|#A7C7D8/i.test(readFileSync(f, "utf-8")));
    expect(scattered).toEqual([]);
  });
  it("the old light palettes are gone from Settings, setup and login", () => {
    for (const dir of ["src/app/settings", "src/app/setup", "src/app/login"]) {
      for (const file of walk(join(root, dir))) expect(readFileSync(file, "utf-8"), file).not.toMatch(/\[#[0-9a-f]{6}\]|bg-white\b/i);
    }
    expect(read("src/app/login/page.tsx")).toContain("ix-dash");
    expect(read("src/app/setup/layout.tsx")).toContain("ix-dash");
  });
});

describe("printing", () => {
  const css = read("src/app/globals.css");
  const printBlock = css.slice(css.lastIndexOf("@media print"));
  it("turns the portal into clean black-on-white pages with no glass, atmosphere or blur", () => {
    expect(printBlock).toMatch(/\.ix-dash::before\s*\{\s*display:\s*none/);
    expect(printBlock).toMatch(/background-color:\s*transparent\s*!important/);
    expect(printBlock).toMatch(/color:\s*#000\s*!important/);
    expect(printBlock).toMatch(/backdrop-filter:\s*none\s*!important/);
  });
  it("lets machine-readable codes keep their own white background", () => {
    expect(printBlock).toMatch(/\.bg-white[^{]*\{\s*background-color:\s*#fff\s*!important/);
  });
  it("the legacy skin (glass, rounded fields) is screen-only", () => {
    const skin = css.slice(css.indexOf("The skin for pages written with"), css.lastIndexOf("@media (prefers-reduced-motion"));
    expect(skin).toContain("@media screen");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

describe("the shared UI library", () => {
  it("has three button looks: a calm general action, a glass secondary and an unmistakable destructive one", () => {
    expect(buttonClass.primary).toContain("bg-ix-action");
    expect(buttonClass.secondary).toContain("border-ix-mist/20");
    expect(buttonClass.destructive).toMatch(/red/);
    for (const looks of Object.values(buttonClass)) expect(looks).toMatch(/min-h-11/); // touch-friendly
    expect(renderToStaticMarkup(<LinkButton href="/x" kind="primary">Go</LinkButton>)).toContain('href="/x"');
  });

  it("fields are labelled, rounded, and announce their errors", () => {
    render(<Field label="Amount" error="Enter an amount."><TextInput defaultValue="" /></Field>);
    expect(screen.getByLabelText("Amount")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Enter an amount.");
    expect(screen.getByLabelText("Amount").className).toContain("rounded-xl");
    cleanup();
    render(<SearchField placeholder="Name" />);
    expect(screen.getByRole("searchbox", { name: "Search" })).toBeTruthy();
  });

  it("tabs are links with the current one marked", () => {
    render(<TabNavigation label="Sections" tabs={[{ href: "/a", label: "A" }, { href: "/b", label: "B" }]} current="/b" />);
    const tabs = within(screen.getByRole("navigation", { name: "Sections" })).getAllByRole("link");
    expect(tabs.map((t) => [t.textContent, t.getAttribute("aria-current")])).toEqual([["A", null], ["B", "page"]]);
  });

  it("status badges carry meaning in their text as well as their colour, and states are announced", () => {
    render(<><StatusBadge tone="danger">Failed</StatusBadge><StatusBadge tone="success">Posted</StatusBadge><ErrorState>Could not load.</ErrorState><EmptyState>Nothing here.</EmptyState></>);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Could not load.");
    expect(screen.getByText("Nothing here.")).toBeTruthy();
  });

  it("a loading skeleton is announced politely and has the page's shape", () => {
    render(<LoadingSkeleton label="Loading invoices" />);
    expect(screen.getByRole("status", { name: "Loading invoices" })).toBeTruthy();
  });

  it("a table scrolls inside its own region, with a caption and column scopes", () => {
    render(<DataTable caption="Invoices"><TableHead><Th>Number</Th><Th right>Total</Th></TableHead><tbody><tr><td>INV-1</td><td>5</td></tr></tbody></DataTable>);
    const region = screen.getByRole("region", { name: "Invoices" });
    expect(region.className).toContain("overflow-x-auto");
    expect(region.getAttribute("tabindex")).toBe("0"); // keyboard users can scroll it
    expect(screen.getAllByRole("columnheader").map((h) => h.getAttribute("scope"))).toEqual(["col", "col"]);
    expect(screen.getByText("Invoices", { selector: "caption" })).toBeTruthy();
  });

  it("pagination shows the range and disables what cannot be done", async () => {
    const onPage = vi.fn();
    render(<Pagination total={60} offset={25} shown={25} page={2} onPage={onPage} />);
    expect(screen.getByText("Showing 26–50 of 60")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPage).toHaveBeenCalledWith(3);
    cleanup();
    render(<Pagination total={60} offset={0} shown={25} page={1} onPage={onPage} />);
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const { container } = render(<Pagination total={0} offset={0} shown={0} page={1} onPage={onPage} />);
    expect(container.textContent).toBe("");
  });

  it("a page header has one heading and its actions", () => {
    render(<PageHeader title="Invoices" subtitle="Bill your clients" actions={<button>New</button>} />);
    expect(screen.getByRole("heading", { level: 2, name: "Invoices" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New" })).toBeTruthy();
  });
});

describe("confirmation dialogs", () => {
  it("a destructive confirmation names its action, is labelled and describes itself", () => {
    const resolve = vi.fn();
    const { container } = render(<ConfirmDialog open title="Delete account" message="This cannot be undone." confirmLabel="Delete" onResolve={resolve} />);
    const dialog = container.querySelector("dialog")!;
    expect(dialog.getAttribute("aria-labelledby")).toBe("ix-confirm-title");
    expect(dialog.getAttribute("aria-describedby")).toBe("ix-confirm-message");
    fireEvent.click(screen.getByText("Delete", { selector: "button" }));
    expect(resolve).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText("Cancel"));
    expect(resolve).toHaveBeenCalledWith(false);
    expect(screen.getByText("Delete", { selector: "button" }).className).toMatch(/red/); // never styled like a cheerful action
  });

  it("falls back to the browser's own confirm where the modal element is unavailable, so nothing destructive happens unasked", async () => {
    const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    let result: ReturnType<typeof useConfirm> | null = null;
    function Probe() { result = useConfirm(); return <>{result[1]}</>; }
    render(<Probe />);
    expect(await result![0]({ title: "T", message: "Really?", confirmLabel: "Yes" })).toBe(false);
    expect(await result![0]({ title: "T", message: "Really?", confirmLabel: "Yes" })).toBe(true);
    expect(ask).toHaveBeenCalledWith("Really?");
  });
});

describe("the dashboard's accents", () => {
  it("each figure card keeps the glass and takes its own accent: products blue, purchase orders butter, invoicing mint", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\.ix-kpi\[data-accent="blue"\][^}]*accent-blue-rgb/);
    expect(css).toMatch(/\.ix-kpi\[data-accent="yellow"\][^}]*accent-yellow-rgb/);
    expect(css).toMatch(/\.ix-kpi\[data-accent="mint"\][^}]*accent-mint-rgb/);
    const view = read("src/components/dashboard/view.tsx");
    expect(view).toMatch(/icon="products" accent="blue"/);
    expect(view).toMatch(/icon="orders" accent="yellow"/);
    expect(view).toMatch(/icon="invoices" accent="mint"/);
    expect(view).toContain("ix-kpi p-5"); // still a glass card (GlassCard), never a solid colour
  });
  it("the sidebar's selected entry is marked with the pale butter yellow", () => {
    nav.path = "/";
    render(<PortalShell admin={admin} current="dashboard" organization={org([])}>x</PortalShell>);
    const current = screen.getByRole("link", { name: "Dashboard" });
    expect(current.className).toContain("bg-ix-butter/10");
    expect(current.querySelector("span.bg-ix-butter")).toBeTruthy();
  });
  it("alphaOrg-shaped data still produces the shell without errors", () => {
    expect(() => shell("dashboard", alphaOrg.modules)).not.toThrow();
    expect(orgAdmin.full_name).toBeTruthy();
  });
});
