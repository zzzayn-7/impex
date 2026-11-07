// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/finance/expenses" }));

import AccountsManager from "@/app/finance/accounts/accounts-manager";
import EntryDetailView from "@/app/finance/journal/[id]/entry-detail";
import EntryForm from "@/app/finance/journal/entry-form";
import ExpenseDetailView from "@/app/finance/expenses/[id]/expense-detail";
import ExpenseForm from "@/app/finance/expenses/expense-form";
import FinanceTabs from "@/app/finance/finance-tabs";
import SyncPanel from "@/app/finance/sync-panel";

const now = "2026-11-07T10:00:00+00:00";
const AR = "a0000000-0000-4000-8000-000000000001";
const REV = "a0000000-0000-4000-8000-000000000002";
const EXP = "a0000000-0000-4000-8000-000000000003";
const OLD = "a0000000-0000-4000-8000-000000000004";
const ENTRY = "e0000000-0000-4000-8000-000000000001";
const EXPENSE = "f0000000-0000-4000-8000-000000000001";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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
const headerOf = (call: Call, name: string) => (call.init.headers ?? {})[name];

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  router.push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const account = (id: string, code: string, name: string, type: string, extra: Record<string, unknown> = {}) => ({
  id, code, name, account_type: type, description: null, is_active: true, is_system: false, system_key: null, has_postings: false, created_at: now, updated_at: now, ...extra,
});
const chart = [
  account(AR, "1100", "Accounts Receivable", "asset", { is_system: true, system_key: "accounts_receivable" }), account(REV, "4000", "Sales Revenue", "revenue", { is_system: true, system_key: "sales_revenue" }),
  account(EXP, "5000", "General Expenses", "expense"), account(OLD, "5900", "Dormant costs", "expense", { is_active: false }),
];

// =====================================================================================================
// the journal entry form
// =====================================================================================================
describe("EntryForm", () => {
  const fill = async (opts: { debit?: string; credit?: string } = {}) => {
    await userEvent.type(screen.getByLabelText("Description"), "Opening sale");
    await userEvent.selectOptions(screen.getByLabelText("Account for line 1"), AR);
    await userEvent.selectOptions(screen.getByLabelText("Account for line 2"), REV);
    await userEvent.type(screen.getByLabelText("Debit for line 1"), opts.debit ?? "100.10");
    await userEvent.type(screen.getByLabelText("Credit for line 2"), opts.credit ?? "100.10");
  };
  const post = () => screen.getByRole("button", { name: /Post Entry/ }) as HTMLButtonElement;

  it("starts with the default currency, two empty lines, and nothing postable", () => {
    render(<EntryForm accounts={chart as any} defaultCurrency="EUR" />);
    expect((screen.getByLabelText("Currency") as HTMLInputElement).value).toBe("EUR");
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(post().disabled).toBe(true);
    expect(screen.getByText(/Debit \(EUR\)/)).toBeTruthy();
  });

  it("offers only active accounts", () => {
    render(<EntryForm accounts={chart as any} defaultCurrency="USD" />);
    const options = within(screen.getByLabelText("Account for line 1")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("5000 General Expenses");
    expect(options).not.toContain("5900 Dormant costs");
  });

  it("shows exact running totals and the difference, and allows posting only when it balances", async () => {
    render(<EntryForm accounts={chart as any} defaultCurrency="USD" />);
    await fill({ debit: "0.1", credit: "0.3" });
    expect(screen.getByTestId("total-debits").textContent).toBe("0.10");
    expect(screen.getByTestId("total-credits").textContent).toBe("0.30");
    expect(screen.getByRole("status").textContent).toContain("Out of balance by 0.20 USD: credits are higher");
    expect(post().disabled).toBe(true);
    await userEvent.clear(screen.getByLabelText("Debit for line 1"));
    await userEvent.type(screen.getByLabelText("Debit for line 1"), "0.3");
    expect(screen.getByRole("status").textContent).toContain("Balanced");
    expect(post().disabled).toBe(false);
  });

  it("entering a debit clears the credit on that line (one side per line)", async () => {
    render(<EntryForm accounts={chart as any} defaultCurrency="USD" />);
    await userEvent.type(screen.getByLabelText("Credit for line 1"), "5");
    await userEvent.type(screen.getByLabelText("Debit for line 1"), "7");
    expect((screen.getByLabelText("Credit for line 1") as HTMLInputElement).value).toBe("");
  });

  it("adds and removes lines but never goes below two", async () => {
    render(<EntryForm accounts={chart as any} defaultCurrency="USD" />);
    await userEvent.click(screen.getByRole("button", { name: "Add line" }));
    expect(screen.getAllByRole("combobox")).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "Remove line 3" }));
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Remove line 1" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("posts with an Idempotency-Key, only fields the form owns, and goes to the new entry", async () => {
    stubFetch(() => json(201, { entry: { id: ENTRY }, replayed: false }));
    render(<EntryForm accounts={chart as any} defaultCurrency="USD" />);
    await fill();
    await userEvent.click(post());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/finance/journal/${ENTRY}`));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/finance/journal-entries");
    expect(headerOf(calls[0], "Idempotency-Key")).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
    expect(bodyOf(calls[0])).toEqual({ entryDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), description: "Opening sale", reference: "", currencyCode: "USD", post: true, lines: [
      { accountId: AR, debit: "100.10", credit: "0", description: "" }, { accountId: REV, debit: "0", credit: "100.10", description: "" }] });
    expect(JSON.stringify(bodyOf(calls[0]))).not.toMatch(/organization|status|entryNumber|total/i);
  });

  it("saving as a draft does not post", async () => {
    stubFetch(() => json(201, { entry: { id: ENTRY } }));
    render(<EntryForm accounts={chart as any} defaultCurrency="USD" />);
    await fill({ debit: "5", credit: "9" }); // unbalanced drafts are allowed
    await userEvent.click(screen.getByRole("button", { name: "Save as Draft" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(bodyOf(calls[0]).post).toBe(false);
  });

  it("a retry after a refused attempt gets a NEW key, but a double click reuses the same one", async () => {
    let n = 0;
    stubFetch(async () => (++n === 1 ? json(400, { error: "The entry does not balance.", code: "unbalanced" }) : json(201, { entry: { id: ENTRY } })));
    render(<EntryForm accounts={chart as any} defaultCurrency="USD" />);
    await fill();
    await userEvent.click(post());
    expect((await screen.findByRole("alert")).textContent).toContain("does not balance");
    await userEvent.click(post());
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(headerOf(calls[0], "Idempotency-Key")).not.toBe(headerOf(calls[1], "Idempotency-Key"));
  });

  it("ignores a second click while the first is in flight", async () => {
    let release: (r: Response) => void = () => undefined;
    stubFetch(() => new Promise<Response>((resolve) => { release = resolve; }));
    render(<EntryForm accounts={chart as any} defaultCurrency="USD" />);
    await fill();
    const button = post();
    await userEvent.click(button);
    await userEvent.click(button); // (the button is now busy)
    expect(calls).toHaveLength(1);
    release(json(201, { entry: { id: ENTRY } }));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
  });

  it("shows the service's field errors and sends an expired session to the login page", async () => {
    stubFetch(() => json(400, { error: "Please correct the highlighted fields.", fieldErrors: { description: "Describe the entry." } }));
    render(<EntryForm accounts={chart as any} defaultCurrency="USD" />);
    await fill();
    await userEvent.click(post());
    expect(await screen.findByText("Describe the entry.")).toBeTruthy();
    stubFetch(() => json(401, { error: "Your session has expired." }));
    await userEvent.click(post());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("editing a draft saves with PUT, then posts it in a second step if asked", async () => {
    const draft = { id: ENTRY, entry_date: "2026-11-05", description: "WIP", reference: null, currency_code: "EUR", lines: [
      { id: "l1", line_no: 1, account_id: AR, account_code: "1100", account_name: "AR", debit: "10.0000", credit: "0.0000", description: null },
      { id: "l2", line_no: 2, account_id: REV, account_code: "4000", account_name: "Rev", debit: "0.0000", credit: "10.0000", description: null }] };
    stubFetch((url) => (url.endsWith("/post") ? json(200, { entry: { id: ENTRY, status: "posted" } }) : json(200, { entry: { id: ENTRY } })));
    render(<EntryForm accounts={chart as any} defaultCurrency="USD" entry={draft as any} />);
    expect((screen.getByLabelText("Currency") as HTMLInputElement).value).toBe("EUR"); // the entry's own currency, not the default
    expect((screen.getByLabelText("Debit for line 1") as HTMLInputElement).value).toBe("10.0000");
    await userEvent.click(post());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/finance/journal/${ENTRY}`));
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([`PUT /api/finance/journal-entries/${ENTRY}`, `POST /api/finance/journal-entries/${ENTRY}/post`]);
  });
});

// =====================================================================================================
// the journal entry page
// =====================================================================================================
describe("EntryDetailView", () => {
  const lines = [
    { id: "l1", line_no: 1, account_id: AR, account_code: "1100", account_name: "Accounts Receivable", debit: "10.0000", credit: "0.0000", description: null },
    { id: "l2", line_no: 2, account_id: REV, account_code: "4000", account_name: "Sales Revenue", debit: "0.0000", credit: "10.0000", description: null },
  ];
  const entry = (extra: Record<string, unknown> = {}) => ({
    id: ENTRY, entry_number: "JE-000001", entry_date: "2026-11-05", description: "Sale", reference: null, currency_code: "USD", status: "posted", source_type: "manual", source_summary: null, total: "10.0000",
    reverses_entry_id: null, reversed_by_entry_id: null, created_by_email: "a@b.c", posted_at: now, created_at: now, source_key: null, reversal_reason: null, posted_by_email: "a@b.c",
    total_debit: "10.0000", total_credit: "10.0000", is_balanced: true, lines, history: [], can_reverse: true, ...extra,
  });

  it("reverses a posted entry with a reason, then opens the reversal", async () => {
    stubFetch(() => json(201, { entry: { id: "rev-1" } }));
    render(<EntryDetailView entry={entry() as any} />);
    await userEvent.click(screen.getByRole("button", { name: "Reverse Entry" }));
    const region = screen.getByRole("region", { name: "Reverse this entry" });
    const submit = within(region).getByRole("button", { name: "Post Reversal" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // a reason is required
    await userEvent.type(within(region).getByLabelText("Reason"), "Entered twice");
    expect(submit.disabled).toBe(false);
    await userEvent.click(submit);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/finance/journal/rev-1"));
    expect(calls[0].url).toBe(`/api/finance/journal-entries/${ENTRY}/reverse`);
    expect(bodyOf(calls[0])).toEqual({ reason: "Entered twice" });
  });

  it("reports a reversal the service refused", async () => {
    stubFetch(() => json(409, { error: "This entry was already reversed by JE-000002.", code: "already_reversed" }));
    render(<EntryDetailView entry={entry() as any} />);
    await userEvent.click(screen.getByRole("button", { name: "Reverse Entry" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Entered twice");
    await userEvent.click(screen.getByRole("button", { name: "Post Reversal" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already reversed");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("offers no actions on a posted entry that cannot be reversed", () => {
    render(<EntryDetailView entry={entry({ can_reverse: false, reversed_by_entry_id: "r" }) as any} />);
    expect(screen.queryByRole("button", { name: "Reverse Entry" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard Draft" })).toBeNull();
  });

  it("posts a balanced draft; discards a draft only after confirming", async () => {
    const draft = entry({ status: "draft", entry_number: null, posted_at: null, total: null, can_reverse: false });
    stubFetch((url, init) => (init.method === "DELETE" ? json(200, { ok: true }) : json(200, { entry: entry() })));
    render(<EntryDetailView entry={draft as any} />);
    await userEvent.click(screen.getByRole("button", { name: "Post Entry" }));
    expect(await screen.findByText("JE-000001 was posted.")).toBeTruthy();
    cleanup();
    render(<EntryDetailView entry={draft as any} />);
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole("button", { name: "Discard Draft" }));
    expect(calls.filter((c) => c.init.method === "DELETE")).toHaveLength(0); // not confirmed: nothing happens
    await userEvent.click(screen.getByRole("button", { name: "Discard Draft" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/finance/journal"));
  });

  it("will not post an unbalanced draft", () => {
    render(<EntryDetailView entry={entry({ status: "draft", entry_number: null, is_balanced: false, can_reverse: false }) as any} />);
    expect((screen.getByRole("button", { name: "Post Entry" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// =====================================================================================================
// expenses
// =====================================================================================================
describe("ExpenseForm", () => {
  const categories = chart.filter((a) => a.account_type === "expense");
  const fill = async () => {
    await userEvent.type(screen.getByLabelText("Description"), "Printer paper");
    await userEvent.selectOptions(screen.getByLabelText("Category"), EXP);
    await userEvent.type(screen.getByLabelText("Amount"), "25.5");
  };

  it("offers only active categories and the default currency", () => {
    render(<ExpenseForm categories={categories as any} defaultCurrency="EUR" />);
    expect((screen.getByLabelText("Currency") as HTMLInputElement).value).toBe("EUR");
    const options = within(screen.getByLabelText("Category")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("5000 General Expenses");
    expect(options).not.toContain("5900 Dormant costs");
  });

  it("checks the category and amount before sending anything", async () => {
    stubFetch(() => json(201, { expense: { id: EXPENSE } }));
    render(<ExpenseForm categories={categories as any} defaultCurrency="USD" />);
    await userEvent.type(screen.getByLabelText("Description"), "x");
    await userEvent.type(screen.getByLabelText("Amount"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Save and Post" }));
    expect(await screen.findByText("Choose an expense category.")).toBeTruthy();
    expect(screen.getByText(/Enter an amount above zero/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("saves and posts with an Idempotency-Key and never an organization, status or number", async () => {
    stubFetch(() => json(201, { expense: { id: EXPENSE } }));
    render(<ExpenseForm categories={categories as any} defaultCurrency="USD" />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Save and Post" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/finance/expenses/${EXPENSE}`));
    expect(headerOf(calls[0], "Idempotency-Key")).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
    expect(bodyOf(calls[0])).toEqual({ expenseDate: expect.any(String), description: "Printer paper", vendor: "", reference: "", accountId: EXP, amount: "25.5", currencyCode: "USD", post: true });
  });

  it("never claims to move money", () => {
    render(<ExpenseForm categories={categories as any} defaultCurrency="USD" />);
    expect(screen.getByText(/does not move money or touch any bank account/)).toBeTruthy();
  });
});

describe("ExpenseDetailView", () => {
  const expense = (extra: Record<string, unknown> = {}) => ({
    id: EXPENSE, number: "EXP-000001", expense_date: "2026-11-05", description: "Printer paper", reference: null, vendor: null, account_id: EXP, account_code: "5000", account_name: "General Expenses",
    amount: "25.5000", currency_code: "USD", status: "posted", journal_entry_id: ENTRY, reversal_entry_id: null, created_by_email: "a@b.c", posted_at: now, posted_by_email: "a@b.c",
    reversed_at: null, reversed_by_email: null, reversal_reason: null, created_at: now, history: [], ...extra,
  });

  it("reverses with a reason", async () => {
    stubFetch(() => json(200, { expense: expense({ status: "reversed", reversal_entry_id: "r", reversed_at: now, reversed_by_email: "a@b.c", reversal_reason: "Duplicate receipt" }) }));
    render(<ExpenseDetailView expense={expense() as any} />);
    await userEvent.click(screen.getByRole("button", { name: "Reverse Expense" }));
    const region = screen.getByRole("region", { name: "Reverse this expense" });
    await userEvent.type(within(region).getByLabelText("Reason"), "Duplicate receipt");
    await userEvent.click(within(region).getByRole("button", { name: "Reverse Expense" }));
    expect(await screen.findByText("EXP-000001 was reversed.")).toBeTruthy();
    expect(bodyOf(calls[0])).toEqual({ reason: "Duplicate receipt" });
    expect(screen.queryByRole("button", { name: "Reverse Expense" })).toBeNull(); // (a reversed expense cannot be reversed again)
  });

  it("posts a draft and deletes one only after confirming", async () => {
    const draft = expense({ status: "draft", journal_entry_id: null, posted_at: null, posted_by_email: null });
    stubFetch((url, init) => (init.method === "DELETE" ? json(200, { ok: true }) : json(200, { expense: expense() })));
    render(<ExpenseDetailView expense={draft as any} />);
    await userEvent.click(screen.getByRole("button", { name: "Post Expense" }));
    expect(await screen.findByText("EXP-000001 was posted to your books.")).toBeTruthy();
    cleanup();
    render(<ExpenseDetailView expense={draft as any} />);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Delete Draft" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/finance/expenses"));
  });
});

// =====================================================================================================
// accounts
// =====================================================================================================
describe("AccountsManager", () => {
  it("adds an account, keeping the chart in code order", async () => {
    stubFetch(() => json(201, { account: account("new-1", "5050", "Marketing", "expense") }));
    render(<AccountsManager initial={chart as any} />);
    await userEvent.click(screen.getByRole("button", { name: "New Account" }));
    const form = screen.getByRole("form", { name: "New account" });
    await userEvent.type(within(form).getByLabelText("Code"), "5050");
    await userEvent.type(within(form).getByLabelText("Name"), "Marketing");
    await userEvent.click(within(form).getByRole("button", { name: "Add Account" }));
    expect(await screen.findByText("5050 Marketing was added.")).toBeTruthy();
    expect(bodyOf(calls[0])).toEqual({ code: "5050", name: "Marketing", accountType: "expense", description: "" });
    const codes = screen.getAllByRole("row").map((r) => within(r).queryByText(/^\d{4}$/)?.textContent).filter(Boolean);
    expect(codes).toEqual(["1100", "4000", "5000", "5050", "5900"]);
  });

  it("shows the service's refusal of a duplicate code next to the field", async () => {
    stubFetch(() => json(409, { error: "Another account already uses this code.", code: "duplicate_code" }));
    render(<AccountsManager initial={chart as any} />);
    await userEvent.click(screen.getByRole("button", { name: "New Account" }));
    const form = screen.getByRole("form", { name: "New account" });
    await userEvent.type(within(form).getByLabelText("Code"), "5000");
    await userEvent.type(within(form).getByLabelText("Name"), "Dup");
    await userEvent.click(within(form).getByRole("button", { name: "Add Account" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already uses this code");
  });

  it("system accounts offer no Delete or Deactivate, only a rename", () => {
    render(<AccountsManager initial={chart as any} />);
    const receivable = screen.getByText("Accounts Receivable").closest("tr")!;
    expect(within(receivable).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(receivable).queryByRole("button", { name: "Deactivate" })).toBeNull();
    expect(within(receivable).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(receivable).getByText("System")).toBeTruthy();
  });

  it("deactivates and reactivates; deletes only after confirming", async () => {
    stubFetch((url, init) => {
      if (init.method === "DELETE") return json(200, { ok: true });
      const sent = JSON.parse(init.body);
      return json(200, { account: account(EXP, "5000", "General Expenses", "expense", { is_active: sent.isActive }) });
    });
    render(<AccountsManager initial={chart as any} />);
    const row = () => screen.getByText("General Expenses").closest("tr")!;
    await userEvent.click(within(row()).getByRole("button", { name: "Deactivate" }));
    expect(await screen.findByText(/is now inactive/)).toBeTruthy();
    expect(bodyOf(calls[0])).toEqual({ isActive: false });
    await userEvent.click(within(row()).getByRole("button", { name: "Reactivate" }));
    await screen.findByText(/is now active/);
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(within(row()).getByRole("button", { name: "Delete" }));
    expect(calls.filter((c) => c.init.method === "DELETE")).toHaveLength(0);
    await userEvent.click(within(row()).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("General Expenses")).toBeNull());
  });

  it("filters by type, status and search without calling the service", async () => {
    stubFetch(() => json(200, {}));
    render(<AccountsManager initial={chart as any} />);
    await userEvent.selectOptions(screen.getByLabelText("Type"), "expense");
    expect(screen.queryByText("Accounts Receivable")).toBeNull();
    expect(screen.getByText("General Expenses")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "active");
    expect(screen.queryByText("Dormant costs")).toBeNull();
    await userEvent.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByText("No accounts match.")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("edits a name in place", async () => {
    stubFetch(() => json(200, { account: account(EXP, "5000", "Sundry", "expense") }));
    render(<AccountsManager initial={chart as any} />);
    await userEvent.click(within(screen.getByText("General Expenses").closest("tr")!).getByRole("button", { name: "Edit" }));
    const input = screen.getByLabelText("Name");
    await userEvent.clear(input);
    await userEvent.type(input, "Sundry");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Sundry")).toBeTruthy();
    expect(bodyOf(calls[0])).toEqual({ name: "Sundry", description: "" });
  });
});

// =====================================================================================================
// synchronisation panel and tabs
// =====================================================================================================
describe("SyncPanel", () => {
  it("syncs on request and reports the outcome", async () => {
    stubFetch(() => json(200, { result: { received: 2, posted: 2, skipped: 0, retrying: 0, failed: 0 } }));
    render(<SyncPanel failed={0} />);
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect((await screen.findByRole("status")).textContent).toContain("2 new events received, 2 posted");
    expect(calls[0].url).toBe("/api/finance/sync/run");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("explains a failure without pretending anything was posted", async () => {
    stubFetch(() => json(503, { error: "The finance service is unavailable. Please try again shortly." }));
    render(<SyncPanel failed={0} />);
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect((await screen.findByRole("alert")).textContent).toContain("unavailable");
  });

  it("lists failed events and retries one", async () => {
    const event = { id: "ev-1", source: "sales", event_key: "invoice-issued:abc", event_type: "invoice.issued", event_time: now, status: "failed", attempts: 1, last_error: "the invoice total is not subtotal - discount + tax", journal_entry_id: null, processed_at: null, created_at: now };
    stubFetch((url) => (url.includes("/retry") ? json(200, { event: { ...event, status: "pending" } }) : json(200, { items: [event], total: 1, limit: 50, offset: 0 })));
    render(<SyncPanel failed={1} />);
    await userEvent.click(screen.getByRole("button", { name: /Show the 1 failed event/ }));
    expect(await screen.findByText("invoice-issued:abc")).toBeTruthy();
    expect(screen.getByText(/nothing was posted and nothing was guessed/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("invoice-issued:abc")).toBeNull());
    expect(calls.at(-1)!.url).toBe("/api/finance/sync/events/ev-1/retry");
  });
});

describe("FinanceTabs", () => {
  it("lists the four Finance pages and marks the current one", () => {
    render(<FinanceTabs />);
    const nav = screen.getByRole("navigation", { name: "Finance" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Financial Overview", "Accounts", "Expenses", "Journal Entries"]);
    expect(within(nav).getByRole("link", { name: "Expenses" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Financial Overview" }).getAttribute("aria-current")).toBeNull();
  });
});
