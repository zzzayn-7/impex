import { NextRequest, NextResponse } from "next/server";

import { checkCurrency, checkDispatchDate, checkMoney, checkUuid, collapse, fail, isResponse, readObject, text } from "@/lib/sales-routes";
import { IDEMPOTENCY_KEY_RE } from "@/lib/stock-validation";

// Shared by the /api/finance/* route handlers. Every handler: reads the tenant session from the HttpOnly cookie (no cookie = 401 and nothing is
// sent anywhere), accepts only the fields it lists, validates them, and lets the Finance Service decide everything that matters (the
// organization, numbers, totals, status, who did it). The browser never supplies those.

export { checkCurrency, checkDispatchDate, checkMoney, checkUuid, collapse, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/sales-routes";

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
export const ENTRY_STATUSES = ["draft", "posted"] as const;
export const ENTRY_SOURCES = ["manual", "expense", "sales", "purchasing", "reversal"] as const;
export const EXPENSE_STATUSES = ["draft", "posted", "reversed"] as const;
export const SYNC_STATUSES = ["pending", "posted", "skipped", "failed"] as const;

export const ACCOUNT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;

type Fields = Record<string, string>;
export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string; fieldErrors?: Fields };

/** The Idempotency-Key header every create requires (the browser generates one per form), or the error response to return. */
export function requireKey(req: NextRequest): string | NextResponse {
  const key = (req.headers.get("idempotency-key") ?? "").trim();
  return IDEMPOTENCY_KEY_RE.test(key) ? key : fail("Missing or invalid request key. Reload the page and try again.", 400);
}

export type LineBody = { account_id: string; debit: string; credit: string; description?: string };

/** The lines of a journal entry as sent by the browser: only an account id, an exact debit and credit and a note are read. */
export function parseEntryLines(value: unknown): Parsed<LineBody[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, message: "Send the journal lines as a list." };
  if (value.length > 200) return { ok: false, message: "An entry can have at most 200 lines." };
  const lines: LineBody[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, message: "Invalid journal line." };
    const line = entry as Record<string, unknown>;
    const account = checkUuid(line.accountId);
    if (!account) return { ok: false, message: `Line ${index + 1}: choose an account.`, fieldErrors: { accountId: "Choose an account." } };
    const debit = line.debit === undefined || line.debit === "" ? "0" : checkMoney(line.debit, true);
    const credit = line.credit === undefined || line.credit === "" ? "0" : checkMoney(line.credit, true);
    if (!debit || !credit) return { ok: false, message: `Line ${index + 1}: enter amounts with at most 4 decimals.`, fieldErrors: { amount: "Enter an amount with at most 4 decimals." } };
    const description = collapse(text(line.description) ?? "");
    if (description.length > 255) return { ok: false, message: `Line ${index + 1}: use 255 characters or fewer for the note.` };
    lines.push({ account_id: account, debit, credit, ...(description ? { description } : {}) });
  }
  return { ok: true, value: lines };
}

export type EntryBody = { entry_date: string; description: string; reference?: string; currency_code?: string; lines: LineBody[] };

export function parseEntryBody(body: Record<string, unknown>, requireCurrency = false): Parsed<EntryBody> {
  const fieldErrors: Fields = {};
  const entryDate = text(body.entryDate) ?? "";
  const description = collapse(text(body.description) ?? "");
  const reference = collapse(text(body.reference) ?? "");
  const currencyRaw = text(body.currencyCode) ?? "";
  const currency = currencyRaw ? checkCurrency(currencyRaw) : null;
  if (!checkDispatchDate(entryDate)) fieldErrors.entryDate = "Enter a valid date.";
  if (!description) fieldErrors.description = "Describe the entry.";
  else if (description.length > 500) fieldErrors.description = "Use 500 characters or fewer.";
  if (reference.length > 100) fieldErrors.reference = "Use 100 characters or fewer.";
  if (currencyRaw && !currency) fieldErrors.currencyCode = "Use a 3-letter currency code such as USD, EUR or PKR.";
  if (requireCurrency && !currency) fieldErrors.currencyCode = "Use a 3-letter currency code such as USD, EUR or PKR.";
  if (Object.keys(fieldErrors).length > 0) return { ok: false, message: "Please correct the highlighted fields.", fieldErrors };
  const lines = parseEntryLines(body.lines);
  if (!lines.ok) return lines;
  return { ok: true, value: { entry_date: entryDate, description, ...(reference ? { reference } : {}), ...(currency ? { currency_code: currency } : {}), lines: lines.value } };
}

export type ExpenseBody = { expense_date: string; description: string; reference?: string; vendor?: string; account_id: string; amount: string; currency_code?: string };

export function parseExpenseBody(body: Record<string, unknown>, requireCurrency = false): Parsed<ExpenseBody> {
  const fieldErrors: Fields = {};
  const expenseDate = text(body.expenseDate) ?? "";
  const description = collapse(text(body.description) ?? "");
  const reference = collapse(text(body.reference) ?? "");
  const vendor = collapse(text(body.vendor) ?? "");
  const account = checkUuid(body.accountId);
  const amount = checkMoney(body.amount, false);
  const currencyRaw = text(body.currencyCode) ?? "";
  const currency = currencyRaw ? checkCurrency(currencyRaw) : null;
  if (!checkDispatchDate(expenseDate)) fieldErrors.expenseDate = "Enter a valid date.";
  if (!description) fieldErrors.description = "Describe the expense.";
  else if (description.length > 500) fieldErrors.description = "Use 500 characters or fewer.";
  if (reference.length > 100) fieldErrors.reference = "Use 100 characters or fewer.";
  if (vendor.length > 150) fieldErrors.vendor = "Use 150 characters or fewer.";
  if (!account) fieldErrors.accountId = "Choose an expense category.";
  if (!amount) fieldErrors.amount = "Enter an amount above zero with at most 4 decimals.";
  if ((currencyRaw && !currency) || (requireCurrency && !currency)) fieldErrors.currencyCode = "Use a 3-letter currency code such as USD, EUR or PKR.";
  if (Object.keys(fieldErrors).length > 0) return { ok: false, message: "Please correct the highlighted fields.", fieldErrors };
  return { ok: true, value: { expense_date: expenseDate, description, ...(reference ? { reference } : {}), ...(vendor ? { vendor } : {}), account_id: account!, amount: amount!, ...(currency ? { currency_code: currency } : {}) } };
}

/** A reason for a reversal: 3 to 500 characters. */
export function parseReason(value: unknown): Parsed<string> {
  const reason = collapse(text(value) ?? "");
  if (reason.length < 3) return { ok: false, message: "Say why you are reversing it (at least 3 characters).", fieldErrors: { reason: "Say why you are reversing it." } };
  if (reason.length > 500) return { ok: false, message: "Use 500 characters or fewer for the reason.", fieldErrors: { reason: "Use 500 characters or fewer." } };
  return { ok: true, value: reason };
}

export function badParse(parsed: { ok: false; message: string; fieldErrors?: Fields }) {
  return fail(parsed.message, 400, parsed.fieldErrors ? { fieldErrors: parsed.fieldErrors } : {});
}
