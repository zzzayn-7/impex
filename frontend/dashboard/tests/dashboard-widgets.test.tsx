// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

import { forgetSavedLayouts } from "@/components/dashboard-layout/layout-storage";
import DashboardLayoutEditor from "@/components/dashboard-layout/layout-editor";
import DashboardFrame from "@/components/dashboard/frame";
import { forgetSavedTheme } from "@/components/theme/theme-provider";
import { availableOrgWidgets } from "@/lib/dashboard-widgets";

// The personalised home page: removing a card, the Add Widgets panel, Restore All, Edit Layout (three-dot menu, keyboard moves, Save / Cancel / Reset,
// Escape), long-press on a touch screen, and what is saved. The cards here are simple stand-ins with a link, a button and plain text, so the tests can
// prove the card's own controls keep working while its surface opens the menu.

const ADMIN = { id: "u-1", email: "o@acme.example", full_name: "Olivia Owner", role: "organization-admin", organization_id: "o-1", is_active: true, created_at: "x" };
const MODULES = ["inventory", "sales"];
const ORG = { name: "Acme", modules: MODULES } as any;
const available = availableOrgWidgets(MODULES, true);
const IDS = available.map((w) => w.id);
const NAME = (id: string) => available.find((w) => w.id === id)!.name;

const nodes = (ids = IDS) => Object.fromEntries(ids.map((id) => [id, (
  <section className="ix-glass" aria-label={NAME(id)}>
    <h3>{NAME(id)}</h3>
    <p>surface {id}</p>
    <a href={`/go/${id}`}>link {id}</a>
    <button type="button" onClick={() => clicks.push(id)}>button {id}</button>
  </section>
)]));

let clicks: string[];
let saves: { order: string[]; hidden: string[] }[];
let respond: (body: any) => Response;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  clicks = [];
  saves = [];
  forgetSavedLayouts();
  forgetSavedTheme();
  let revision = 10;
  respond = (body) => json(200, { layout: { version: 1, revision: ++revision, order: body.order, hidden: body.hidden } });
  vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any = {}) => {
    const body = JSON.parse(init.body);
    saves.push(body);
    return respond(body);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const mount = (saved: unknown = null, opts: { modules?: string[]; current?: any; ids?: string[] } = {}) => {
  const modules = opts.modules ?? MODULES;
  return render(
    <DashboardFrame admin={{ ...ADMIN, dashboard_layout: saved } as any} organization={{ ...ORG, modules } as any} current={opts.current}>
      <DashboardLayoutEditor nodes={nodes(opts.ids ?? availableOrgWidgets(modules, true).map((w) => w.id))} />
    </DashboardFrame>,
  );
};
const shown = () => Array.from(document.querySelectorAll<HTMLElement>("[data-widget-id]")).map((el) => el.dataset.widgetId!);
const card = (id: string) => document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!;
const surface = (id: string) => within(card(id)).getByText(`surface ${id}`);
const lastSave = () => saves[saves.length - 1];
const dotsOf = (id: string) => within(card(id)).getByRole("button", { name: `Options for ${NAME(id)}` });
const removeViaDots = async (user: ReturnType<typeof userEvent.setup>, id: string) => {
  await user.click(dotsOf(id));
  await user.click(screen.getByRole("menuitem", { name: "Remove from Home" }));
};
const openAddWidgets = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(screen.getByRole("button", { name: "Add Widgets" })); return screen.getByRole("dialog", { name: "Your Widgets" }); };

describe("the first visit", () => {
  it("shows every authorized widget in the default order, exactly as before, and saves nothing", () => {
    mount();
    expect(shown()).toEqual(IDS);
    expect(saves).toEqual([]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("only shows the widgets of the modules that are enabled (a saved arrangement can never bring back the others)", () => {
    const stale = { version: 1, revision: 3, order: ["org.finance.snapshot", "org.kpi.open-purchase-orders", "org.overview"], hidden: ["org.list.open-purchase-orders"] };
    mount(stale);
    expect(shown()).not.toContain("org.finance.snapshot");
    expect(shown()).not.toContain("org.kpi.open-purchase-orders");
    expect(shown()[0]).toBe("org.overview");
    expect(shown()).toHaveLength(IDS.length);
  });

  it("applies the saved order and hidden widgets, and puts a widget it has never heard of at the end", () => {
    const rest = IDS.filter((id) => id !== "org.overview" && id !== "org.panel.organization");
    mount({ version: 1, revision: 2, order: ["org.panel.organization", ...rest.slice(0, 3)], hidden: ["org.overview"] });
    expect(shown().slice(0, 4)).toEqual(["org.panel.organization", ...rest.slice(0, 3)]);
    expect(shown()).not.toContain("org.overview");
    expect(shown().slice(4)).toEqual(rest.slice(3)); // the ones the document did not mention follow, in the default order
  });
});

describe("the Add Widgets button", () => {
  it("is in the header right before Customize Theme, with the same size and a tooltip, and only on the home page", async () => {
    const user = userEvent.setup();
    mount();
    const header = screen.getByRole("banner");
    const buttons = within(header).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(buttons.indexOf("Add Widgets")).toBe(buttons.indexOf("Customize Theme") - 1);
    const button = within(header).getByRole("button", { name: "Add Widgets" });
    expect(button.className).toContain("h-10 w-10");
    expect(button.querySelector("svg")).toBeTruthy();
    await user.hover(button);
    expect(await screen.findByRole("tooltip")).toHaveProperty("textContent", "Add Widgets");
  });

  it("is not there on any other page, and those pages have no widget controls", () => {
    render(<DashboardFrame admin={ADMIN as any} organization={ORG} current="stock"><p>the Stock page</p></DashboardFrame>);
    expect(screen.queryByRole("button", { name: "Add Widgets" })).toBeNull();
    expect(screen.getByRole("button", { name: "Customize Theme" })).toBeTruthy();
    expect(document.querySelectorAll(".ix-widget-dots, [data-widget-id]").length).toBe(0);
  });

  it("opens 'Your Widgets' with its subtitle, and says so when nothing was removed", async () => {
    const user = userEvent.setup();
    mount();
    const panel = await openAddWidgets(user);
    expect(within(panel).getByRole("heading", { name: "Your Widgets" })).toBeTruthy();
    expect(within(panel).getByText("Add previously removed widgets back to your dashboard.")).toBeTruthy();
    expect(within(panel).getByText("All widgets are on your dashboard.")).toBeTruthy();
    expect(within(panel).getByText("Remove a dashboard card to see it here.")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /Restore All/ })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Your Widgets" })).toBeNull();
  });
});

describe("removing a card", () => {
  it("the three-dot button opens 'Remove from Home' (and 'Edit Layout'); removing hides the card, the others stay, and the choice is saved", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(dotsOf("org.kpi.active-products"));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Remove from Home", "Edit Layout"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Remove from Home" }));
    expect(shown()).toEqual(IDS.filter((id) => id !== "org.kpi.active-products"));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(lastSave()).toEqual({ order: IDS.filter((id) => id !== "org.kpi.active-products"), hidden: ["org.kpi.active-products"] });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the card's own surface does nothing special: a click (even with text selected), a right-click and the card's own links and buttons never open a menu", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(surface("org.overview"));
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(within(card("org.overview")).getByRole("link", { name: "link org.overview" }));
    await user.click(within(card("org.overview")).getByRole("button", { name: "button org.overview" }));
    expect(clicks).toEqual(["org.overview"]);
    const selected = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "some selected words" } as any);
    await user.click(surface("org.overview"));
    selected.mockRestore();
    for (const target of [surface("org.overview"), within(card("org.overview")).getByRole("link"), screen.getByRole("banner"), document.body]) {
      expect(fireEvent.contextMenu(target), "the browser's own menu is left alone").toBe(true);
    }
    expect(screen.queryByRole("menu")).toBeNull();
    expect(shown()).toEqual(IDS);
    expect(saves).toEqual([]);
  });

  it("closes on Escape and on a click elsewhere, and removes nothing", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(dotsOf("org.overview"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(dotsOf("org.overview"));
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.click(surface("org.kpi.active-products"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(shown()).toEqual(IDS);
    expect(saves).toEqual([]);
  });

  it("the three-dot button (keyboard and screen readers) opens a menu with Remove from Home and Edit Layout, and Escape returns focus to it", async () => {
    const user = userEvent.setup();
    mount();
    const dots = within(card("org.chart.collections")).getByRole("button", { name: `Options for ${NAME("org.chart.collections")}` });
    expect(dots.getAttribute("aria-haspopup")).toBe("menu");
    dots.focus();
    await user.keyboard("{Enter}");
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Remove from Home", "Edit Layout"]);
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Remove from Home" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Edit Layout" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(dots);
  });

  it("if saving fails the card comes back and the person is told", async () => {
    const user = userEvent.setup();
    respond = () => json(503, { error: "Your layout could not be saved just now. Please try again shortly." });
    mount();
    await removeViaDots(user, "org.chart.collections");
    expect((await screen.findByRole("alert")).textContent).toContain("could not be saved");
    await waitFor(() => expect(shown()).toContain("org.chart.collections"));
    expect(shown()).toEqual(IDS);
  });
});

describe("Add Widgets: bringing cards back", () => {
  const removeTwo = async (user: ReturnType<typeof userEvent.setup>) => {
    for (const id of ["org.kpi.active-products", "org.chart.collections"]) {
      await removeViaDots(user, id);
    }
  };

  it("lists each removed card with its icon, name, description and an Add Widget button", async () => {
    const user = userEvent.setup();
    mount();
    await removeTwo(user);
    const panel = await openAddWidgets(user);
    const rows = within(panel).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-widget-row"))).toEqual(["org.kpi.active-products", "org.chart.collections"]);
    expect(within(rows[0]).getByText("Active products")).toBeTruthy();
    expect(within(rows[0]).getByText("How many products are in your catalog.")).toBeTruthy();
    expect(rows[0].querySelector("svg")).toBeTruthy();
    expect(within(rows[0]).getByRole("button", { name: "Add Widget: Active products" }).textContent).toBe("Add Widget");
    expect(within(panel).queryByText("All widgets are on your dashboard.")).toBeNull();
  });

  it("adding one puts it at the END of the page, once, and saves", async () => {
    const user = userEvent.setup();
    mount();
    await removeTwo(user);
    const panel = await openAddWidgets(user);
    await user.click(within(panel).getByRole("button", { name: "Add Widget: Active products" }));
    expect(shown().filter((id) => id === "org.kpi.active-products")).toHaveLength(1);
    expect(shown()[shown().length - 1]).toBe("org.kpi.active-products");
    expect(within(panel).queryByRole("button", { name: "Add Widget: Active products" })).toBeNull();
    await waitFor(() => expect(saves.length).toBeGreaterThanOrEqual(3));
    expect(lastSave().hidden).toEqual(["org.chart.collections"]);
  });

  it("Restore All Widgets brings back everything that was removed, then the panel says all are back", async () => {
    const user = userEvent.setup();
    mount();
    await removeTwo(user);
    const panel = await openAddWidgets(user);
    await user.click(within(panel).getByRole("button", { name: "Restore All Widgets" }));
    expect(shown()).toHaveLength(IDS.length);
    expect(new Set(shown()).size).toBe(IDS.length);
    expect(shown().slice(-2)).toEqual(["org.kpi.active-products", "org.chart.collections"]);
    expect(within(panel).getByText("All widgets are on your dashboard.")).toBeTruthy();
    await waitFor(() => expect(lastSave().hidden).toEqual([]));
  });

  it("never lists a widget the person may not use: a hidden id of a switched-off module is ignored", async () => {
    const user = userEvent.setup();
    mount({ version: 1, revision: 2, order: [], hidden: ["org.finance.snapshot", "org.list.open-purchase-orders", "org.kpi.active-products"] });
    const panel = await openAddWidgets(user);
    expect(within(panel).getAllByRole("listitem").map((r) => r.getAttribute("data-widget-row"))).toEqual(["org.kpi.active-products"]);
  });

  it("removing every card leaves a designed empty state with an Add Widgets action; the sidebar is still there", async () => {
    const user = userEvent.setup();
    mount({ version: 1, revision: 2, order: [], hidden: IDS });
    expect(shown()).toEqual([]);
    expect(screen.getByRole("heading", { name: "Your dashboard is empty" })).toBeTruthy();
    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
    const empty = screen.getByRole("heading", { name: "Your dashboard is empty" }).closest("section")!;
    await user.click(within(empty).getByRole("button", { name: "Add Widgets" }));
    const panel = screen.getByRole("dialog", { name: "Your Widgets" });
    expect(within(panel).getAllByRole("listitem")).toHaveLength(IDS.length);
  });
});

describe("Edit Layout", () => {
  it("opens from the three-dot menu ('Edit Layout')", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(within(card("org.overview")).getByRole("button", { name: `Options for ${NAME("org.overview")}` }));
    await user.click(screen.getByRole("menuitem", { name: "Edit Layout" }));
    expect(screen.getByRole("toolbar", { name: "Edit layout" })).toBeTruthy();
  });

  const edit = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(within(card("org.overview")).getByRole("button", { name: `Options for ${NAME("org.overview")}` }));
    await user.click(screen.getByRole("menuitem", { name: "Edit Layout" }));
    return screen.getByRole("toolbar", { name: "Edit layout" });
  };
  const handle = (id: string) => within(card(id)).getByRole("button", { name: new RegExp(`^Move ${NAME(id).replace(/[()]/g, "\\$&")}\\.`) });

  it("shows the control bar and a drag handle on every card; the cards' own content is inert while arranging", async () => {
    const user = userEvent.setup();
    mount();
    const bar = await edit(user);
    expect(within(bar).getAllByRole("button").map((b) => b.textContent)).toEqual(["Reset Layout", "Cancel", "Save Layout"]);
    expect(document.querySelectorAll(".ix-widget-handle")).toHaveLength(IDS.length);
    expect(document.querySelector(".ix-edit-backdrop")).toBeTruthy();
    for (const id of IDS) expect(card(id).querySelector(".ix-widget-inner")!.hasAttribute("inert"), id).toBe(true);
    expect(document.querySelectorAll(".ix-widget-dots")).toHaveLength(0);
    await user.click(surface("org.overview")); // nothing opens while arranging
    expect(screen.queryByRole("menu")).toBeNull();
    expect((within(bar).getByRole("button", { name: "Save Layout" }) as HTMLButtonElement).disabled).toBe(true); // nothing changed yet
  });

  it("the arrow keys on a handle move the card; Save Layout stores the new order, cards keep their identity", async () => {
    const user = userEvent.setup();
    mount();
    const bar = await edit(user);
    const before = card("org.overview");
    handle("org.overview").focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(shown().slice(0, 3)).toEqual([IDS[1], IDS[2], IDS[0]]);
    expect(card("org.overview")).toBe(before); // the same element, moved
    expect(document.activeElement).toBe(handle("org.overview"));
    await user.keyboard("{End}");
    expect(shown()[IDS.length - 1]).toBe("org.overview");
    await user.keyboard("{Home}");
    expect(shown()[0]).toBe("org.overview");
    await user.keyboard("{ArrowDown}");
    expect(document.querySelector("[data-layout-announcer]")!.textContent).toContain("moved to position 2 of");
    expect(saves).toEqual([]); // nothing is saved until Save Layout
    await user.click(within(bar).getByRole("button", { name: "Save Layout" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(lastSave()).toEqual({ order: [IDS[1], "org.overview", ...IDS.slice(2)], hidden: [] });
    expect(shown()).toEqual(lastSave().order);
    for (const id of IDS) expect(card(id).querySelector(".ix-widget-inner")!.hasAttribute("inert")).toBe(false);
  });

  it("Cancel throws the changes away", async () => {
    const user = userEvent.setup();
    mount();
    await edit(user);
    handle("org.overview").focus();
    await user.keyboard("{End}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // unsaved changes: it asks first
    const ask = screen.getByRole("alertdialog", { name: "Discard layout changes?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("toolbar")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(shown()).toEqual(IDS);
    expect(saves).toEqual([]);
  });

  it("Escape leaves at once when nothing changed, and asks first when something did (a second Escape goes back to editing)", async () => {
    const user = userEvent.setup();
    mount();
    await edit(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("toolbar")).toBeNull();
    await edit(user);
    handle("org.overview").focus();
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog", { name: "Discard layout changes?" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("toolbar")).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(shown()).toEqual(IDS);
  });

  it("Reset Layout puts the visible cards back in the default order; hidden ones stay hidden; it saves only on Save Layout", async () => {
    const user = userEvent.setup();
    mount({ version: 1, revision: 2, order: [...IDS].reverse().filter((id) => id !== "org.kpi.active-products"), hidden: ["org.kpi.active-products"] });
    await user.click(within(card(shown()[0])).getByRole("button", { name: /^Options for / }));
    await user.click(screen.getByRole("menuitem", { name: "Edit Layout" }));
    await user.click(screen.getByRole("button", { name: "Reset Layout" }));
    expect(shown()).toEqual(IDS.filter((id) => id !== "org.kpi.active-products"));
    expect(saves).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save Layout" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(lastSave().hidden).toEqual(["org.kpi.active-products"]);
  });

  it("is also reachable from the Add Widgets panel (for touch screens)", async () => {
    const user = userEvent.setup();
    mount();
    const panel = await openAddWidgets(user);
    await user.click(within(panel).getByRole("button", { name: "Edit Layout" }));
    expect(screen.getByRole("toolbar", { name: "Edit layout" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Your Widgets" })).toBeNull();
    expect((screen.getByRole("button", { name: "Add Widgets" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("touch screens", () => {
  // jsdom has no PointerEvent: a minimal one that carries the pointer type, which is what tells a finger from a mouse
  class TestPointerEvent extends MouseEvent {
    pointerType: string; pointerId: number; isPrimary: boolean;
    constructor(type: string, init: any = {}) { super(type, init); this.pointerType = init.pointerType ?? ""; this.pointerId = init.pointerId ?? 1; this.isPrimary = init.isPrimary ?? true; }
  }
  beforeEach(() => { vi.stubGlobal("PointerEvent", TestPointerEvent); });
  const touch = (el: Element, type: "pointerDown" | "pointerMove" | "pointerUp", x = 40, y = 40) =>
    fireEvent[type](el, { pointerType: "touch", pointerId: 1, button: 0, clientX: x, clientY: y, isPrimary: true });

  it("a long press, a tap and the native long-press menu on a card's surface do nothing: the three-dot button is the way", () => {
    vi.useFakeTimers();
    mount();
    touch(surface("org.overview"), "pointerDown");
    act(() => { vi.advanceTimersByTime(1500); });
    touch(surface("org.overview"), "pointerUp");
    fireEvent.click(surface("org.overview"), { detail: 1 });
    expect(fireEvent.contextMenu(surface("org.overview"))).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(shown()).toEqual(IDS);
  });

  it("the three-dot button is a real button on every card (touch screens show it all the time: no hover needed)", () => {
    mount();
    for (const id of IDS) expect(dotsOf(id).tagName).toBe("BUTTON");
  });
});

describe("what is not a widget", () => {
  it("the notice that explains missing figures is not a widget: it cannot be removed", async () => {
    const user = userEvent.setup();
    render(
      <DashboardFrame admin={{ ...ADMIN, dashboard_layout: null } as any} organization={null}>
        <p role="alert">Organization details are temporarily unavailable. Please refresh in a moment.</p>
        <DashboardLayoutEditor nodes={nodes(["org.overview"])} />
      </DashboardFrame>,
    );
    expect(shown()).toEqual(["org.overview"]); // with no organization only the widget that needs nothing is available
    const alert = screen.getByRole("alert");
    expect(alert.closest("[data-widget-id]")).toBeNull();
    await user.click(alert);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
