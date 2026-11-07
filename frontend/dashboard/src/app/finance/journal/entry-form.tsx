"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { api, balanceOf, DraftLine, EMPTY_LINE, FINANCE_NOTICE, jsonBody, linesPayload, money } from "@/lib/finance-browser";
import type { Account, EntryDetail } from "@/lib/finance";
import { newIdempotencyKey } from "@/lib/stock-validation";
import { fieldClass, InfoNotice, primaryButton, secondaryButton } from "../ui";

const today = () => new Date().toISOString().slice(0, 10);

/** Create a journal entry (or edit a DRAFT). The running totals are exact; the entry can be posted only when debits equal credits. The currency
 *  defaults to the organization's default but is the entry's own: amounts of different currencies are never mixed in one entry. */
export default function EntryForm({ accounts, defaultCurrency, entry }: { accounts: Account[]; defaultCurrency: string; entry?: EntryDetail }) {
  const router = useRouter();
  const editing = entry !== undefined;
  const keyRef = useRef(newIdempotencyKey()); // one key per attempt: a double click or a retry returns the same entry
  const [date, setDate] = useState(entry?.entry_date ?? today());
  const [description, setDescription] = useState(entry?.description ?? "");
  const [reference, setReference] = useState(entry?.reference ?? "");
  const [currency, setCurrency] = useState(entry?.currency_code ?? defaultCurrency);
  const [lines, setLines] = useState<DraftLine[]>(
    entry ? entry.lines.map((l) => ({ accountId: l.account_id, debit: l.debit === "0.0000" ? "" : l.debit, credit: l.credit === "0.0000" ? "" : l.credit, description: l.description ?? "" })) : [{ ...EMPTY_LINE }, { ...EMPTY_LINE }]
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const balance = balanceOf(lines);
  const cur = currency.toUpperCase();
  const update = (index: number, patch: Partial<DraftLine>) => setLines((all) => all.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  async function submit(post: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const body = { entryDate: date, description, reference, currencyCode: currency, lines: linesPayload(lines) };
    const r = editing
      ? await api(`/api/finance/journal-entries/${entry.id}`, { method: "PUT", ...jsonBody(body) })
      : await api("/api/finance/journal-entries", { method: "POST", headers: { "Idempotency-Key": keyRef.current }, ...jsonBody({ ...body, post }) });
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      setBusy(false);
      if (r.status >= 400 && r.status < 500) keyRef.current = newIdempotencyKey(); // that request was not accepted: the next attempt is a new one
      setFieldErrors(r.fieldErrors ?? {});
      return setError(r.error);
    }
    let saved = r.data.entry;
    if (editing && post) {
      const posted = await api(`/api/finance/journal-entries/${entry.id}/post`, { method: "POST" });
      if (!posted.ok) {
        setBusy(false);
        return setError(`Your changes were saved as a draft, but it could not be posted: ${posted.error}`);
      }
      saved = posted.data.entry;
    }
    router.replace(`/finance/journal/${saved.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(false); }} className="space-y-6" aria-label={editing ? "Edit draft journal entry" : "New journal entry"}>
      <div>
        <h2 className="text-xl font-semibold text-white">{editing ? `Edit draft entry` : "New Journal Entry"}</h2>
        <p className="text-xs text-slate-400">Debit and credit accounts so that the totals are equal. Save it as a draft to come back to it, or post it to put it in your books.</p>
      </div>

      <section className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:grid-cols-4 sm:p-5">
        <label className="text-xs font-medium text-slate-400">Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required className={fieldClass} aria-invalid={Boolean(fieldErrors.entryDate)} />
          {fieldErrors.entryDate && <span className="mt-1 block text-red-300">{fieldErrors.entryDate}</span>}
        </label>
        <label className="text-xs font-medium text-slate-400 sm:col-span-2">Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} required className={fieldClass} aria-invalid={Boolean(fieldErrors.description)} />
          {fieldErrors.description && <span className="mt-1 block text-red-300">{fieldErrors.description}</span>}
        </label>
        <label className="text-xs font-medium text-slate-400">Currency
          <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} required className={`${fieldClass} uppercase`} aria-invalid={Boolean(fieldErrors.currencyCode)} />
          {fieldErrors.currencyCode && <span className="mt-1 block text-red-300">{fieldErrors.currencyCode}</span>}
        </label>
        <label className="text-xs font-medium text-slate-400 sm:col-span-2">Reference (optional)
          <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} className={fieldClass} />
        </label>
      </section>

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
              <tr><th className="px-2 py-2 font-semibold">Account</th><th className="px-2 py-2 font-semibold">Note</th><th className="px-2 py-2 text-right font-semibold">Debit ({cur})</th><th className="px-2 py-2 text-right font-semibold">Credit ({cur})</th><th className="px-2 py-2"><span className="sr-only">Remove</span></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {lines.map((line, i) => (
                <tr key={i}>
                  <td className="px-2 py-2">
                    <select aria-label={`Account for line ${i + 1}`} value={line.accountId} onChange={(e) => update(i, { accountId: e.target.value })} className={fieldClass + " mt-0 min-w-[14rem]"}>
                      <option value="">Choose an account…</option>
                      {accounts.filter((a) => a.is_active || a.id === line.accountId).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-2"><input aria-label={`Note for line ${i + 1}`} value={line.description} onChange={(e) => update(i, { description: e.target.value })} maxLength={255} className={fieldClass + " mt-0"} /></td>
                  <td className="px-2 py-2"><input aria-label={`Debit for line ${i + 1}`} inputMode="decimal" value={line.debit} onChange={(e) => update(i, { debit: e.target.value, ...(e.target.value ? { credit: "" } : {}) })} className={fieldClass + " mt-0 text-right font-mono"} /></td>
                  <td className="px-2 py-2"><input aria-label={`Credit for line ${i + 1}`} inputMode="decimal" value={line.credit} onChange={(e) => update(i, { credit: e.target.value, ...(e.target.value ? { debit: "" } : {}) })} className={fieldClass + " mt-0 text-right font-mono"} /></td>
                  <td className="px-2 py-2 text-right"><button type="button" onClick={() => setLines((all) => (all.length > 2 ? all.filter((_, j) => j !== i) : all))} disabled={lines.length <= 2} aria-label={`Remove line ${i + 1}`} className="text-xs text-slate-400 hover:text-red-300 disabled:opacity-30">Remove</button></td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-slate-700 text-sm font-semibold text-white">
              <tr>
                <td className="px-2 py-2" colSpan={2}>Totals</td>
                <td className="px-2 py-2 text-right font-mono" data-testid="total-debits">{money(balance.debits)}</td>
                <td className="px-2 py-2 text-right font-mono" data-testid="total-credits">{money(balance.credits)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="button" onClick={() => setLines((all) => [...all, { ...EMPTY_LINE }])} disabled={lines.length >= 200} className={secondaryButton}>Add line</button>
          <p role="status" aria-live="polite" className={`text-sm font-medium ${balance.balanced ? "text-emerald-400" : "text-amber-300"}`}>
            {balance.problem ?? (balance.balanced ? "Balanced: this entry can be posted." : balance.difference === "0.0000" ? "Enter at least two lines with an amount." : `Out of balance by ${money(balance.difference.replace("-", ""))} ${cur}: ${balance.difference.startsWith("-") ? "credits" : "debits"} are higher.`)}
          </p>
        </div>
      </section>

      {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">{error}</p>}

      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className={secondaryButton}>{busy ? "Saving…" : "Save as Draft"}</button>
        <button type="button" disabled={busy || !balance.balanced} onClick={() => void submit(true)} className={primaryButton}>{busy ? "Posting…" : "Post Entry"}</button>
      </div>
      <InfoNotice>{FINANCE_NOTICE}</InfoNotice>
    </form>
  );
}
