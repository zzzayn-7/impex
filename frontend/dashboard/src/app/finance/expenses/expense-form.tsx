"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { api, EXPENSE_NOTICE, jsonBody, MONEY_RE } from "@/lib/finance-browser";
import type { Account, ExpenseDetail } from "@/lib/finance";
import { newIdempotencyKey } from "@/lib/stock-validation";
import { fieldClass, InfoNotice, primaryButton, secondaryButton } from "../ui";

const today = () => new Date().toISOString().slice(0, 10);

/** Record an expense (or edit a DRAFT one). The category is one of the organization's active expense accounts; the currency defaults to the
 *  organization's but is the expense's own and is never converted. Save as a draft, or post it to the books. */
export default function ExpenseForm({ categories, defaultCurrency, expense }: { categories: Account[]; defaultCurrency: string; expense?: ExpenseDetail }) {
  const router = useRouter();
  const editing = expense !== undefined;
  const keyRef = useRef(newIdempotencyKey());
  const [date, setDate] = useState(expense?.expense_date ?? today());
  const [description, setDescription] = useState(expense?.description ?? "");
  const [vendor, setVendor] = useState(expense?.vendor ?? "");
  const [reference, setReference] = useState(expense?.reference ?? "");
  const [accountId, setAccountId] = useState(expense?.account_id ?? "");
  const [amount, setAmount] = useState(expense ? expense.amount : "");
  const [currency, setCurrency] = useState(expense?.currency_code ?? defaultCurrency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(post: boolean) {
    if (busy) return;
    setError(null);
    const problems: Record<string, string> = {};
    if (!accountId) problems.accountId = "Choose an expense category.";
    if (!MONEY_RE.test(amount.trim()) || /^0+(\.0+)?$/.test(amount.trim())) problems.amount = "Enter an amount above zero with at most 4 decimals.";
    if (Object.keys(problems).length > 0) {
      setFieldErrors(problems);
      return setError("Please correct the highlighted fields.");
    }
    setFieldErrors({});
    setBusy(true);
    const body = { expenseDate: date, description, vendor, reference, accountId, amount: amount.trim(), currencyCode: currency };
    const r = editing
      ? await api(`/api/finance/expenses/${expense.id}`, { method: "PUT", ...jsonBody(body) })
      : await api("/api/finance/expenses", { method: "POST", headers: { "Idempotency-Key": keyRef.current }, ...jsonBody({ ...body, post }) });
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      setBusy(false);
      if (r.status >= 400 && r.status < 500) keyRef.current = newIdempotencyKey();
      setFieldErrors(r.fieldErrors ?? {});
      return setError(r.error);
    }
    let saved = r.data.expense;
    if (editing && post) {
      const posted = await api(`/api/finance/expenses/${expense.id}/post`, { method: "POST" });
      if (!posted.ok) {
        setBusy(false);
        return setError(`Your changes were saved as a draft, but it could not be posted: ${posted.error}`);
      }
      saved = posted.data.expense;
    }
    router.replace(`/finance/expenses/${saved.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(false); }} className="space-y-6" aria-label={editing ? "Edit draft expense" : "Record expense"}>
      <div>
        <h2 className="text-xl font-semibold text-white">{editing ? `Edit ${expense.number}` : "Record Expense"}</h2>
        <p className="text-xs text-slate-400">What did it cost, what was it for, and which category does it belong to?</p>
      </div>
      <section className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:grid-cols-4 sm:p-5">
        <label className="text-xs font-medium text-slate-400">Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required className={fieldClass} aria-invalid={Boolean(fieldErrors.expenseDate)} />
          {fieldErrors.expenseDate && <span className="mt-1 block text-red-300">{fieldErrors.expenseDate}</span>}
        </label>
        <label className="text-xs font-medium text-slate-400 sm:col-span-3">Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} required className={fieldClass} aria-invalid={Boolean(fieldErrors.description)} />
          {fieldErrors.description && <span className="mt-1 block text-red-300">{fieldErrors.description}</span>}
        </label>
        <label className="text-xs font-medium text-slate-400 sm:col-span-2">Category
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={fieldClass} aria-invalid={Boolean(fieldErrors.accountId)}>
            <option value="">Choose a category…</option>
            {categories.filter((c) => c.is_active || c.id === accountId).map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
          </select>
          {fieldErrors.accountId && <span className="mt-1 block text-red-300">{fieldErrors.accountId}</span>}
        </label>
        <label className="text-xs font-medium text-slate-400">Amount
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${fieldClass} text-right font-mono`} aria-invalid={Boolean(fieldErrors.amount)} />
          {fieldErrors.amount && <span className="mt-1 block text-red-300">{fieldErrors.amount}</span>}
        </label>
        <label className="text-xs font-medium text-slate-400">Currency
          <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} required className={`${fieldClass} uppercase`} aria-invalid={Boolean(fieldErrors.currencyCode)} />
          {fieldErrors.currencyCode && <span className="mt-1 block text-red-300">{fieldErrors.currencyCode}</span>}
        </label>
        <label className="text-xs font-medium text-slate-400 sm:col-span-2">Vendor / paid to (optional)
          <input value={vendor} onChange={(e) => setVendor(e.target.value)} maxLength={150} className={fieldClass} />
        </label>
        <label className="text-xs font-medium text-slate-400 sm:col-span-2">Reference (optional)
          <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} className={fieldClass} />
        </label>
      </section>

      {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">{error}</p>}

      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className={secondaryButton}>{busy ? "Saving…" : "Save as Draft"}</button>
        <button type="button" disabled={busy} onClick={() => void submit(true)} className={primaryButton}>{busy ? "Posting…" : "Save and Post"}</button>
      </div>
      <InfoNotice>{EXPENSE_NOTICE}</InfoNotice>
    </form>
  );
}
