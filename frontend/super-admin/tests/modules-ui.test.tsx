// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import ModuleManager from "@/app/organizations/[id]/modules/module-manager";

const ORG = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const now = "2026-11-07T10:00:00+00:00";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const state = (enabled: Record<string, boolean>, revision = 4) => ({
  organization_id: ORG, organization_name: "Alpha Trading GmbH", revision,
  modules: [
    { key: "inventory", name: "Inventory", description: "Stock.", features: ["Products"], requires: [], available: true, enabled: enabled.inventory, effective: enabled.inventory, updated_at: now, updated_by_name: "Sam Super" },
    { key: "purchasing", name: "Purchasing", description: "Buying.", features: ["Suppliers"], requires: ["inventory"], available: true, enabled: enabled.purchasing, effective: enabled.purchasing, updated_at: null, updated_by_name: null },
    { key: "sales", name: "Sales", description: "Selling.", features: ["Clients"], requires: ["inventory"], available: true, enabled: enabled.sales, effective: enabled.sales, updated_at: null, updated_by_name: null },
    { key: "finance", name: "Finance", description: "Planned.", features: ["Accounting"], requires: [], available: false, enabled: false, effective: false, updated_at: null, updated_by_name: null },
  ],
  permanent: [{ key: "support", name: "Help & Support", description: "Always available." }],
});
const base = { inventory: true, purchasing: false, sales: false };
const history = { total: 1, items: [{ id: "h", module: "inventory", module_name: "Inventory", action: "seeded", old_enabled: null, new_enabled: true, changed_by_name: "System", changed_by_email: null, reason: null, batch_id: "b", created_at: now }] };
const preview = (over: Record<string, unknown> = {}) => ({ revision: 4, changes: [{ module: "sales", name: "Sales", from_enabled: false, to_enabled: true }], blockers: [], warnings: [], can_apply: true, ...over });

type Call = { url: string; init: any };
let calls: Call[] = [];
function stubFetch(handler: (url: string, init: any) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }));
}
const bodyOf = (call: Call) => JSON.parse(call.init.body);
const toggle = (name: string) => screen.getByRole("switch", { name: `${name} enabled` }) as HTMLInputElement;

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Finance as the service reports it once released (Step 21A): a module like the others, switched on only by the Super Admin.
const withFinanceReleased = (enabled: Record<string, boolean>) => {
  const s = state(enabled);
  s.modules = s.modules.map((m) => (m.key === "finance" ? { ...m, description: "Accounts, journal and expenses.", features: ["Accounts", "Expenses"], available: true, enabled: Boolean(enabled.finance), effective: Boolean(enabled.finance) } : m));
  return s;
};

describe("ModuleManager", () => {
  it("lets the Super Admin switch Finance on once it is released (off by default), and reviews it like any other module", async () => {
    stubFetch((url) => (url.endsWith("/preview") ? json(200, { preview: preview({ changes: [{ module: "finance", name: "Finance", from_enabled: false, to_enabled: true }] }) }) : json(200, history)));
    render(<ModuleManager initial={withFinanceReleased(base)} initialHistory={history} />);
    expect(toggle("Finance").checked).toBe(false);
    expect(toggle("Finance").disabled).toBe(false);
    expect(screen.queryByText("Planned: not available yet")).toBeNull();
    await userEvent.click(toggle("Finance"));
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await screen.findByRole("region", { name: "Review changes" });
    expect(bodyOf(calls[0])).toEqual({ changes: { finance: true } });
  });

  it("shows what is on, what is off, and that Finance is planned and cannot be switched", () => {
    render(<ModuleManager initial={state(base)} initialHistory={history} />);
    expect(toggle("Inventory").checked).toBe(true);
    expect(toggle("Sales").checked).toBe(false);
    expect(toggle("Finance").disabled).toBe(true);
    expect(screen.getByText("Planned: not available yet")).toBeTruthy();
    expect(screen.getByText("Always available")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review changes" }) as HTMLButtonElement).disabled).toBe(true); // nothing to review yet
  });

  it("review, then confirm: nothing is saved until the second step, and the actor is not a field", async () => {
    stubFetch((url) => (url.endsWith("/preview") ? json(200, { preview: preview() }) : url.includes("/history") ? json(200, history) : json(200, { state: state({ ...base, sales: true }, 5) })));
    render(<ModuleManager initial={state(base)} initialHistory={history} />);
    await userEvent.click(toggle("Sales"));
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    const review = await screen.findByRole("region", { name: "Review changes" });
    expect(review.textContent).toContain("Disabled → Enabled");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`/api/organizations/${ORG}/modules/preview`);
    expect(bodyOf(calls[0])).toEqual({ changes: { sales: true } });
    await userEvent.type(within(review).getByLabelText(/Reason/), "Approved in SUP-000123");
    await userEvent.click(within(review).getByRole("button", { name: "Confirm changes" }));
    await screen.findByText(/Saved\./);
    const put = calls.find((c) => c.init.method === "PUT")!;
    expect(put.url).toBe(`/api/organizations/${ORG}/modules`);
    expect(bodyOf(put)).toEqual({ changes: { sales: true }, expected_revision: 4, reason: "Approved in SUP-000123" });
    expect(toggle("Sales").checked).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("next request");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("shows blockers and warnings in the review, and Confirm stays disabled while it is blocked", async () => {
    const blockers = [{ code: "pending_operations", module: "sales", message: "Sales has operations in progress that must finish first.", counts: [{ code: "dispatches_posting", label: "Dispatches being posted to stock", count: 2 }] }];
    const warnings = [{ module: "sales", code: "invoices_unpaid", label: "Invoices not fully paid", count: 3 }];
    stubFetch(() => json(200, { preview: preview({ changes: [{ module: "sales", name: "Sales", from_enabled: true, to_enabled: false }], blockers, warnings, can_apply: false }) }));
    render(<ModuleManager initial={state({ ...base, sales: true })} initialHistory={history} />);
    await userEvent.click(toggle("Sales"));
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    const review = await screen.findByRole("region", { name: "Review changes" });
    expect(within(review).getByRole("alert").textContent).toContain("This cannot be applied yet");
    expect(within(review).getByText(/2 × Dispatches being posted to stock/)).toBeTruthy();
    expect(within(review).getByText(/3 × Invoices not fully paid/)).toBeTruthy();
    expect(within(review).getByText(/Nothing is deleted/)).toBeTruthy();
    expect((within(review).getByRole("button", { name: "Confirm changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.init.method === "PUT")).toBe(false);
  });

  it("going back changes nothing", async () => {
    stubFetch(() => json(200, { preview: preview() }));
    render(<ModuleManager initial={state(base)} initialHistory={history} />);
    await userEvent.click(toggle("Sales"));
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await userEvent.click(await screen.findByRole("button", { name: "Back to editing" }));
    expect(screen.queryByRole("region", { name: "Review changes" })).toBeNull();
    expect(calls.every((c) => c.init.method !== "PUT")).toBe(true);
  });

  it("a review that went out of date is refused and re-reviewed from the current state", async () => {
    let previews = 0;
    stubFetch((url, init) => {
      if (init.method === "PUT") return json(409, { error: "The module settings changed since you reviewed them. Review the current state and confirm again.", code: "stale_revision" });
      previews += 1;
      return json(200, { preview: preview({ revision: previews === 1 ? 4 : 6 }) });
    });
    render(<ModuleManager initial={state(base)} initialHistory={history} />);
    await userEvent.click(toggle("Sales"));
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm changes" }));
    await screen.findByText(/changed since you reviewed them/);
    await waitFor(() => expect(previews).toBe(2));
    stubFetch((url) => (url.includes("/history") ? json(200, history) : json(200, { state: state({ ...base, sales: true }, 7) })));
    await userEvent.click(screen.getByRole("button", { name: "Confirm changes" }));
    await screen.findByText(/Saved\./);
    expect(bodyOf(calls[0]).expected_revision).toBe(6); // the second confirmation carries the NEW revision
  });

  it("a refusal from the service (blocked by a dependency) is shown and nothing is claimed saved", async () => {
    const blockers = [{ code: "required_by", module: "inventory", message: "Inventory cannot be disabled while Sales is enabled. Disable it first." }];
    stubFetch((url, init) => (init.method === "PUT" ? json(409, { error: "This change cannot be applied.", code: "blocked", blockers }) : json(200, { preview: preview({ changes: [{ module: "inventory", name: "Inventory", from_enabled: true, to_enabled: false }], blockers: [], can_apply: true }) })));
    render(<ModuleManager initial={state({ ...base, sales: true })} initialHistory={history} />);
    await userEvent.click(toggle("Inventory"));
    expect(screen.getByText(/Sales needs Inventory|needs Inventory/)).toBeTruthy(); // a hint while choosing
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm changes" }));
    await screen.findByText("This change cannot be applied.");
    expect(screen.queryByText(/Saved\./)).toBeNull();
    expect(toggle("Inventory").checked).toBe(false); // the choice is still there to correct
  });

  it("an enabled dependent is hinted when its requirement is switched off, and a dependent needs its requirement chosen too", async () => {
    render(<ModuleManager initial={state({ inventory: false, purchasing: false, sales: false })} initialHistory={history} />);
    await userEvent.click(toggle("Sales"));
    expect(screen.getByText(/Sales needs Inventory: enable it in the same change/)).toBeTruthy();
    await userEvent.click(toggle("Inventory"));
    expect(screen.queryByText(/Sales needs Inventory/)).toBeNull();
  });

  it("sends the person to sign in again when the session has ended", async () => {
    stubFetch(() => json(401, { error: "Your session has expired. Please sign in again." }));
    render(<ModuleManager initial={state(base)} initialHistory={history} />);
    await userEvent.click(toggle("Sales"));
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("shows who changed what, and when, in the history", () => {
    render(<ModuleManager initial={state(base)} initialHistory={{ total: 2, items: [{ ...history.items[0], id: "a", action: "disabled", module_name: "Sales", changed_by_name: "Sam Super", changed_by_email: "sam@impex.example", reason: "Contract ended" }, history.items[0]] }} />);
    const table = within(screen.getByRole("region", { name: "History" })).getByRole("table");
    expect(within(table).getByText("Disabled")).toBeTruthy();
    expect(within(table).getByText("Sam Super")).toBeTruthy();
    expect(within(table).getByText("sam@impex.example")).toBeTruthy();
    expect(within(table).getByText("Contract ended")).toBeTruthy();
    expect(within(table).getAllByText("2026-11-07 10:00 UTC")).toHaveLength(2);
  });
});
