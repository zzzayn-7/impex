// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import AppearanceSection from "@/app/settings/appearance-section";
import DashboardFrame from "@/components/dashboard/frame";
import ThemeButton from "@/components/theme/theme-button";
import ThemeCustomizer from "@/components/theme/theme-customizer";
import { ThemeProvider, forgetSavedTheme, useTheme } from "@/components/theme/theme-provider";
import { ACCENTS, BACKGROUNDS, DEFAULT_THEME, encodeThemeCookie, type ThemeChoice } from "@/lib/theme";

const COOKIE = "impex_tenant_theme";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; body: any };
let calls: Call[];
let respond: (call: Call) => Response | Promise<Response>;

const html = () => document.documentElement;
const painted = () => ({ bg: html().getAttribute("data-ix-bg"), accent: html().getAttribute("data-ix-accent"), scheme: html().getAttribute("data-ix-scheme") });
const cookie = () => document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`))?.split("=")[1];

beforeEach(() => {
  forgetSavedTheme();
  calls = [];
  respond = (call) => json(200, { theme: call.body });
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return respond(call);
  }));
  document.cookie = `${COOKIE}=; Max-Age=0; Path=/`;
  for (const name of ["data-ix-bg", "data-ix-accent", "data-ix-scheme"]) html().removeAttribute(name);
  Object.values(router).forEach((fn) => fn.mockReset());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = (saved: ThemeChoice, ui: React.ReactNode) => render(<ThemeProvider saved={saved} cookieName={COOKIE}>{ui}</ThemeProvider>);
const radio = (group: "Background" | "Accent", name: RegExp | string) => within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });

describe("the customizer", () => {
  it("shows five backgrounds plus the original, and eight accents, each with its name and (for backgrounds) its hex code and a selected state", () => {
    mount(DEFAULT_THEME, <ThemeCustomizer />);
    const backgrounds = within(screen.getByRole("radiogroup", { name: "Background" })).getAllByRole("radio");
    expect(backgrounds.map((b) => b.getAttribute("aria-label"))).toEqual(BACKGROUNDS.map((b) => `${b.name} ${b.hex}`));
    for (const b of BACKGROUNDS) {
      const swatch = radio("Background", `${b.name} ${b.hex}`);
      expect(swatch.textContent).toContain(b.name);
      expect(swatch.textContent).toContain(b.hex);
      expect(swatch.querySelector("span[style]")!.getAttribute("style")).toContain(b.hex.toLowerCase().length ? "background" : "");
    }
    const accents = within(screen.getByRole("radiogroup", { name: "Accent" })).getAllByRole("radio");
    expect(accents.map((a) => a.getAttribute("aria-label"))).toEqual(ACCENTS.map((a) => `${a.name} ${a.hex}`));
    for (const a of ACCENTS) expect(radio("Accent", `${a.name} ${a.hex}`).textContent).toContain(a.name);
    expect(radio("Background", /Deep Teal/).getAttribute("aria-checked")).toBe("true");
    expect(radio("Accent", /Pale Butter Yellow/).getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(2); // exactly one of each
  });

  it("a click previews the choice on the whole page at once (data attributes on <html>) and marks it selected, without saving anything", async () => {
    const user = userEvent.setup();
    mount(DEFAULT_THEME, <ThemeCustomizer />);
    await user.click(radio("Background", /Burgundy/));
    expect(painted()).toEqual({ bg: "burgundy", accent: "pale-butter", scheme: "dark" });
    await user.click(radio("Accent", /Lavender Mist/));
    expect(painted()).toEqual({ bg: "burgundy", accent: "lavender-mist", scheme: "dark" });
    expect(radio("Background", /Burgundy/).getAttribute("aria-checked")).toBe("true");
    expect(radio("Accent", /Lavender Mist/).getAttribute("aria-checked")).toBe("true");
    expect(radio("Background", /Deep Teal/).getAttribute("aria-checked")).toBe("false");
    expect(calls).toEqual([]); // nothing is saved by choosing
    expect(screen.getByText(/saved only when you press Apply Theme/i)).toBeTruthy();
  });

  it("Ice switches the page to the light scheme, and every other background to the dark one", async () => {
    const user = userEvent.setup();
    mount(DEFAULT_THEME, <ThemeCustomizer />);
    await user.click(radio("Background", /Ice/));
    expect(painted().scheme).toBe("light");
    for (const name of [/Burgundy/, /Graphite/, /Deep Purple/, /Deep Steel Blue/, /Deep Teal/]) {
      await user.click(radio("Background", name));
      expect(painted().scheme, String(name)).toBe("dark");
    }
  });

  it("every one of the 40 pairings (and the original background's 8) can be selected independently, in either order", () => {
    mount(DEFAULT_THEME, <ThemeCustomizer />);
    let count = 0;
    for (const b of BACKGROUNDS) {
      for (const a of ACCENTS) {
        const background = () => fireEvent.click(radio("Background", `${b.name} ${b.hex}`));
        const accent = () => fireEvent.click(radio("Accent", `${a.name} ${a.hex}`));
        if (count % 2 === 0) { background(); accent(); } else { accent(); background(); }
        expect(painted(), `${b.id} + ${a.id}`).toEqual({ bg: b.id, accent: a.id, scheme: b.scheme });
        expect(radio("Background", `${b.name} ${b.hex}`).getAttribute("aria-checked")).toBe("true");
        expect(radio("Accent", `${a.name} ${a.hex}`).getAttribute("aria-checked")).toBe("true");
        count++;
      }
    }
    expect(count).toBe(48);
  }, 20000);

  it("the preview is a miniature of the interface drawn with the real classes, naming the chosen pair", async () => {
    const user = userEvent.setup();
    mount(DEFAULT_THEME, <ThemeCustomizer />);
    const preview = document.querySelector("[data-theme-preview]") as HTMLElement;
    expect(preview.getAttribute("aria-hidden")).toBe("true");
    expect(preview.querySelector(".ix-glass")).toBeTruthy(); // a small glass card
    expect(preview.querySelector(".bg-ix-butter")).toBeTruthy(); // a primary button
    expect(preview.querySelector(".bg-ix-accent-text\\/10")).toBeTruthy(); // a selected navigation item
    expect(preview.textContent).toContain("Deep Teal · Pale Butter Yellow");
    await user.click(radio("Background", /Deep Purple/));
    await user.click(radio("Accent", /Dusty Rose/));
    expect(preview.textContent).toContain("Deep Purple · Dusty Rose");
  });

  it("Apply Theme saves BOTH identifiers (and nothing else) to this portal's own route, then keeps the choice", async () => {
    const user = userEvent.setup();
    mount(DEFAULT_THEME, <><ThemeCustomizer /><Probe /></>);
    await user.click(radio("Background", /Ice/));
    await user.click(radio("Accent", /Muted Copper/));
    await user.click(screen.getByRole("button", { name: "Apply Theme" }));
    await waitFor(() => expect(screen.getByTestId("saved").textContent).toBe("ice.muted-copper"));
    expect(calls).toEqual([{ url: "/api/theme", method: "PUT", body: { background: "ice", accent: "muted-copper" } }]);
    expect(painted()).toEqual({ bg: "ice", accent: "muted-copper", scheme: "light" });
    expect(cookie()).toBe("ice.muted-copper"); // so the very next page is painted by the server
    expect((await screen.findByRole("status")).textContent).toContain("Theme saved.");
  });

  it("Cancel puts the saved theme back (the page and the selection)", async () => {
    const user = userEvent.setup();
    mount({ background: "graphite", accent: "frost-blue" }, <ThemeCustomizer />);
    expect(painted()).toEqual({ bg: "graphite", accent: "frost-blue", scheme: "dark" });
    await user.click(radio("Background", /Ice/));
    await user.click(radio("Accent", /Sage Silver/));
    expect(painted().bg).toBe("ice");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(painted()).toEqual({ bg: "graphite", accent: "frost-blue", scheme: "dark" });
    expect(radio("Background", /Graphite/).getAttribute("aria-checked")).toBe("true");
    expect(radio("Accent", /Frost Blue/).getAttribute("aria-checked")).toBe("true");
    expect(calls).toEqual([]);
  });

  it("Reset to Default shows the original Impex theme at once and is saved only when Apply Theme is pressed", async () => {
    const user = userEvent.setup();
    mount({ background: "burgundy", accent: "dusty-rose" }, <><ThemeCustomizer /><Probe /></>);
    await user.click(screen.getByRole("button", { name: "Reset to Default" }));
    expect(painted()).toEqual({ bg: "original", accent: "pale-butter", scheme: "dark" });
    expect(radio("Background", /Deep Teal/).getAttribute("aria-checked")).toBe("true");
    expect(radio("Accent", /Pale Butter Yellow/).getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector("[data-theme-preview]")!.textContent).toContain("Deep Teal · Pale Butter Yellow");
    expect(calls).toEqual([]); // not saved yet
    expect(screen.getByTestId("saved").textContent).toBe("burgundy.dusty-rose");
    await user.click(screen.getByRole("button", { name: "Apply Theme" }));
    await waitFor(() => expect(screen.getByTestId("saved").textContent).toBe("original.pale-butter"));
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ background: "original", accent: "pale-butter" });
  });

  it("a failed save says so, keeps the previewed choice and the dialog, and can be retried", async () => {
    const user = userEvent.setup();
    respond = () => json(502, { error: "The theme could not be saved. Please try again." });
    mount(DEFAULT_THEME, <><ThemeCustomizer /><Probe /></>);
    await user.click(radio("Accent", /Frost Blue/));
    await user.click(screen.getByRole("button", { name: "Apply Theme" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be saved");
    expect(screen.getByTestId("saved").textContent).toBe("original.pale-butter"); // still the saved one
    expect(painted().accent).toBe("frost-blue"); // the preview is kept
    respond = (call) => json(200, { theme: call.body });
    await user.click(screen.getByRole("button", { name: "Apply Theme" }));
    await waitFor(() => expect(screen.getByTestId("saved").textContent).toBe("original.frost-blue"));
  });

  it("an expired session sends the person to the sign-in page instead of pretending it was saved", async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, protocol: "http:" });
    respond = () => json(401, { error: "expired" });
    mount(DEFAULT_THEME, <ThemeCustomizer />);
    await user.click(radio("Accent", /Dusty Rose/));
    await user.click(screen.getByRole("button", { name: "Apply Theme" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });

  it("applying an unchanged theme sends nothing", async () => {
    const user = userEvent.setup();
    mount(DEFAULT_THEME, <ThemeCustomizer />);
    await user.click(screen.getByRole("button", { name: "Apply Theme" }));
    expect(calls).toEqual([]);
  });

  it("the saved record is the authority: a stale cache (another device) is corrected on load, and an unsaved preview never survives a new page", () => {
    html().setAttribute("data-ix-bg", "ice"); // what a stale cookie painted
    html().setAttribute("data-ix-scheme", "light");
    html().setAttribute("data-ix-accent", "muted-copper");
    mount({ background: "graphite", accent: "silver-pearl" }, <ThemeCustomizer />);
    expect(painted()).toEqual({ bg: "graphite", accent: "silver-pearl", scheme: "dark" });
    expect(cookie()).toBe(encodeThemeCookie({ background: "graphite", accent: "silver-pearl" }));
  });
});

function Probe() {
  const { saved } = useTheme();
  return <span data-testid="saved">{`${saved.background}.${saved.accent}`}</span>;
}

describe("the header button and its panel", () => {
  const frame = (saved: ThemeChoice = DEFAULT_THEME) => render(
    <DashboardFrame admin={{ id: "u", email: "o@x.y", full_name: "Olivia Owner", role: "organization-admin", organization_id: "o", is_active: true, created_at: "x", theme_background: saved.background, theme_accent: saved.accent } as any} organization={{ name: "Alpha", modules: ["inventory"] } as any}>content</DashboardFrame>,
  );

  it("is a palette button beside the profile picture, named 'Customize Theme', and the header is otherwise as it was", () => {
    frame();
    const header = screen.getByRole("banner");
    const labels = within(header).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Open navigation", "Add Widgets", "Customize Theme", "Account: Olivia Owner", "Edit profile picture", "Sign out"]); // (the card's edit icon) Add Widgets (home page only) comes right before Customize Theme, which is just before the avatar
    const button = within(header).getByRole("button", { name: "Customize Theme" });
    expect(button.querySelector("svg")).toBeTruthy();
    expect(button.className).toContain("h-10 w-10"); // the header's control size
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(within(header).getByRole("heading", { level: 1 }).textContent).toBe("Dashboard");
  });

  it("shows the 'Customize Theme' tooltip on hover", async () => {
    const user = userEvent.setup();
    frame();
    await user.hover(screen.getByRole("button", { name: "Customize Theme" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Customize Theme");
  });

  it("opens a floating 'Customize Appearance' panel with the two sections, the preview and the three actions; and the saved theme is what the page was painted with", async () => {
    const user = userEvent.setup();
    frame({ background: "deep-purple", accent: "sage-silver" });
    expect(painted()).toEqual({ bg: "deep-purple", accent: "sage-silver", scheme: "dark" });
    await user.click(screen.getByRole("button", { name: "Customize Theme" }));
    const panel = screen.getByRole("dialog", { name: "Customize Appearance" });
    expect(screen.getByRole("button", { name: "Customize Theme" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(panel).getByRole("radiogroup", { name: "Background" })).toBeTruthy();
    expect(within(panel).getByRole("radiogroup", { name: "Accent" })).toBeTruthy();
    expect(within(panel).getByText("Preview")).toBeTruthy();
    for (const label of ["Apply Theme", "Cancel", "Reset to Default"]) expect(within(panel).getByRole("button", { name: label })).toBeTruthy();
    expect(within(panel).getByRole("radio", { name: /Deep Purple/ }).getAttribute("aria-checked")).toBe("true");
    expect(within(panel).getByRole("radio", { name: /Sage Silver/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("Apply Theme saves and closes the panel; Cancel, Escape, the button again and a click elsewhere restore the saved theme and close it", async () => {
    const user = userEvent.setup();
    frame();
    const open = () => user.click(screen.getByRole("button", { name: "Customize Theme" }));
    await open();
    await user.click(radio("Background", /Burgundy/));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply Theme" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(painted().bg).toBe("burgundy");
    expect(calls).toEqual([{ url: "/api/theme", method: "PUT", body: { background: "burgundy", accent: "pale-butter" } }]);
    expect((await screen.findByRole("status")).textContent).toContain("Theme saved.");

    for (const close of [
      () => user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" })),
      () => user.keyboard("{Escape}"),
      () => user.click(screen.getByRole("button", { name: "Customize Theme" })),
      () => user.click(document.body),
    ]) {
      await open();
      await user.click(radio("Background", /Ice/));
      expect(painted().bg).toBe("ice");
      await close();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(painted().bg, "the saved theme is back").toBe("burgundy");
    }
    expect(calls).toHaveLength(1); // none of those saved anything
  });
});

describe("Settings and the header share ONE state", () => {
  it("Settings has 'Appearance & Theme' with the current background and accent, all options, a preview and the actions", () => {
    mount({ background: "ice", accent: "frost-blue" }, <AppearanceSection />);
    const section = screen.getByRole("region", { name: "Appearance & Theme" });
    expect(section.textContent).toContain("Current background");
    expect(section.textContent).toContain("Ice #E7F0F4");
    expect(section.textContent).toContain("Current accent");
    expect(section.textContent).toContain("Frost Blue #AFC9D7");
    expect(within(section).getAllByRole("radio")).toHaveLength(BACKGROUNDS.length + ACCENTS.length);
    expect(section.querySelector("[data-theme-preview]")).toBeTruthy();
    for (const label of ["Apply Theme", "Cancel", "Reset to Default"]) expect(within(section).getByRole("button", { name: label })).toBeTruthy();
    expect(section.querySelector("[data-theme-customizer=\"inline\"]")).toBeTruthy();
  });

  it("a choice made in the header panel is what Settings shows (and the other way round); applying in one updates 'current' in the other", async () => {
    const user = userEvent.setup();
    mount(DEFAULT_THEME, <><ThemeButton /><AppearanceSection /></>);
    await user.click(screen.getByRole("button", { name: "Customize Theme" }));
    const panel = screen.getByRole("dialog");
    await user.click(within(panel).getByRole("radio", { name: /Graphite/ }));
    const settings = screen.getByRole("region", { name: "Appearance & Theme" });
    expect(within(settings).getByRole("radio", { name: /Graphite/ }).getAttribute("aria-checked")).toBe("true"); // header -> Settings
    await user.click(within(settings).getByRole("radio", { name: /Dusty Rose/ }));
    expect(within(panel).getByRole("radio", { name: /Dusty Rose/ }).getAttribute("aria-checked")).toBe("true"); // Settings -> header
    await user.click(within(settings).getByRole("button", { name: "Apply Theme" }));
    await waitFor(() => expect(settings.textContent).toContain("Graphite #252B30"));
    expect(settings.textContent).toContain("Dusty Rose #CFA8B0");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

// ---- a theme chosen on one page is the theme of every page, in every tab, with no refresh
describe("the saved theme follows the person across pages and tabs", () => {
  const BURGUNDY: ThemeChoice = { background: "burgundy", accent: "lavender-mist" };
  const apply = async (user: ReturnType<typeof userEvent.setup>, background: RegExp, accent: RegExp) => {
    await user.click(screen.getByRole("button", { name: "Customize Theme" }));
    await user.click(radio("Background", background));
    await user.click(radio("Accent", accent));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply Theme" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  };
  const Saved = () => {
    const { saved } = useTheme();
    return <span data-testid="saved">{saved.background}.{saved.accent}</span>;
  };
  const tree = (saved: ThemeChoice, userId = "u1") => <ThemeProvider saved={saved} cookieName={COOKIE} userId={userId}><ThemeButton /><Saved /></ThemeProvider>;
  const page = (saved: ThemeChoice, userId = "u1") => render(tree(saved, userId));

  it("a page rendered from the router's cache (an OLDER copy of the user's theme) does not repaint the old colours over the new ones", async () => {
    const user = userEvent.setup();
    const first = page(DEFAULT_THEME);
    await apply(user, /Burgundy/, /Lavender Mist/);
    expect(painted()).toMatchObject({ bg: "burgundy", accent: "lavender-mist" });
    first.unmount(); // navigating to another page: its provider mounts with whatever copy of the user the cache holds, here the old one
    page(DEFAULT_THEME);
    expect(painted()).toMatchObject({ bg: "burgundy", accent: "lavender-mist", scheme: "dark" });
    expect(screen.getByTestId("saved").textContent).toBe("burgundy.lavender-mist");
    await waitFor(() => expect(cookie()).toBe("burgundy.lavender-mist")); // and the cache cookie is not overwritten with the stale copy
  });

  it("a NEWER copy from the server (a change made on another device, or the refresh after Apply) is adopted", async () => {
    const user = userEvent.setup();
    const view = page(DEFAULT_THEME);
    await apply(user, /Burgundy/, /Lavender Mist/);
    expect(router.refresh).toHaveBeenCalledTimes(1); // the client router cache is dropped, so the next page comes from the server
    view.rerender(tree(BURGUNDY)); // the refresh brings the same choice: nothing changes
    expect(screen.getByTestId("saved").textContent).toBe("burgundy.lavender-mist");
    view.rerender(tree({ background: "ice", accent: "frost-blue" }));
    expect(painted()).toMatchObject({ bg: "ice", accent: "frost-blue", scheme: "light" });
    expect(screen.getByTestId("saved").textContent).toBe("ice.frost-blue");
  });

  it("one person's remembered theme is never shown to another person on the same browser", async () => {
    const user = userEvent.setup();
    const first = page(DEFAULT_THEME, "alice");
    await apply(user, /Burgundy/, /Lavender Mist/);
    first.unmount();
    page({ background: "graphite", accent: "sage-silver" }, "bob");
    expect(painted()).toMatchObject({ bg: "graphite", accent: "sage-silver" });
  });

  describe("other tabs", () => {
    class FakeChannel {
      static all: FakeChannel[] = [];
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(public name: string) { FakeChannel.all.push(this); }
      postMessage(data: unknown) { for (const other of FakeChannel.all) if (other !== this && other.name === this.name) other.onmessage?.({ data } as MessageEvent); }
      close() { FakeChannel.all = FakeChannel.all.filter((c) => c !== this); }
    }
    const CHANNEL = "impex-theme:impex_tenant_theme:u1";
    beforeEach(() => { FakeChannel.all = []; vi.stubGlobal("BroadcastChannel", FakeChannel); });

    it("a theme applied in another tab is painted here at once, and a preview in progress here is left alone", async () => {
      const user = userEvent.setup();
      page(DEFAULT_THEME);
      const otherTab = new FakeChannel(CHANNEL);
      act(() => otherTab.postMessage(BURGUNDY));
      expect(painted()).toMatchObject({ bg: "burgundy", accent: "lavender-mist" });
      expect(screen.getByTestId("saved").textContent).toBe("burgundy.lavender-mist");

      await user.click(screen.getByRole("button", { name: "Customize Theme" }));
      await user.click(radio("Background", /Ice/)); // previewing here...
      act(() => otherTab.postMessage({ background: "graphite", accent: "frost-blue" })); // ...while the other tab applies something else
      expect(painted().bg, "the preview is not clobbered").toBe("ice");
      expect(screen.getByTestId("saved").textContent).toBe("graphite.frost-blue");
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
      expect(painted()).toMatchObject({ bg: "graphite", accent: "frost-blue" }); // Cancel goes back to the newest saved theme
    });

    it("ignores anything that is not two approved identifiers", () => {
      page(DEFAULT_THEME);
      const otherTab = new FakeChannel(CHANNEL);
      for (const bad of [null, "ice", { background: "#fff", accent: "pale-butter" }, { background: "ice" }, { background: "ice", accent: "<script>" }]) act(() => otherTab.postMessage(bad));
      expect(painted()).toMatchObject({ bg: "original", accent: "pale-butter" });
    });

    it("applying here tells the other tabs; a tab without channels re-reads the shared cookie when it is looked at again", async () => {
      const user = userEvent.setup();
      page(DEFAULT_THEME);
      const heard: unknown[] = [];
      const otherTab = new FakeChannel(CHANNEL);
      otherTab.onmessage = (event) => heard.push(event.data);
      await apply(user, /Burgundy/, /Lavender Mist/);
      expect(heard).toEqual([BURGUNDY]);

      document.cookie = `${COOKIE}=ice.dusty-rose; Path=/`; // another tab saved this (the cookie is shared by every tab)
      act(() => { window.dispatchEvent(new Event("focus")); });
      expect(painted()).toMatchObject({ bg: "ice", accent: "dusty-rose", scheme: "light" });
      document.cookie = `${COOKIE}=nonsense; Path=/`;
      act(() => { window.dispatchEvent(new Event("focus")); });
      expect(painted()).toMatchObject({ bg: "ice", accent: "dusty-rose" }); // a cookie that is not two approved identifiers is ignored
    });
  });

  describe("the change is smooth", () => {
    const withViewTransition = (reduced: boolean) => {
      const started: Array<() => void> = [];
      (document as any).startViewTransition = (update: () => void) => { started.push(update); update(); };
      vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
      return started;
    };
    afterEach(() => { delete (document as any).startViewTransition; });

    it("cross-fades the whole page through a View Transition when the browser has one", async () => {
      const started = withViewTransition(false);
      const user = userEvent.setup();
      page(DEFAULT_THEME);
      expect(started).toHaveLength(0); // the first paint of a page never fades
      await user.click(screen.getByRole("button", { name: "Customize Theme" }));
      await user.click(radio("Background", /Ice/));
      expect(started).toHaveLength(1);
      expect(painted().bg).toBe("ice");
    });

    it("swaps instantly for people who asked for reduced motion", async () => {
      const started = withViewTransition(true);
      const user = userEvent.setup();
      page(DEFAULT_THEME);
      await user.click(screen.getByRole("button", { name: "Customize Theme" }));
      await user.click(radio("Background", /Ice/));
      expect(started).toHaveLength(0);
      expect(painted().bg).toBe("ice");
    });
  });
});
