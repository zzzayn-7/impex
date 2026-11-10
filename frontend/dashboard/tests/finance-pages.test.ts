import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { alphaOrg, orgAdmin, orgAdminB, superAdmin } from "./helpers";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
  usePathname: () => "/finance/journal",
}));

import FinanceLayout from "@/app/finance/layout";
import OverviewPage from "@/app/finance/accounting/page"; // the accounting overview (the Finance page itself is tested in finance-page.test.tsx)
import AccountsPage from "@/app/finance/accounts/page";
import JournalPage from "@/app/finance/journal/page";
import NewEntryPage from "@/app/finance/journal/new/page";
import EntryPage from "@/app/finance/journal/[id]/page";
import EditEntryPage from "@/app/finance/journal/[id]/edit/page";
import ExpensesPage from "@/app/finance/expenses/page";
import NewExpensePage from "@/app/finance/expenses/new/page";
import ExpensePage from "@/app/finance/expenses/[id]/page";
import EditExpensePage from "@/app/finance/expenses/[id]/edit/page";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = "2026-11-07T10:00:00+00:00";
const A_AR = "a1111111-1111-4111-8111-000000000001";
const A_REV = "a1111111-1111-4111-8111-000000000002";
const A_EXP = "a1111111-1111-4111-8111-000000000003";
const A_CUSTOM = "a1111111-1111-4111-8111-000000000004";
const A_POSTED = "a1111111-1111-4111-8111-aaaaaaaaaaaa";
const A_DRAFT = "a1111111-1111-4111-8111-dddddddddddd";
const A_REVERSED = "a1111111-1111-4111-8111-eeeeeeeeeeee";
const A_REVERSAL = "a1111111-1111-4111-8111-ffffffffffff";
const A_SYNCED = "a1111111-1111-4111-8111-cccccccccccc";
const A_EXPENSE = "a1111111-1111-4111-8111-bbbbbbbbbbbb";
const A_EXPENSE_DRAFT = "a1111111-1111-4111-8111-bbbbbbbbbbbc";
const B_ENTRY = "b2222222-2222-4222-8222-bbbbbbbbbbbb";

const account = (id: string, code: string, name: string, type: string, extra: Record<string, unknown> = {}) => ({
  id, code, name, account_type: type, description: null, is_active: true, is_system: false, system_key: null, has_postings: false, created_at: now, updated_at: now, ...extra,
});
const summary = (id: string, number: string | null, description: string, extra: Record<string, unknown> = {}) => ({
  id, entry_number: number, entry_date: "2026-11-05", description, reference: null, currency_code: "USD", status: number ? "posted" : "draft", source_type: "manual", source_summary: null,
  total: number ? "125.5000" : null, reverses_entry_id: null, reversed_by_entry_id: null, created_by_email: "owner@acme.example", posted_at: number ? now : null, created_at: now, ...extra,
});
const line = (account_id: string, code: string, name: string, debit: string, credit: string) => ({ id: crypto.randomUUID(), line_no: 1, account_id, account_code: code, account_name: name, debit, credit, description: null });
const detail = (s: ReturnType<typeof summary>, extra: Record<string, unknown> = {}) => ({
  ...s, source_key: null, reversal_reason: null, posted_by_email: s.posted_at ? "owner@acme.example" : null, total_debit: "125.5000", total_credit: "125.5000", is_balanced: true,
  lines: [line(A_AR, "1100", "Accounts Receivable", "125.5000", "0.0000"), line(A_REV, "4000", "Sales Revenue", "0.0000", "125.5000")],
  history: [{ seq: 1, action: "created", actor_email: "owner@acme.example", source: "user", detail: "manual entry, USD", created_at: now }, ...(s.posted_at ? [{ seq: 2, action: "posted", actor_email: "owner@acme.example", source: "user", detail: "JE-000001", created_at: now }] : [])],
  can_reverse: s.status === "posted" && s.source_type !== "reversal" && s.source_type !== "expense" && !s.reversed_by_entry_id, ...extra,
});
const expense = (id: string, number: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, number, expense_date: "2026-11-05", description: "Printer paper", reference: "R-1", vendor: "Paper Co", account_id: A_EXP, account_code: "5000", account_name: "General Expenses", amount: "25.5000",
  currency_code: "USD", status, journal_entry_id: status === "draft" ? null : A_POSTED, reversal_entry_id: null, created_by_email: "owner@acme.example", posted_at: status === "draft" ? null : now,
  posted_by_email: status === "draft" ? null : "owner@acme.example", reversed_at: null, reversed_by_email: null, reversal_reason: null, created_at: now, ...extra,
});
const withHistory = (e: ReturnType<typeof expense>) => ({ ...e, history: [{ seq: 1, action: "created", actor_email: "owner@acme.example", source: "user", detail: "EXP-000001, 25.5000 USD", created_at: now }] });

const fresh = () => {
  const posted = summary(A_POSTED, "JE-000001", "Opening sale");
  const draft = summary(A_DRAFT, null, "Work in progress");
  const reversed = summary(A_REVERSED, "JE-000002", "Wrong amount", { reversed_by_entry_id: A_REVERSAL });
  const reversal = summary(A_REVERSAL, "JE-000003", "Reversal of JE-000002", { source_type: "reversal", reverses_entry_id: A_REVERSED });
  const synced = summary(A_SYNCED, "JE-000004", "Invoice INV-000001 issued to Acme", { source_type: "sales", source_summary: "Invoice INV-000001 issued to Acme", currency_code: "EUR", created_by_email: null });
  return {
    "token-alpha": {
      accounts: [
        account(A_AR, "1100", "Accounts Receivable", "asset", { is_system: true, system_key: "accounts_receivable", has_postings: true }), account(A_REV, "4000", "Sales Revenue", "revenue", { is_system: true, system_key: "sales_revenue" }),
        account(A_EXP, "5000", "General Expenses", "expense"), account(A_CUSTOM, "5900", "Dormant costs", "expense", { is_active: false }),
      ],
      entries: [posted, draft, reversed, reversal, synced],
      details: {
        [A_POSTED]: detail(posted), [A_DRAFT]: detail(draft, { is_balanced: false, total_credit: "100.0000" }), [A_REVERSED]: detail(reversed, { can_reverse: false }),
        [A_REVERSAL]: detail(reversal, { reversal_reason: "Entered twice" }), [A_SYNCED]: detail(synced, { source_key: "invoice-issued:abc", history: [{ seq: 1, action: "created", actor_email: null, source: "sync", detail: null, created_at: now }] }),
      } as Record<string, any>,
      expenses: [expense(A_EXPENSE, "EXP-000001", "posted"), expense(A_EXPENSE_DRAFT, "EXP-000002", "draft")],
      expenseDetails: { [A_EXPENSE]: withHistory(expense(A_EXPENSE, "EXP-000001", "posted")), [A_EXPENSE_DRAFT]: withHistory(expense(A_EXPENSE_DRAFT, "EXP-000002", "draft")) } as Record<string, any>,
      overview: {
        default_currency: "USD", activated_at: "2026-11-01T00:00:00+00:00", accounts: 4, active_accounts: 3, draft_entries: 1, posted_entries: 4, draft_expenses: 1, posted_expenses: 1,
        totals_by_currency: [
          { currency_code: "EUR", assets: "40.0000", liabilities: "0.0000", equity: "0.0000", revenue: "40.0000", expenses: "0.0000", posted_entries: 1 },
          { currency_code: "USD", assets: "125.5000", liabilities: "0.0000", equity: "0.0000", revenue: "125.5000", expenses: "0.0000", posted_entries: 3 },
        ],
        recent_entries: [posted, synced],
        sync: { sources: [
          { source: "sales", status: "ok", last_attempt_at: now, last_success_at: now, last_error: null, consecutive_failures: 0 },
          { source: "purchasing", status: "error", last_attempt_at: now, last_success_at: null, last_error: "Purchasing Service: ConnectError", consecutive_failures: 3 },
        ], pending: 2, failed: 1, skipped: 0, posted: 5 },
      },
    },
    "token-beta": {
      accounts: [account(crypto.randomUUID(), "1100", "Beta receivable", "asset")], entries: [summary(B_ENTRY, "JE-000001", "Beta's private entry")], details: { [B_ENTRY]: detail(summary(B_ENTRY, "JE-000001", "Beta's private entry")) } as Record<string, any>,
      expenses: [], expenseDetails: {} as Record<string, any>,
      overview: { default_currency: "EUR", activated_at: "2026-11-02T00:00:00+00:00", accounts: 1, active_accounts: 1, draft_entries: 0, posted_entries: 1, draft_expenses: 0, posted_expenses: 0, totals_by_currency: [], recent_entries: [], sync: { sources: [], pending: 0, failed: 0, skipped: 0, posted: 0 } },
    },
  };
};
let world = fresh();
let modules: string[] = ["inventory", "purchasing", "sales", "finance"];
let calls: { url: string; headers: Record<string, string>; method: string }[] = [];

function stubWorld(options: { status?: number } = {}) {
  calls = [];
  const users: Record<string, any> = { "token-alpha": orgAdmin, "token-beta": orgAdminB, "token-super": superAdmin };
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers, method: init.method ?? "GET" });
    const token = (headers.Authorization ?? "").replace("Bearer ", "");
    if (url.endsWith("/api/v1/auth/me")) return users[token] ? json(200, users[token]) : json(401, {});
    if (url.endsWith("/api/v1/tenant/organization")) return users[token] ? json(200, { ...alphaOrg, modules }) : json(401, {});
    if (!url.includes("/api/v1/finance/")) return json(404, {});
    if (options.status) return json(options.status, { detail: "x" });
    const org = (world as any)[token];
    if (!org) return json(401, {});
    const target = new URL(url);
    const path = target.pathname.replace("/api/v1/finance", "");
    const p = target.searchParams;
    const page = (items: any[]) => json(200, { items, total: items.length, limit: Number(p.get("limit")), offset: Number(p.get("offset")) });
    if (path === "/overview") return json(200, org.overview);
    if (path === "/accounts") return json(200, org.accounts.filter((a: any) => (!p.get("type") || a.account_type === p.get("type")) && (!p.get("active") || String(a.is_active) === p.get("active"))));
    if (path === "/journal-entries") return page(org.entries.filter((e: any) => (!p.get("status") || e.status === p.get("status")) && (!p.get("q") || e.description.toLowerCase().includes(p.get("q")!.toLowerCase()))));
    if (path === "/expenses") return page(org.expenses.filter((e: any) => !p.get("status") || e.status === p.get("status")));
    let match = path.match(/^\/journal-entries\/([^/]+)$/);
    if (match) return org.details[match[1]] ? json(200, org.details[match[1]]) : json(404, { detail: "Journal entry not found." });
    match = path.match(/^\/expenses\/([^/]+)$/);
    if (match) return org.expenseDetails[match[1]] ? json(200, org.expenseDetails[match[1]]) : json(404, { detail: "Expense not found." });
    return json(404, {});
  }));
}
const financeCalls = () => calls.filter((c) => c.url.includes("/api/v1/finance/"));
const render = async (element: Promise<any>) => renderToStaticMarkup(await element);

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.FINANCE_SERVICE_URL = "http://finance-service:8006";
  for (const key of Object.keys(jar)) delete jar[key];
  world = fresh();
  modules = ["inventory", "purchasing", "sales", "finance"];
});
afterEach(() => vi.unstubAllGlobals());

describe("the Finance layout", () => {
  it("is inside the protected frame, with ONE Finance entry in the navigation and a way back on the accounting pages", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = renderToStaticMarkup(await FinanceLayout({ children: "CONTENT" }));
    expect(html).toContain('href="/finance"');
    for (const gone of ["Financial Overview", "Journal Entries", 'href="/finance/accounts"', 'href="/finance/expenses"', 'href="/finance/journal"']) expect(html, gone).not.toContain(gone); // not in the sidebar any more
    expect(html).toContain("← Finance"); // (the mocked path is /finance/journal: the way back to the Finance page)
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("CONTENT");
    expect(html).toContain("Sign out");
  });

  it("shows nothing of the module when Finance is not enabled for the organization (and fetches nothing)", async () => {
    modules = ["inventory", "purchasing", "sales"];
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = renderToStaticMarkup(await FinanceLayout({ children: "CONTENT" }));
    expect(html).toContain("Finance is not enabled for your organization");
    expect(html).toContain("/support/new?module=finance");
    expect(html).not.toContain("CONTENT");
    expect(html).not.toContain('href="/finance"'); // not even in the menu
    expect(financeCalls()).toHaveLength(0);
  });

  it("needs a tenant session: no cookie, a Super Admin session or a bad token goes to the login page", async () => {
    stubWorld();
    await expect(render(FinanceLayout({ children: "x" }))).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(render(FinanceLayout({ children: "x" }))).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "nope";
    await expect(render(FinanceLayout({ children: "x" }))).rejects.toThrow("REDIRECT:/login");
  });
});

describe("Financial Overview", () => {
  it("shows real records: counts, each currency on its own, the latest entries and the synchronisation's health", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(OverviewPage());
    for (const expected of ["Financial Overview", "Position by currency", "EUR", "USD", "40.00", "125.50", "JE-000001", "Opening sale", "Posted journal entries", "Accounts (3 active)"]) expect(html, expected).toContain(expected);
    expect(html).toMatch(/Never added together|never added together/);
    expect(html).toContain("Purchasing Service: ConnectError");
    expect(html).toContain("trying again automatically (3 attempts so far)");
    expect(html).toContain("1 failed");
    expect(html).toContain("Sync now");
    expect(html).toContain("Posted entries can never be edited or deleted");
    expect(html).toContain("a purchase order alone creates nothing");
  });

  it("never adds different currencies together or invents a total", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(OverviewPage());
    expect(html).not.toContain("165.50"); // 125.50 USD + 40.00 EUR must never appear
    expect(html).not.toMatch(/exchange rate:|converted to/i);
  });

  it("is empty-state friendly", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const html = await render(OverviewPage());
    expect(html).toContain("Nothing is posted yet");
    expect(html).toContain("No journal entries yet");
  });

  it("uses the session's token only and sends no organization anywhere", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    await render(OverviewPage());
    const sent = financeCalls();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((c) => c.headers.Authorization === "Bearer token-beta" && !/organization/i.test(c.url))).toBe(true);
  });

  it("explains an outage or an inactive organization and redirects an expired session", async () => {
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ status: 503 });
    expect(await render(OverviewPage())).toContain("temporarily unavailable");
    stubWorld({ status: 403 });
    expect(await render(OverviewPage())).toContain("currently inactive or unavailable");
    stubWorld({ status: 401 });
    await expect(render(OverviewPage())).rejects.toThrow("REDIRECT:/login");
  });
});

describe("Accounts", () => {
  it("groups the chart by type and marks what is protected", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(AccountsPage());
    for (const expected of ["Accounts Receivable", "Sales Revenue", "General Expenses", "Dormant costs", "Assets", "Revenue", "Expenses", "System", "Has postings", "Inactive"]) expect(html, expected).toContain(expected);
    expect(html).not.toMatch(/<h3[^>]*>Liabilities</); // (no liability account in this chart: no empty group)
    // a system account offers neither Delete nor Deactivate; an unused custom one offers Deactivate and Delete
    const row = (code: string) => html.slice(html.indexOf(`>${code}<`), html.indexOf("</tr>", html.indexOf(`>${code}<`)));
    expect(row("1100")).not.toMatch(/Delete|Deactivate/);
    expect(row("4000")).not.toMatch(/Delete|Deactivate/);
    expect(row("5000")).toMatch(/Deactivate/);
    expect(row("5000")).toMatch(/Delete/);
    expect(row("5900")).toMatch(/Reactivate/);
  });

  it("shows only this organization's chart", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const html = await render(AccountsPage());
    expect(html).toContain("Beta receivable");
    expect(html).not.toContain("Accounts Receivable");
  });
});

describe("Journal Entries", () => {
  it("lists entries with their status, source and exact totals", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(JournalPage({ searchParams: {} }));
    for (const expected of ["JE-000001", "Opening sale", "Draft", "Posted", "Work in progress", "Sales", "Reversal", "Invoice INV-000001 issued to Acme", "125.50", "Reversed", "New Journal Entry"]) expect(html, expected).toContain(expected);
  });

  it("reads only known filters from the address and passes them on", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await render(JournalPage({ searchParams: { status: "posted", q: "  sale ", source: "sales", currency: "eur", account: A_AR, from: "2026-11-01", to: "x", page: "3", organization_id: "evil", extra: "1" } }));
    const sent = new URL(financeCalls().find((c) => c.url.includes("/journal-entries"))!.url).searchParams;
    expect(Object.fromEntries(sent)).toEqual({ limit: "25", offset: "50", q: "sale", status: "posted", source: "sales", currency: "EUR", account_id: A_AR, date_from: "2026-11-01" });
    await render(JournalPage({ searchParams: { status: "bogus", source: "bogus", currency: "euro", account: "nope", from: "yesterday", page: "-4" } }));
    const plain = new URL(financeCalls().filter((c) => c.url.includes("/journal-entries")).at(-1)!.url).searchParams;
    expect(Object.fromEntries(plain)).toEqual({ limit: "25", offset: "0" });
  });

  it("shows no one else's entries", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const html = await render(JournalPage({ searchParams: {} }));
    expect(html).toContain("Beta&#x27;s private entry");
    expect(html).not.toContain("Opening sale");
  });

  it("an outage is explained", async () => {
    stubWorld({ status: 503 });
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render(JournalPage({ searchParams: {} }))).toContain("temporarily unavailable");
  });

  it("a posted entry shows its lines, totals, provenance and history, and offers Reverse - never Edit or Delete", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(EntryPage({ params: { id: A_POSTED } }));
    for (const expected of ["JE-000001", "Opening sale", "Accounts Receivable", "Sales Revenue", "125.50", "Totals", "Created by", "Posted by", "owner@acme.example", "History", "Posted", "Reverse Entry"]) expect(html, expected).toContain(expected);
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain("Discard Draft");
    expect(html).not.toContain("Post Entry");
  });

  it("a draft offers Edit, Post and Discard (Post disabled while it does not balance)", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(EntryPage({ params: { id: A_DRAFT } }));
    expect(html).toContain("Draft journal entry");
    expect(html).toContain(">Edit<");
    expect(html).toContain("Discard Draft");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Post Entry/);
    expect(html).toContain("does not balance yet");
    expect(html).not.toContain("Reverse Entry");
  });

  it("a reversed entry says so and links to its reversal; a reversal links back; neither can be reversed again", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const reversed = await render(EntryPage({ params: { id: A_REVERSED } }));
    expect(reversed).toContain("was reversed by");
    expect(reversed).toContain(`href="/finance/journal/${A_REVERSAL}"`);
    expect(reversed).not.toContain("Reverse Entry");
    const reversal = await render(EntryPage({ params: { id: A_REVERSAL } }));
    expect(reversal).toContain("This entry reverses");
    expect(reversal).toContain(`href="/finance/journal/${A_REVERSED}"`);
    expect(reversal).toContain("Entered twice");
    expect(reversal).not.toContain("Reverse Entry");
  });

  it("an entry posted by the synchronisation shows that no person did it and which event it came from", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(EntryPage({ params: { id: A_SYNCED } }));
    expect(html).toContain("automatic synchronisation");
    expect(html).toContain("invoice-issued:abc");
    expect(html).toContain("each source event is posted once");
  });

  it("another organization's entry, an unknown id and a malformed id all say 'not found' - the last without asking the service", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render(EntryPage({ params: { id: B_ENTRY } }))).toContain("Journal entry not found.");
    expect(await render(EntryPage({ params: { id: crypto.randomUUID() } }))).toContain("Journal entry not found.");
    const before = financeCalls().length;
    expect(await render(EntryPage({ params: { id: "../../etc/passwd" } }))).toContain("Journal entry not found.");
    expect(financeCalls().length).toBe(before);
  });

  it("the new-entry form starts with the organization's default currency and only active accounts", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const html = await render(NewEntryPage());
    expect(html).toContain("New Journal Entry");
    expect(html).toContain('value="EUR"'); // Beta's default currency
    expect(html).toContain("Beta receivable");
    expect(html).toContain("Save as Draft");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Post Entry/); // nothing to post yet
  });

  it("only a draft can be edited: a posted entry explains how to correct it", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render(EditEntryPage({ params: { id: A_POSTED } }))).toContain("A posted journal entry can never be edited");
    const draft = await render(EditEntryPage({ params: { id: A_DRAFT } }));
    expect(draft).toContain("Edit draft entry");
    expect(draft).toContain("Work in progress");
    expect(await render(EditEntryPage({ params: { id: B_ENTRY } }))).toContain("Journal entry not found.");
  });
});

describe("Expenses", () => {
  it("lists expenses with category, exact amount and status", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(ExpensesPage({ searchParams: {} }));
    for (const expected of ["EXP-000001", "EXP-000002", "Printer paper", "Paper Co", "5000 General Expenses", "25.50", "USD", "Posted", "Draft", "does not move money", "Record Expense"]) expect(html, expected).toContain(expected);
  });

  it("reads only known filters", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await render(ExpensesPage({ searchParams: { status: "draft", category: A_EXP, currency: "usd", from: "2026-11-01", to: "bad", q: " paper ", page: "2", organization_id: "evil" } }));
    const sent = new URL(financeCalls().find((c) => c.url.includes("/expenses"))!.url).searchParams;
    expect(Object.fromEntries(sent)).toEqual({ limit: "25", offset: "25", q: "paper", status: "draft", account_id: A_EXP, currency: "USD", date_from: "2026-11-01" });
  });

  it("a posted expense links to its posting and offers only Reverse; a draft offers Edit, Post and Delete", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const posted = await render(ExpensePage({ params: { id: A_EXPENSE } }));
    expect(posted).toContain("EXP-000001");
    expect(posted).toContain(`href="/finance/journal/${A_POSTED}"`);
    expect(posted).toContain("Reverse Expense");
    expect(posted).not.toContain(">Edit<");
    expect(posted).not.toContain("Delete Draft");
    expect(posted).toContain("does not move money or touch any bank account");
    const draft = await render(ExpensePage({ params: { id: A_EXPENSE_DRAFT } }));
    for (const expected of [">Edit<", "Post Expense", "Delete Draft"]) expect(draft, expected).toContain(expected);
    expect(draft).not.toContain("Reverse Expense");
  });

  it("someone else's expense, an unknown one and a malformed id are all 'not found'", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    expect(await render(ExpensePage({ params: { id: A_EXPENSE } }))).toContain("Expense not found.");
    expect(await render(ExpensePage({ params: { id: "nope" } }))).toContain("Expense not found.");
  });

  it("the form offers only active expense categories, the default currency and drafting or posting", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render(NewExpensePage());
    expect(html).toContain("Record Expense");
    expect(html).toContain("5000 General Expenses");
    expect(html).not.toContain("1100 Accounts Receivable"); // (the stub filters by type; the page asks only for expense accounts)
    expect(html).toContain('value="USD"');
    expect(html).toContain("Save as Draft");
    expect(html).toContain("Save and Post");
  });

  it("only a draft expense can be edited", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render(EditExpensePage({ params: { id: A_EXPENSE } }))).toContain("A posted expense can never be edited");
    expect(await render(EditExpensePage({ params: { id: A_EXPENSE_DRAFT } }))).toContain("Edit EXP-000002");
  });
});

describe("every Finance page needs a signed-in tenant administrator", () => {
  it.each([
    ["overview", () => OverviewPage()],
    ["accounts", () => AccountsPage()],
    ["journal", () => JournalPage({ searchParams: {} })],
    ["new entry", () => NewEntryPage()],
    ["entry", () => EntryPage({ params: { id: A_POSTED } })],
    ["expenses", () => ExpensesPage({ searchParams: {} })],
    ["new expense", () => NewExpensePage()],
    ["expense", () => ExpensePage({ params: { id: A_EXPENSE } })],
  ])("%s redirects to /login without a session, with a Super Admin session or with an expired one", async (_name, page) => {
    stubWorld();
    await expect(render(page() as any)).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(render(page() as any)).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "expired";
    await expect(render(page() as any)).rejects.toThrow("REDIRECT:/login");
    expect(financeCalls()).toHaveLength(0);
  });
});
