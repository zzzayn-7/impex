import { NextResponse } from "next/server";

// Server-side only. Talks to the Finance Service with the signed-in administrator's own session token (the HttpOnly tenant cookie).
// Nothing here ever names an organization: the Finance Service derives it from the token, so there is nothing for the browser to tamper
// with. (See docs/multi-tenancy.md.) Amounts are exact decimal STRINGS everywhere; they are never turned into numbers.

export function financeServiceUrl(): string {
  return (process.env.FINANCE_SERVICE_URL || "http://localhost:8006").replace(/\/$/, "");
}

export type FinanceResult = { status: number; data: any } | null; // null = the service could not be reached

export async function financeRequest(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  token: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<FinanceResult> {
  try {
    const res = await fetch(`${financeServiceUrl()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    return { status: res.status, data: res.status === 204 ? null : await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

// ---- types (what the Finance Service returns; no organization_id is ever included) ---------------------------------------
export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export type Account = {
  id: string;
  code: string;
  name: string;
  account_type: AccountType;
  description: string | null;
  is_active: boolean;
  is_system: boolean;
  system_key: string | null;
  has_postings: boolean;
  created_at: string;
  updated_at: string;
};

export type EntryStatus = "draft" | "posted";
export type EntrySource = "manual" | "expense" | "sales" | "purchasing" | "reversal";

export type EntrySummary = {
  id: string;
  entry_number: string | null;
  entry_date: string;
  description: string;
  reference: string | null;
  currency_code: string;
  status: EntryStatus;
  source_type: EntrySource;
  source_summary: string | null;
  total: string | null;
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
  created_by_email: string | null;
  posted_at: string | null;
  created_at: string;
};

export type AuditLine = { seq: number; action: string; actor_email: string | null; source: "user" | "sync"; detail: string | null; created_at: string };

export type EntryLine = { id: string; line_no: number; account_id: string; account_code: string; account_name: string; debit: string; credit: string; description: string | null };

export type EntryDetail = EntrySummary & {
  source_key: string | null;
  reversal_reason: string | null;
  posted_by_email: string | null;
  total_debit: string;
  total_credit: string;
  is_balanced: boolean;
  lines: EntryLine[];
  history: AuditLine[];
  can_reverse: boolean;
};

export type ExpenseStatus = "draft" | "posted" | "reversed";

export type Expense = {
  id: string;
  number: string;
  expense_date: string;
  description: string;
  reference: string | null;
  vendor: string | null;
  account_id: string;
  account_code: string;
  account_name: string;
  amount: string;
  currency_code: string;
  status: ExpenseStatus;
  journal_entry_id: string | null;
  reversal_entry_id: string | null;
  created_by_email: string;
  posted_at: string | null;
  posted_by_email: string | null;
  reversed_at: string | null;
  reversed_by_email: string | null;
  reversal_reason: string | null;
  created_at: string;
};

export type ExpenseDetail = Expense & { history: AuditLine[] };

export type CurrencyTotals = { currency_code: string; assets: string; liabilities: string; equity: string; revenue: string; expenses: string; posted_entries: number };

export type SyncSource = { source: "sales" | "purchasing"; status: "idle" | "ok" | "error"; last_attempt_at: string | null; last_success_at: string | null; last_error: string | null; consecutive_failures: number };
export type SyncSummary = { sources: SyncSource[]; pending: number; failed: number; skipped: number; posted: number };

export type Overview = {
  default_currency: string;
  activated_at: string;
  accounts: number;
  active_accounts: number;
  draft_entries: number;
  posted_entries: number;
  draft_expenses: number;
  posted_expenses: number;
  totals_by_currency: CurrencyTotals[];
  recent_entries: EntrySummary[];
  sync: SyncSummary;
};

export type SyncEvent = {
  id: string;
  source: "sales" | "purchasing";
  event_key: string;
  event_type: string;
  event_time: string;
  status: "pending" | "posted" | "skipped" | "failed";
  attempts: number;
  last_error: string | null;
  journal_entry_id: string | null;
  processed_at: string | null;
  created_at: string;
};

// ---- reading (used by the server-rendered pages) --------------------------------------------------------------------------
export const PAGE_SIZE = 25;
export type Failure = { ok: false; reason: "unauthorized" | "forbidden" | "not-found" | "unavailable" };
export type Paged<T> = { ok: true; items: T[]; total: number; limit: number; offset: number } | Failure;

function failure(result: FinanceResult): Failure {
  const status = result?.status;
  return { ok: false, reason: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not-found" : "unavailable" };
}

async function getPaged<T>(path: string, params: URLSearchParams, token: string): Promise<Paged<T>> {
  const result = await financeRequest("GET", `${path}?${params}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, items: result.data.items, total: result.data.total, limit: result.data.limit, offset: result.data.offset };
}

export async function getOverview(token: string): Promise<{ ok: true; overview: Overview } | Failure> {
  const result = await financeRequest("GET", "/api/v1/finance/overview", token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, overview: result.data };
}

export type AccountFilters = { q: string; type: AccountType | ""; active: "" | "true" | "false" };
export async function listAccounts(token: string, filters: Partial<AccountFilters> = {}): Promise<{ ok: true; accounts: Account[] } | Failure> {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.type) params.set("type", filters.type);
  if (filters.active) params.set("active", filters.active);
  const result = await financeRequest("GET", `/api/v1/finance/accounts?${params}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, accounts: result.data };
}

export type EntryFilters = { q: string; status: EntryStatus | ""; source: EntrySource | ""; currency: string; accountId: string; dateFrom: string; dateTo: string; page: number };
export function listEntries(token: string, filters: EntryFilters) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((filters.page - 1) * PAGE_SIZE) });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.source) params.set("source", filters.source);
  if (filters.currency) params.set("currency", filters.currency);
  if (filters.accountId) params.set("account_id", filters.accountId);
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  return getPaged<EntrySummary>("/api/v1/finance/journal-entries", params, token);
}

export async function getEntry(token: string, id: string): Promise<{ ok: true; entry: EntryDetail } | Failure> {
  const result = await financeRequest("GET", `/api/v1/finance/journal-entries/${id}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, entry: result.data };
}

export type ExpenseFilters = { q: string; status: ExpenseStatus | ""; accountId: string; currency: string; dateFrom: string; dateTo: string; page: number };
export function listExpenses(token: string, filters: ExpenseFilters) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((filters.page - 1) * PAGE_SIZE) });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.accountId) params.set("account_id", filters.accountId);
  if (filters.currency) params.set("currency", filters.currency);
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  return getPaged<Expense>("/api/v1/finance/expenses", params, token);
}

export async function getExpense(token: string, id: string): Promise<{ ok: true; expense: ExpenseDetail } | Failure> {
  const result = await financeRequest("GET", `/api/v1/finance/expenses/${id}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, expense: result.data };
}

// ---- failures from write calls, turned into safe responses for the browser ------------------------------------------------
export type FinanceFailure = { status: number; message: string; code?: string; fieldErrors?: Record<string, string>; reversalEntryId?: string };

const FIELD_NAMES: Record<string, string> = {
  entry_date: "entryDate", currency_code: "currencyCode", account_id: "accountId", expense_date: "expenseDate", account_type: "accountType", is_active: "isActive",
};

export function describeFinanceFailure(result: FinanceResult, notFound = "Not found."): FinanceFailure {
  if (!result) return { status: 503, message: "The finance service is unavailable. Please try again shortly." };
  const detail = result.data?.detail;
  const text = typeof detail === "string" ? detail : typeof detail?.message === "string" ? detail.message : null;
  const code = detail && typeof detail === "object" && !Array.isArray(detail) && typeof detail.code === "string" ? detail.code : undefined;
  switch (result.status) {
    case 401:
      return { status: 401, message: "Your session has expired. Please sign in again." };
    case 403:
      return { status: 403, message: text ?? "You do not have access to this.", ...(code ? { code } : {}) };
    case 404:
      return { status: 404, message: text ?? notFound };
    case 409:
      return { status: 409, message: text ?? "That change conflicts with existing data.", ...(code ? { code } : {}), ...(typeof detail?.reversal_entry_id === "string" ? { reversalEntryId: detail.reversal_entry_id } : {}) };
    case 422: {
      const fieldErrors: Record<string, string> = {};
      if (Array.isArray(detail)) {
        for (const entry of detail as { loc?: unknown[]; msg?: string }[]) {
          const name = String(entry.loc?.[entry.loc.length - 1]);
          const field = FIELD_NAMES[name] ?? name;
          if (!fieldErrors[field]) fieldErrors[field] = entry.msg?.replace(/^Value error, /, "") ?? "Invalid value.";
        }
      }
      return { status: 400, message: text ?? "Some values were rejected. Please check the form.", ...(code ? { code } : {}), fieldErrors };
    }
    case 503:
      return { status: 503, message: text ?? "The service is temporarily unavailable. Please try again." };
    default:
      return { status: 502, message: "The request could not be completed. Please try again." };
  }
}

export function financeFailureResponse(result: FinanceResult, notFound?: string) {
  const { status, message, ...rest } = describeFinanceFailure(result, notFound);
  return NextResponse.json({ error: message, ...rest }, { status, headers: { "Cache-Control": "no-store" } });
}
