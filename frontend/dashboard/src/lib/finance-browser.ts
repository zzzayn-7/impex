// Browser-safe helpers for the Finance pages (no server-only imports). Amounts are exact strings; sums use integers (units of 0.0001), never floats.
import { formatMoney, sumMoney, subtractMoney } from "@/lib/sales-browser";
import type { AccountType, EntrySource, EntryStatus, ExpenseStatus } from "@/lib/finance";

export { api, formatMoney, jsonBody, MONEY_RE, subtractMoney, sumMoney } from "@/lib/sales-browser";

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = { asset: "Assets", liability: "Liabilities", equity: "Equity", revenue: "Revenue", expense: "Expenses" };
export const ACCOUNT_TYPE_SINGULAR: Record<AccountType, string> = { asset: "Asset", liability: "Liability", equity: "Equity", revenue: "Revenue", expense: "Expense" };
export const ACCOUNT_TYPES = Object.keys(ACCOUNT_TYPE_LABELS) as AccountType[];

export const ENTRY_STATUS_LABELS: Record<EntryStatus, string> = { draft: "Draft", posted: "Posted" };
export const ENTRY_STATUS_STYLE: Record<EntryStatus, string> = {
  draft: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  posted: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
};

export const SOURCE_LABELS: Record<EntrySource, string> = { manual: "Manual", expense: "Expense", sales: "Sales", purchasing: "Purchasing", reversal: "Reversal" };

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = { draft: "Draft", posted: "Posted", reversed: "Reversed" };
export const EXPENSE_STATUS_STYLE: Record<ExpenseStatus, string> = {
  draft: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  posted: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  reversed: "border-slate-600/40 bg-slate-700/30 text-slate-400",
};

export const ACTION_LABELS: Record<string, string> = {
  created: "Created", updated: "Edited", posted: "Posted", reversed: "Reversed", draft_discarded: "Draft discarded", deactivated: "Deactivated", reactivated: "Reactivated",
  deleted: "Deleted", chart_created: "Chart of accounts created", event_failed: "Synchronisation failed", event_retried: "Retried",
};

export const FINANCE_NOTICE =
  "Amounts in different currencies are never added together or converted: Impex holds no exchange rates, so each currency is shown on its own. " +
  "Posted entries can never be edited or deleted; a mistake is corrected by reversing the entry and posting a new one.";

export const EXPENSE_NOTICE =
  "Recording an expense says that a cost was incurred and is owed until you settle it. It does not move money or touch any bank account.";

export const SYNC_NOTICE =
  "Finance posts entries automatically from your issued invoices, recorded payments and confirmed goods receipts (a purchase order alone creates nothing). " +
  "Only events from after Finance was switched on are posted; bring earlier balances in with an opening-balance journal entry.";

const MONEY_ZERO = "0";

export type DraftLine = { accountId: string; debit: string; credit: string; description: string };
export const EMPTY_LINE: DraftLine = { accountId: "", debit: "", credit: "", description: "" };

const AMOUNT = /^[0-9]{1,14}(?:\.[0-9]{1,4})?$/;
const positive = (value: string) => AMOUNT.test(value) && /[1-9]/.test(value); // an amount above zero (a sign test only: no arithmetic on floats)

/** Is this a usable amount for a journal line? Blank means "not on this side". */
export const isAmount = (value: string) => AMOUNT.test(value.trim());

export type Balance = { debits: string; credits: string; difference: string; balanced: boolean; problem: string | null };

/** The running totals of an entry being typed, EXACT (integer arithmetic): debits, credits, the difference, and whether it can be posted. */
export function balanceOf(lines: DraftLine[]): Balance {
  const debitValues: string[] = [];
  const creditValues: string[] = [];
  let problem: string | null = null;
  lines.forEach((line, index) => {
    const d = line.debit.trim();
    const c = line.credit.trim();
    if (!d && !c && !line.accountId) return; // an untouched row
    if ((d && !isAmount(d)) || (c && !isAmount(c))) problem = problem ?? `Line ${index + 1}: enter an amount with at most 4 decimals.`;
    else if (positive(d) && positive(c)) problem = problem ?? `Line ${index + 1}: use either a debit or a credit, not both.`;
    else if (!line.accountId) problem = problem ?? `Line ${index + 1}: choose an account.`;
    else if (!positive(d) && !positive(c)) problem = problem ?? `Line ${index + 1}: enter a debit or a credit amount.`;
    if (d && isAmount(d)) debitValues.push(d);
    if (c && isAmount(c)) creditValues.push(c);
  });
  const debits = sumMoney(debitValues.length ? debitValues : [MONEY_ZERO]);
  const credits = sumMoney(creditValues.length ? creditValues : [MONEY_ZERO]);
  const difference = subtractMoney(debits, credits);
  const used = lines.filter((l) => l.accountId || l.debit.trim() || l.credit.trim()).length;
  const nonZero = debits !== "0.0000" || credits !== "0.0000";
  const balanced = !problem && used >= 2 && difference === "0.0000" && nonZero;
  return { debits, credits, difference, balanced, problem };
}

/** The lines to send: untouched rows are dropped, blank sides become zero. */
export function linesPayload(lines: DraftLine[]) {
  return lines
    .filter((l) => l.accountId || l.debit.trim() || l.credit.trim())
    .map((l) => ({ accountId: l.accountId, debit: l.debit.trim() || "0", credit: l.credit.trim() || "0", description: l.description.trim() }));
}

export const money = (value: string | null | undefined) => (value === null || value === undefined ? "" : formatMoney(value));
