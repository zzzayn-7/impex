import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultOrderOf, hideOne, moveTo, parseStored, readSubmission, resolveLayout, showEvery, showOne, withRetained, type WidgetMeta,
} from "@/lib/dashboard-layout";
import { ORG_WIDGETS, ORG_WIDGET_IDS, availableOrgWidgets } from "@/lib/dashboard-widgets";

// The rules every home page follows, whatever the portal: how a saved arrangement is read against the widgets a person may use, how a card is removed and
// restored, and what a browser is allowed to submit. Plus the Organization Portal's widget registry: stable unique ids, module access, and the same list
// as the Auth Service's.

const W = (id: string, size: WidgetMeta["size"] = "medium"): WidgetMeta => ({ id, name: id.toUpperCase(), description: `about ${id}`, size, icon: "grid" });
const ALL = [W("a"), W("b"), W("c"), W("d")];
const saved = (order: string[], hidden: string[], revision = 1) => ({ version: 1, revision, order, hidden });

describe("resolving a saved layout", () => {
  it("shows every widget in the default order when nothing was ever saved", () => {
    expect(resolveLayout(ALL, null)).toEqual({ order: ["a", "b", "c", "d"], hidden: [], revision: 0 });
    expect(resolveLayout(ALL, undefined).order).toEqual(["a", "b", "c", "d"]);
  });

  it("applies the saved order and the hidden widgets", () => {
    expect(resolveLayout(ALL, saved(["c", "a"], ["b"], 4))).toEqual({ order: ["c", "a", "d"], hidden: ["b"], revision: 4 }); // d was never mentioned: added at the end, visible
  });

  it("ignores identifiers that are not available (retired, or a module that is off), repeats, and a widget listed as both", () => {
    expect(resolveLayout(ALL, saved(["zzz", "b", "b", "a"], ["gone", "c", "c", "a"]))).toEqual({ order: ["b", "d"], hidden: ["c", "a"], revision: 1 });
  });

  it("a damaged document reads as 'never customised'", () => {
    for (const junk of ["text", 7, [], { order: "a", hidden: [] }, { order: [1], hidden: [] }, { order: [] }]) expect(resolveLayout(ALL, junk).order, JSON.stringify(junk)).toEqual(["a", "b", "c", "d"]);
    expect(parseStored({ order: ["a"], hidden: [] })).toEqual({ version: 1, revision: 0, order: ["a"], hidden: [] });
  });

  it("a widget that becomes available later (its module came back) appears at the end", () => {
    const before = resolveLayout(ALL.slice(0, 3), saved(["c", "b", "a"], []));
    expect(before.order).toEqual(["c", "b", "a"]);
    expect(resolveLayout(ALL, saved(["c", "b", "a"], [])).order).toEqual(["c", "b", "a", "d"]);
  });
});

describe("changing a layout", () => {
  const base = { order: ["a", "b", "c"], hidden: ["d"], revision: 2 };

  it("removing a card moves it to the hidden ones and changes nothing else", () => {
    expect(hideOne(base, "b")).toEqual({ order: ["a", "c"], hidden: ["d", "b"], revision: 2 });
    expect(hideOne(base, "nope")).toBe(base);
    expect(hideOne(base, "d")).toBe(base); // already hidden
  });

  it("adding one back puts it at the END, once", () => {
    expect(showOne(base, "d")).toEqual({ order: ["a", "b", "c", "d"], hidden: [], revision: 2 });
    expect(showOne(showOne(base, "d"), "d").order).toEqual(["a", "b", "c", "d"]);
    expect(showOne(base, "a")).toBe(base);
  });

  it("Restore All puts every hidden widget back at the end in the default order", () => {
    const layout = { order: ["c"], hidden: ["d", "a", "b"], revision: 1 };
    expect(showEvery(ALL, layout)).toEqual({ order: ["c", "a", "b", "d"], hidden: [], revision: 1 });
  });

  it("Reset Layout is the default order of the visible widgets; hidden ones stay out", () => {
    expect(defaultOrderOf(ALL, ["b"])).toEqual(["a", "c", "d"]);
  });

  it("moves a card to a place (clamped)", () => {
    expect(moveTo(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveTo(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
    expect(moveTo(["a", "b", "c"], "b", -5)).toEqual(["b", "a", "c"]);
    expect(moveTo(["a", "b"], "zzz", 0)).toEqual(["a", "b"]);
  });
});

describe("what a browser may submit", () => {
  const ids = ["a", "b", "c"];
  it("accepts two lists of known, distinct identifiers", () => {
    expect(readSubmission({ order: ["b", "a"], hidden: ["c"] }, ids)).toEqual({ ok: true, order: ["b", "a"], hidden: ["c"] });
    expect(readSubmission({ order: [], hidden: [] }, ids).ok).toBe(true);
  });
  it.each([
    [{ order: ["a", "a"], hidden: [] }], [{ order: ["a"], hidden: ["a"] }], [{ order: ["zzz"], hidden: [] }], [{ order: ["<script>"], hidden: [] }],
    [{ order: "a", hidden: [] }], [{ order: [1], hidden: [] }], [{ order: ["a"] }], [{ hidden: [] }], [null], ["a"], [[]],
    [{ order: ["a"], hidden: [], css: "x" }], [{ order: ["a"], hidden: [], user_id: "u" }], [{ order: ["a"], hidden: [], html: "<b>" }],
  ])("refuses %j", (body) => {
    expect(readSubmission(body, ids).ok).toBe(false);
  });
  it("refuses an absurd number of widgets", () => {
    const many = Array.from({ length: 70 }, (_, i) => `w${i}`);
    expect(readSubmission({ order: many, hidden: [] }, many).ok).toBe(false);
  });
});

describe("what is kept for widgets the person cannot use right now", () => {
  it("carries their saved place and hidden state along, after the person's own choices", () => {
    const stored = saved(["x", "a"], ["y"]);
    expect(withRetained({ order: ["b", "a"], hidden: ["c"] }, stored, ["a", "b", "c"])).toEqual({ order: ["b", "a", "x"], hidden: ["c", "y"] });
    expect(withRetained({ order: ["a"], hidden: [] }, null, ["a"])).toEqual({ order: ["a"], hidden: [] });
  });
});

describe("the Organization widget registry", () => {
  it("has stable, unique identifiers; a KPI and the list of the same records are different widgets", () => {
    expect(ORG_WIDGET_IDS).toEqual([
      "org.overview", "org.kpi.active-products", "org.kpi.open-purchase-orders", "org.kpi.invoiced-this-month", "org.kpi.outstanding-receivables",
      "org.chart.sales-purchasing-trend", "org.chart.collections", "org.chart.inventory-activity", "org.list.recent-invoices", "org.list.open-purchase-orders",
      "org.list.recent-stock-movements", "org.finance.snapshot", "org.panel.modules", "org.panel.quick-actions", "org.panel.organization",
    ]);
    expect(new Set(ORG_WIDGET_IDS).size).toBe(ORG_WIDGET_IDS.length);
    expect(new Set(ORG_WIDGETS.map((w) => w.name)).size).toBe(ORG_WIDGETS.length);
    for (const w of ORG_WIDGETS) { expect(w.description.length, w.id).toBeGreaterThan(10); expect(["small", "medium", "half", "full"]).toContain(w.size); }
  });

  it("every widget is available with all four modules; the organization's own cards need the organization", () => {
    expect(availableOrgWidgets(["inventory", "purchasing", "sales", "finance"], true).map((w) => w.id)).toEqual(ORG_WIDGET_IDS);
    expect(availableOrgWidgets(["inventory", "purchasing", "sales", "finance"], false).map((w) => w.id)).toEqual(["org.overview"]);
    expect(availableOrgWidgets(undefined, false).map((w) => w.id)).toEqual(["org.overview"]);
  });

  it("a widget of a module that is off is not available (and nothing leaks through the dependencies)", () => {
    const ids = (modules: string[]) => availableOrgWidgets(modules, true).map((w) => w.id);
    expect(ids(["inventory"])).toEqual(["org.overview", "org.kpi.active-products", "org.chart.inventory-activity", "org.list.recent-stock-movements", "org.panel.modules", "org.panel.quick-actions", "org.panel.organization"]);
    expect(ids(["inventory", "sales"])).toContain("org.kpi.outstanding-receivables");
    expect(ids(["inventory", "sales"])).not.toContain("org.kpi.open-purchase-orders");
    expect(ids(["inventory", "purchasing"])).toContain("org.chart.sales-purchasing-trend"); // either of the two modules feeds it
    expect(ids(["finance"])).toContain("org.finance.snapshot");
    expect(ids(["finance"])).not.toContain("org.kpi.active-products");
    expect(ids([])).toEqual(["org.overview", "org.panel.modules", "org.panel.quick-actions", "org.panel.organization"]);
  });

  it.skipIf(!existsSync(join(process.cwd(), "..", "..", "services/auth-service/app/dashboard_layout.py")))("is the same list as the Auth Service's", () => {
    const py = readFileSync(join(process.cwd(), "..", "..", "services/auth-service/app/dashboard_layout.py"), "utf-8");
    const block = py.slice(py.indexOf("ORG_WIDGET_IDS"), py.indexOf("ADMIN_WIDGET_IDS"));
    expect(Array.from(block.matchAll(/"(org\.[a-z.-]+)"/g), (m) => m[1])).toEqual(ORG_WIDGET_IDS);
  });
});
