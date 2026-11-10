"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useConfirm } from "@/components/ui/confirm";
import { api, EXPENSE_NOTICE, EXPENSE_STATUS_LABELS, EXPENSE_STATUS_STYLE, jsonBody, money } from "@/lib/finance-browser";
import type { ExpenseDetail } from "@/lib/finance";
import { dangerButton, fieldClass, History, InfoNotice, Pill, primaryButton, secondaryButton } from "../../ui";
import { useStamp } from "@/components/clock";


/** One expense: what it was, which category, who recorded and posted it, and the journal entries it produced. A draft can be edited, posted or
 *  deleted; a posted one can only be reversed (a mirror entry and a reason). It never implies a bank or a payment. */
export default function ExpenseDetailView({ expense: initial }: { expense: ExpenseDetail }) {
  const when = useStamp();
  const router = useRouter();
  const [confirm, confirmDialog] = useConfirm();
  const [expense, setExpense] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reversing, setReversing] = useState(false);
  const [reason, setReason] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function rejected(r: { status: number; error: string; fieldErrors?: Record<string, string> }) {
    if (r.status === 401) return router.replace("/login");
    setFieldErrors(r.fieldErrors ?? {});
    setError(r.error);
  }

  async function act(action: "post" | "reverse") {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    const r = await api(`/api/finance/expenses/${expense.id}/${action}`, { method: "POST", ...(action === "reverse" ? jsonBody({ reason }) : {}) });
    setBusy(false);
    if (!r.ok) return rejected(r);
    setExpense(r.data.expense);
    setReversing(false);
    setNotice(action === "post" ? `${r.data.expense.number} was posted to your books.` : `${r.data.expense.number} was reversed.`);
    router.refresh();
  }

  async function discard() {
    if (busy || !(await confirm({ title: "Delete draft expense", message: "Delete this draft expense? This cannot be undone.", confirmLabel: "Delete" }))) return;
    setBusy(true);
    setError(null);
    const r = await api(`/api/finance/expenses/${expense.id}`, { method: "DELETE" });
    setBusy(false);
    if (!r.ok) return rejected(r);
    router.replace("/finance/expenses");
    router.refresh();
  }

  const draft = expense.status === "draft";
  return (
    <div className="space-y-5">
      {confirmDialog}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-mono text-xl font-semibold text-white">{expense.number}</h2>
          <p className="mt-1 text-sm text-slate-300">{expense.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <Pill style={EXPENSE_STATUS_STYLE[expense.status]}>{EXPENSE_STATUS_LABELS[expense.status]}</Pill>
            <span>{expense.expense_date}</span>
            <span>·</span><span>{expense.account_code} {expense.account_name}</span>
            {expense.vendor && <><span>·</span><span>{expense.vendor}</span></>}
            {expense.reference && <><span>·</span><span>Ref {expense.reference}</span></>}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl font-semibold text-white">{money(expense.amount)} <span className="text-base text-slate-400">{expense.currency_code}</span></div>
        </div>
      </header>

      <div className="flex flex-wrap gap-2 print:hidden">
        {draft && <Link href={`/finance/expenses/${expense.id}/edit`} className={secondaryButton}>Edit</Link>}
        {draft && <button type="button" disabled={busy} onClick={() => act("post")} className={primaryButton}>Post Expense</button>}
        {draft && <button type="button" disabled={busy} onClick={discard} className={dangerButton}>Delete Draft</button>}
        {expense.status === "posted" && !reversing && <button type="button" onClick={() => setReversing(true)} className={secondaryButton}>Reverse Expense</button>}
      </div>

      {notice && <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300">{notice}</p>}
      {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">{error}</p>}

      {reversing && (
        <section aria-label="Reverse this expense" className="space-y-3 rounded-xl border border-slate-700 bg-slate-900/40 p-4">
          <p className="text-sm text-slate-300">This posts a mirror entry that cancels the expense. The original entry is kept. Say why:</p>
          <label className="block text-xs font-medium text-slate-400">Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={fieldClass} aria-invalid={Boolean(fieldErrors.reason)} />
            {fieldErrors.reason && <span className="mt-1 block text-red-300">{fieldErrors.reason}</span>}
          </label>
          <div className="flex gap-2">
            <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => act("reverse")} className={primaryButton}>{busy ? "Reversing…" : "Reverse Expense"}</button>
            <button type="button" onClick={() => { setReversing(false); setReason(""); }} className={secondaryButton}>Cancel</button>
          </div>
        </section>
      )}

      <section aria-label="Provenance" className="grid gap-2 rounded-xl border border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-400 sm:grid-cols-2 sm:p-5">
        <div>Recorded by <span className="text-slate-200">{expense.created_by_email}</span> · {when(expense.created_at)}</div>
        {expense.posted_at && <div>Posted by <span className="text-slate-200">{expense.posted_by_email}</span> · {when(expense.posted_at)}</div>}
        {expense.journal_entry_id && <div>Journal entry: <Link href={`/finance/journal/${expense.journal_entry_id}`} className="text-indigo-300 hover:text-indigo-200">view the posting</Link></div>}
        {expense.reversed_at && <div>Reversed by <span className="text-slate-200">{expense.reversed_by_email}</span> · {when(expense.reversed_at)}{expense.reversal_reason ? ` — ${expense.reversal_reason}` : ""}</div>}
        {expense.reversal_entry_id && <div>Reversal entry: <Link href={`/finance/journal/${expense.reversal_entry_id}`} className="text-indigo-300 hover:text-indigo-200">view the reversal</Link></div>}
      </section>

      <History items={expense.history} />
      <InfoNotice>{EXPENSE_NOTICE}</InfoNotice>
    </div>
  );
}
