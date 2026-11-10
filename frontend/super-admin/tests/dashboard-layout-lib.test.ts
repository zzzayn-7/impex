import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultOrderOf, hideOne, moveTo, parseStored, readSubmission, resolveLayout, showEvery, showOne, withRetained, type WidgetMeta,
} from "@/lib/dashboard-layout";
import { ADMIN_WIDGETS, ADMIN_WIDGET_IDS } from "@/lib/dashboard-widgets";

// The rules every home page follows, whatever the portal: how a saved arrangement is read against the widgets a person may use, how a card is removed and
// restored, and what a browser is allowed to submit. Plus the Super Admin Portal's widget registry: stable unique ids, its own namespace, and the same
// list as the Auth Service's.

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

describe("the Super Admin widget registry", () => {
  it("has the seven widgets of the Super Admin dashboard, with stable unique identifiers in their own namespace", () => {
    expect(ADMIN_WIDGET_IDS).toEqual([
      "admin.kpi.active-tenants", "admin.kpi.system-uptime", "admin.kpi.api-gateway-requests", "admin.kpi.pending-approvals",
      "admin.panel.microservice-registry", "admin.panel.docker-compose", "admin.panel.api-documentation",
    ]);
    expect(ADMIN_WIDGET_IDS.every((id) => id.startsWith("admin."))).toBe(true);
    expect(ADMIN_WIDGET_IDS.some((id) => id.startsWith("org."))).toBe(false); // the Organization Portal's widgets are not copied here
    expect(ADMIN_WIDGETS.map((w) => w.name)).toEqual(["Active Tenants", "System Uptime", "API Gateway Requests", "Pending Approvals", "Microservice Registry", "Docker Compose Stack", "API Documentation"]);
    expect(ADMIN_WIDGETS.filter((w) => w.size === "small")).toHaveLength(4); // the four metric cards
    expect(ADMIN_WIDGETS.find((w) => w.id === "admin.panel.microservice-registry")!.size).toBe("full"); // the wide table
    for (const w of ADMIN_WIDGETS) expect(w.description.length, w.id).toBeGreaterThan(10);
  });

  it.skipIf(!existsSync(join(process.cwd(), "..", "..", "services/auth-service/app/dashboard_layout.py")))("is the same list as the Auth Service's", () => {
    const py = readFileSync(join(process.cwd(), "..", "..", "services/auth-service/app/dashboard_layout.py"), "utf-8");
    const block = py.slice(py.indexOf("ADMIN_WIDGET_IDS: Tuple"), py.indexOf("_BY_ROLE"));
    expect(Array.from(block.matchAll(/"(admin\.[a-z.-]+)"/g), (m) => m[1])).toEqual(ADMIN_WIDGET_IDS);
  });
});
