import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeFinanceFailure } from "@/lib/finance";
import { balanceOf, linesPayload } from "@/lib/finance-browser";
import { parseEntryBody, parseEntryLines, parseExpenseBody, parseReason } from "@/lib/finance-routes";
import { GET as listAccounts, POST as createAccount } from "@/app/api/finance/accounts/route";
import { DELETE as deleteAccount, PATCH as patchAccount } from "@/app/api/finance/accounts/[id]/route";
import { GET as listEntries, POST as createEntry } from "@/app/api/finance/journal-entries/route";
import { DELETE as discardEntry, GET as getEntry, PUT as putEntry } from "@/app/api/finance/journal-entries/[id]/route";
import { POST as entryAction } from "@/app/api/finance/journal-entries/[id]/[action]/route";
import { GET as listExpenses, POST as createExpense } from "@/app/api/finance/expenses/route";
import { DELETE as deleteExpense, GET as getExpense, PUT as putExpense } from "@/app/api/finance/expenses/[id]/route";
import { POST as expenseAction } from "@/app/api/finance/expenses/[id]/[action]/route";
import { POST as syncRun } from "@/app/api/finance/sync/run/route";
import { GET as syncEvents } from "@/app/api/finance/sync/events/route";
import { POST as retryEvent } from "@/app/api/finance/sync/events/[id]/retry/route";

const ID = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const TOKEN = "session-token-abc";
const FINANCE = "http://finance-service:8006";
const KEY = "ui-3f2b8c1e-0000-4000-8000-000000000001";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
const stub = (handler: (url: string, init: any) => Response) => {
  fetchMock = vi.fn(async (url: any, init: any) => handler(String(url), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
};
const request = (method: string, body?: unknown, { cookie = `impex_tenant_session=${TOKEN}`, query = "", key }: { cookie?: string | null; query?: string; key?: string } = {}) =>
  new NextRequest(`http://localhost:3001/api/finance/x${query}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const upstream = () => ({ url: fetchMock.mock.calls[0][0] as string, init: fetchMock.mock.calls[0][1] as any });
const sentBody = () => JSON.parse(upstream().init.body);
const params = (extra: Record<string, string> = {}) => ({ params: { id: ID, ...extra } });

beforeEach(() => {
  process.env.FINANCE_SERVICE_URL = FINANCE;
  stub(() => json(200, {}));
});
afterEach(() => vi.unstubAllGlobals());

const ENTRY = { entryDate: "2026-11-05", description: "Opening balance", reference: "OB-1", currencyCode: "eur", lines: [{ accountId: ACCOUNT, debit: "100.50", credit: "" }, { accountId: ID, debit: "0", credit: "100.50", description: "  Equity  " }] };
const EXPENSE = { expenseDate: "2026-11-05", description: "  Printer   paper ", vendor: "Paper Co", reference: "R-1", accountId: ACCOUNT, amount: "25.5", currencyCode: "usd" };

// =====================================================================================================
// exact money, in the browser, identical to the Finance Service
// =====================================================================================================
describe("balanceOf: the running totals of an entry being typed", () => {
  const line = (accountId: string, debit = "", credit = "") => ({ accountId, debit, credit, description: "" });

  it("is exact where floating point is not", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    const b = balanceOf([line("a", "0.3"), line("b", "", "0.1"), line("c", "", "0.2")]);
    expect(b).toMatchObject({ debits: "0.3000", credits: "0.3000", difference: "0.0000", balanced: true, problem: null });
    expect(balanceOf([line("a", "1"), line("b", "", "0.3333"), line("c", "", "0.3333"), line("d", "", "0.3334")]).balanced).toBe(true);
    expect(balanceOf([line("a", "99999999999999.9999"), line("b", "", "99999999999999.9999")]).balanced).toBe(true);
  });

  it("is not balanced until debits equal credits, with a difference to show", () => {
    const b = balanceOf([line("a", "100"), line("b", "", "99.99")]);
    expect(b).toMatchObject({ balanced: false, difference: "0.0100" });
    expect(balanceOf([line("a", "50"), line("b", "", "60")])).toMatchObject({ balanced: false, difference: "-10.0000" });
  });

  it("needs two real lines, an account on each, one side per line, and a positive amount", () => {
    expect(balanceOf([line("a", "5"), line("", "", "5")]).problem).toContain("Line 2: choose an account");
    expect(balanceOf([line("a", "5", "5"), line("b", "", "5")]).problem).toContain("Line 1: use either a debit or a credit");
    expect(balanceOf([line("a", "0"), line("b", "", "0")]).problem).toContain("enter a debit or a credit amount");
    expect(balanceOf([line("a", "1.23456"), line("b", "", "1")]).problem).toContain("at most 4 decimals");
    expect(balanceOf([line("a", "abc"), line("b", "", "1")]).balanced).toBe(false);
    expect(balanceOf([line("a", "5")]).balanced).toBe(false);
    expect(balanceOf([line("", ""), line("", "")])).toMatchObject({ balanced: false, problem: null });
  });

  it("sends only the touched lines, blank sides as zero", () => {
    expect(linesPayload([{ accountId: "a", debit: "5", credit: "", description: " x " }, { accountId: "", debit: "", credit: "", description: "" }, { accountId: "b", debit: "", credit: "5", description: "" }])).toEqual([
      { accountId: "a", debit: "5", credit: "0", description: "x" }, { accountId: "b", debit: "0", credit: "5", description: "" },
    ]);
  });
});

// =====================================================================================================
// request parsing
// =====================================================================================================
describe("parsing what the browser sends", () => {
  it("entry lines: only an account id, exact amounts and a note are read", () => {
    const ok = parseEntryLines([{ accountId: ACCOUNT, debit: "1.5", credit: "", description: " n ", organization_id: "x", status: "posted" }]);
    expect(ok).toEqual({ ok: true, value: [{ account_id: ACCOUNT, debit: "1.5", credit: "0", description: "n" }] });
    for (const bad of [[{ accountId: "nope", debit: "1" }], [{ accountId: ACCOUNT, debit: "1.00001" }], [{ accountId: ACCOUNT, debit: "-1" }], [{ accountId: ACCOUNT, debit: "1e3" }], [{ accountId: ACCOUNT, debit: 5 }], ["x"], [null], "no"]) {
      expect(parseEntryLines(bad as any).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseEntryLines(Array.from({ length: 201 }, () => ({ accountId: ACCOUNT, debit: "1" }))).ok).toBe(false);
    expect(parseEntryLines(undefined)).toEqual({ ok: true, value: [] });
  });

  it("an entry: a real date, a description, an optional ISO-shaped currency", () => {
    const parsed = parseEntryBody(ENTRY);
    expect(parsed).toEqual({ ok: true, value: { entry_date: "2026-11-05", description: "Opening balance", reference: "OB-1", currency_code: "EUR", lines: [
      { account_id: ACCOUNT, debit: "100.50", credit: "0" }, { account_id: ID, debit: "0", credit: "100.50", description: "Equity" }] } });
    expect(parseEntryBody({ ...ENTRY, currencyCode: undefined })).toMatchObject({ ok: true });
    for (const change of [{ entryDate: "2026-02-31" }, { entryDate: "" }, { description: "  " }, { description: "x".repeat(501) }, { reference: "x".repeat(101) }, { currencyCode: "EURO" }]) {
      expect(parseEntryBody({ ...ENTRY, ...change }).ok, JSON.stringify(change)).toBe(false);
    }
    expect(parseEntryBody({ ...ENTRY, currencyCode: undefined }, true).ok).toBe(false); // an edit names the currency
  });

  it("an expense: a positive exact amount, a category, a date", () => {
    expect(parseExpenseBody(EXPENSE)).toEqual({ ok: true, value: { expense_date: "2026-11-05", description: "Printer paper", reference: "R-1", vendor: "Paper Co", account_id: ACCOUNT, amount: "25.5", currency_code: "USD" } });
    for (const change of [{ amount: "0" }, { amount: "-3" }, { amount: "1.23456" }, { amount: 5 }, { accountId: "x" }, { expenseDate: "soon" }, { description: "" }, { vendor: "v".repeat(151) }, { currencyCode: "dollars" }]) {
      expect(parseExpenseBody({ ...EXPENSE, ...change }).ok, JSON.stringify(change)).toBe(false);
    }
  });

  it("a reason is 3 to 500 characters", () => {
    expect(parseReason("  Entered   twice ")).toEqual({ ok: true, value: "Entered twice" });
    for (const bad of ["", "no", "  ", undefined, 5, "x".repeat(501)]) expect(parseReason(bad).ok, String(bad)).toBe(false);
  });
});

// =====================================================================================================
// accounts
// =====================================================================================================
describe("/api/finance/accounts", () => {
  it("lists with only known filters, and never sends an organization", async () => {
    stub(() => json(200, [{ id: ID, code: "1100" }]));
    const res = await listAccounts(request("GET", undefined, { query: "?type=asset&active=true&q=cash&organization_id=evil&x=1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [{ id: ID, code: "1100" }] });
    expect(upstream().url).toBe(`${FINANCE}/api/v1/finance/accounts?type=asset&active=true&q=cash`);
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    await listAccounts(request("GET", undefined, { query: "?type=bogus&active=maybe" }));
    expect(fetchMock.mock.calls[1][0]).toBe(`${FINANCE}/api/v1/finance/accounts?`);
  });

  it("creates, reading only code, name, type and description", async () => {
    stub(() => json(201, { id: ID, code: "6000" }));
    const res = await createAccount(request("POST", { code: " 6000a ", name: "  Office   rent ", accountType: "expense", description: "", isSystem: true, organizationId: "evil", is_system: true }));
    expect(res.status).toBe(201);
    expect(sentBody()).toEqual({ code: "6000A", name: "Office rent", account_type: "expense" });
  });

  it.each([
    [{ code: "bad code", name: "x", accountType: "asset" }, "code"],
    [{ code: "6000", name: "", accountType: "asset" }, "name"],
    [{ code: "6000", name: "x", accountType: "income" }, "accountType"],
    [{ code: "6000", name: "x".repeat(151), accountType: "asset" }, "name"],
  ])("refuses %j before calling the service", async (body, field) => {
    const res = await createAccount(request("POST", body));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors[field]).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("changes only what is allowed and reports a protected account clearly", async () => {
    stub(() => json(409, { detail: { code: "account_protected", message: "A system account is used by Finance itself and cannot be deactivated." } }));
    const res = await patchAccount(request("PATCH", { isActive: false, isSystem: false, system_key: "x" }), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "A system account is used by Finance itself and cannot be deactivated.", code: "account_protected" });
    expect(sentBody()).toEqual({ is_active: false });
    expect((await patchAccount(request("PATCH", {}), params())).status).toBe(400);
    expect((await patchAccount(request("PATCH", { isActive: "yes" }), params())).status).toBe(400);
    expect((await patchAccount(request("PATCH", { name: "x" }), { params: { id: "not-a-uuid" } })).status).toBe(404);
  });

  it("deletes through the service, which refuses a used or system account", async () => {
    stub(() => new Response(null, { status: 204 }));
    expect((await deleteAccount(request("DELETE"), params())).status).toBe(200);
    expect(upstream().url).toBe(`${FINANCE}/api/v1/finance/accounts/${ID}`);
    stub(() => json(409, { detail: { code: "account_in_use", message: "This account is used by journal entries or expenses and cannot be deleted. Deactivate it instead." } }));
    const refused = await deleteAccount(request("DELETE"), params());
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("account_in_use");
  });
});

// =====================================================================================================
// journal entries
// =====================================================================================================
describe("/api/finance/journal-entries", () => {
  it("lists with validated filters only", async () => {
    stub(() => json(200, { items: [], total: 0, limit: 25, offset: 0 }));
    const res = await listEntries(request("GET", undefined, { query: `?status=posted&source=sales&currency=eur&accountId=${ACCOUNT}&dateFrom=2026-11-01&dateTo=2026-11-30&q=%20inv%20&limit=9999&offset=-4&organization_id=evil` }));
    expect(res.status).toBe(200);
    const url = new URL(upstream().url);
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: "posted", source: "sales", currency: "EUR", account_id: ACCOUNT, date_from: "2026-11-01", date_to: "2026-11-30", q: "inv", limit: "200", offset: "0" });
    expect((await listEntries(request("GET", undefined, { query: "?dateFrom=nope" }))).status).toBe(400);
    expect((await listEntries(request("GET", undefined, { query: "?accountId=nope" }))).status).toBe(404);
  });

  it("creates with an Idempotency-Key, forwarding it and never an organization or a status", async () => {
    stub(() => json(201, { id: ID }));
    const res = await createEntry(request("POST", { ...ENTRY, post: true, organizationId: "evil", status: "posted", entryNumber: "JE-9", total: "5" }, { key: KEY }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ entry: { id: ID }, replayed: false });
    expect(upstream().init.headers["Idempotency-Key"]).toBe(KEY);
    expect(sentBody()).toEqual({ entry_date: "2026-11-05", description: "Opening balance", reference: "OB-1", currency_code: "EUR", post: true, lines: [
      { account_id: ACCOUNT, debit: "100.50", credit: "0" }, { account_id: ID, debit: "0", credit: "100.50", description: "Equity" }] });
    expect(Object.keys(sentBody())).not.toContain("organization_id");
  });

  it("post is true only when the browser says exactly true", async () => {
    await createEntry(request("POST", { ...ENTRY, post: "true" }, { key: KEY }));
    expect(sentBody().post).toBe(false);
  });

  it("a replayed request is reported as such", async () => {
    stub(() => json(200, { id: ID }));
    expect(await (await createEntry(request("POST", ENTRY, { key: KEY }))).json()).toEqual({ entry: { id: ID }, replayed: true });
  });

  it("needs a signed-in administrator and a well-formed key", async () => {
    expect((await createEntry(request("POST", ENTRY, { cookie: null, key: KEY }))).status).toBe(401);
    expect((await createEntry(request("POST", ENTRY))).status).toBe(400);
    expect((await createEntry(request("POST", ENTRY, { key: "short" }))).status).toBe(400);
    expect((await createEntry(request("POST", "not json", { key: KEY }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the service's reasons: unbalanced, inactive account, unknown account", async () => {
    stub(() => json(422, { detail: { code: "unbalanced", message: "The entry does not balance: debits 100.0000 USD, credits 99.9900 USD. The difference is 0.0100 USD." } }));
    const res = await createEntry(request("POST", { ...ENTRY, post: true }, { key: KEY }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("does not balance"), code: "unbalanced" });
  });

  it("reads, replaces a draft and discards it, always under the session's own token", async () => {
    stub(() => json(200, { id: ID }));
    expect((await getEntry(request("GET"), params())).status).toBe(200);
    expect((await putEntry(request("PUT", ENTRY), params())).status).toBe(200);
    expect(fetchMock.mock.calls[1][1].method).toBe("PUT");
    stub(() => new Response(null, { status: 204 }));
    expect((await discardEntry(request("DELETE"), params())).status).toBe(200);
    for (const handler of [getEntry, discardEntry]) expect((await handler(request("GET", undefined, { cookie: null }), params())).status).toBe(401);
    expect((await getEntry(request("GET"), { params: { id: "../../x" } })).status).toBe(404);
  });

  it("another organization's entry is an ordinary not-found", async () => {
    stub(() => json(404, { detail: "Journal entry not found." }));
    const res = await getEntry(request("GET"), params());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Journal entry not found." });
  });

  it("post and reverse are the only actions; reverse needs a reason", async () => {
    stub(() => json(200, { id: ID }));
    expect((await entryAction(request("POST"), params({ action: "post" }))).status).toBe(200);
    expect(upstream().url).toBe(`${FINANCE}/api/v1/finance/journal-entries/${ID}/post`);
    expect((await entryAction(request("POST"), params({ action: "delete" }))).status).toBe(404);
    expect((await entryAction(request("POST", {}), params({ action: "reverse" }))).status).toBe(400);
    expect((await entryAction(request("POST", { reason: "ab" }), params({ action: "reverse" }))).status).toBe(400);
    expect((await entryAction(request("POST", { reason: "Entered twice", entryDate: "2026-13-40" }), params({ action: "reverse" }))).status).toBe(400);
    stub(() => json(201, { id: "r" }));
    const ok = await entryAction(request("POST", { reason: "  Entered   twice ", entryDate: "2026-11-06", organizationId: "evil" }), params({ action: "reverse" }));
    expect(ok.status).toBe(201);
    expect(sentBody()).toEqual({ reason: "Entered twice", entry_date: "2026-11-06" });
  });

  it("reports an entry that was already reversed, with the reversal's id", async () => {
    stub(() => json(409, { detail: { code: "already_reversed", message: "This entry was already reversed by JE-000002.", reversal_entry_id: ID } }));
    const res = await entryAction(request("POST", { reason: "Entered twice" }), params({ action: "reverse" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "already_reversed", reversalEntryId: ID });
  });
});

// =====================================================================================================
// expenses
// =====================================================================================================
describe("/api/finance/expenses", () => {
  it("creates with an Idempotency-Key and only the fields it reads", async () => {
    stub(() => json(201, { id: ID }));
    const res = await createExpense(request("POST", { ...EXPENSE, post: true, number: "EXP-9", status: "posted", organizationId: "evil", journalEntryId: ID }, { key: KEY }));
    expect(res.status).toBe(201);
    expect(upstream().init.headers["Idempotency-Key"]).toBe(KEY);
    expect(sentBody()).toEqual({ expense_date: "2026-11-05", description: "Printer paper", reference: "R-1", vendor: "Paper Co", account_id: ACCOUNT, amount: "25.5", currency_code: "USD", post: true });
  });

  it("refuses a bad amount, category or date before calling the service, and a missing key", async () => {
    for (const change of [{ amount: "0" }, { amount: "1.23456" }, { accountId: "x" }, { expenseDate: "2026-02-30" }]) {
      const res = await createExpense(request("POST", { ...EXPENSE, ...change }, { key: KEY }));
      expect(res.status, JSON.stringify(change)).toBe(400);
      expect((await res.json()).fieldErrors).toBeTruthy();
    }
    expect((await createExpense(request("POST", EXPENSE))).status).toBe(400);
    expect((await createExpense(request("POST", EXPENSE, { cookie: null, key: KEY }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows why a category is refused", async () => {
    stub(() => json(422, { detail: { code: "not_an_expense_account", message: "1100 Accounts Receivable is not an expense account. Choose an expense category." } }));
    const res = await createExpense(request("POST", EXPENSE, { key: KEY }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not an expense account");
  });

  it("lists, reads, replaces a draft and deletes it", async () => {
    stub(() => json(200, { items: [], total: 0, limit: 25, offset: 0 }));
    expect((await listExpenses(request("GET", undefined, { query: "?status=draft&currency=usd&dateFrom=2026-11-01&organization_id=evil" }))).status).toBe(200);
    expect(Object.fromEntries(new URL(upstream().url).searchParams)).toMatchObject({ status: "draft", currency: "USD", date_from: "2026-11-01" });
    expect(upstream().url).not.toContain("organization_id");
    stub(() => json(200, { id: ID }));
    expect((await getExpense(request("GET"), params())).status).toBe(200);
    expect((await putExpense(request("PUT", EXPENSE), params())).status).toBe(200);
    expect((await putExpense(request("PUT", { ...EXPENSE, currencyCode: undefined }), params())).status).toBe(400);
    stub(() => new Response(null, { status: 204 }));
    expect((await deleteExpense(request("DELETE"), params())).status).toBe(200);
  });

  it("post and reverse", async () => {
    stub(() => json(200, { id: ID }));
    expect((await expenseAction(request("POST"), params({ action: "post" }))).status).toBe(200);
    expect((await expenseAction(request("POST", { reason: "" }), params({ action: "reverse" }))).status).toBe(400);
    expect((await expenseAction(request("POST", { reason: "Duplicate receipt" }), params({ action: "reverse" }))).status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toEqual({ reason: "Duplicate receipt" });
    expect((await expenseAction(request("POST"), params({ action: "reopen" }))).status).toBe(404);
  });
});

// =====================================================================================================
// synchronisation
// =====================================================================================================
describe("/api/finance/sync", () => {
  it("runs a synchronisation for the signed-in organization, and lists and retries events", async () => {
    stub(() => json(200, { received: 1, posted: 1, skipped: 0, retrying: 0, failed: 0 }));
    const run = await syncRun(request("POST"));
    expect(run.status).toBe(200);
    expect((await run.json()).result.posted).toBe(1);
    expect(upstream().url).toBe(`${FINANCE}/api/v1/finance/sync/run`);
    stub(() => json(200, { items: [], total: 0, limit: 25, offset: 0 }));
    await syncEvents(request("GET", undefined, { query: "?status=failed&organization_id=evil" }));
    expect(Object.fromEntries(new URL(upstream().url).searchParams)).toEqual({ status: "failed", limit: "25", offset: "0" });
    stub(() => json(200, { id: ID, status: "pending" }));
    expect((await retryEvent(request("POST"), params())).status).toBe(200);
    expect((await retryEvent(request("POST"), { params: { id: "x" } })).status).toBe(404);
    for (const call of [() => syncRun(request("POST", undefined, { cookie: null })), () => syncEvents(request("GET", undefined, { cookie: null })), () => retryEvent(request("POST", undefined, { cookie: null }), params())]) {
      expect((await call()).status).toBe(401);
    }
  });

  it("says plainly when the service is down", async () => {
    stub(() => { throw new Error("connect ECONNREFUSED"); });
    const res = await syncRun(request("POST"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("finance service is unavailable");
  });
});

describe("describeFinanceFailure", () => {
  it("maps the service's answers to safe messages", () => {
    expect(describeFinanceFailure(null)).toMatchObject({ status: 503 });
    expect(describeFinanceFailure({ status: 401, data: {} }).status).toBe(401);
    expect(describeFinanceFailure({ status: 403, data: { detail: { code: "module_disabled", message: "Finance is not enabled for your organization." } } })).toMatchObject({ status: 403, code: "module_disabled" });
    expect(describeFinanceFailure({ status: 404, data: {} }, "Gone.")).toMatchObject({ status: 404, message: "Gone." });
    expect(describeFinanceFailure({ status: 422, data: { detail: [{ loc: ["body", "entry_date"], msg: "Value error, bad" }] } })).toMatchObject({ status: 400, fieldErrors: { entryDate: "bad" } });
    expect(describeFinanceFailure({ status: 500, data: { detail: "stack trace" } })).toEqual({ status: 502, message: "The request could not be completed. Please try again." });
  });
});
