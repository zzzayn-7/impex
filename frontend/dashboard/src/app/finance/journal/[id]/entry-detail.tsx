"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useConfirm } from "@/components/ui/confirm";
import { api, ENTRY_STATUS_LABELS, ENTRY_STATUS_STYLE, FINANCE_NOTICE, jsonBody, money, SOURCE_LABELS } from "@/lib/finance-browser";
import type { EntryDetail } from "@/lib/finance";
import { dangerButton, fieldClass, History, InfoNotice, Pill, primaryButton, secondaryButton } from "../../ui";
import { useStamp } from "@/components/clock";


/** One journal entry: its lines, who created and posted it, and what can be done in its state. A posted entry is shown exactly as posted and can only
 *  be reversed (a new mirror entry, with a reason); a draft can be edited, posted or discarded. */
export default function EntryDetailView({ entry: initial }: { entry: EntryDetail }) {
  const when = useStamp();
  const router = useRouter();
  const [confirm, confirmDialog] = useConfirm();
  const [entry, setEntry] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reversing, setReversing] = useState(false);
  const [reason, setReason] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const cur = entry.currency_code;
  const draft = entry.status === "draft";

  function rejected(r: { status: number; error: string; fieldErrors?: Record<string, string> }) {
    if (r.status === 401) return router.replace("/login");
    setFieldErrors(r.fieldErrors ?? {});
    setError(r.error);
  }

  async function post() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await api(`/api/finance/journal-entries/${entry.id}/post`, { method: "POST" });
    setBusy(false);
    if (!r.ok) return rejected(r);
    setEntry(r.data.entry);
    setNotice(`${r.data.entry.entry_number} was posted.`);
    router.refresh();
  }

  async function discard() {
    if (busy || !(await confirm({ title: "Discard draft", message: "Discard this draft? This cannot be undone.", confirmLabel: "Discard" }))) return;
    setBusy(true);
    setError(null);
    const r = await api(`/api/finance/journal-entries/${entry.id}`, { method: "DELETE" });
    setBusy(false);
    if (!r.ok) return rejected(r);
    router.replace("/finance/journal");
    router.refresh();
  }

  async function reverse() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    const r = await api(`/api/finance/journal-entries/${entry.id}/reverse`, { method: "POST", ...jsonBody({ reason }) });
    setBusy(false);
    if (!r.ok) return rejected(r);
    router.replace(`/finance/journal/${r.data.entry.id}`);
    router.refresh();
  }

  return (
    <div className="space-y-5">
      {confirmDialog}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-mono text-xl font-semibold text-white">{entry.entry_number ?? "Draft journal entry"}</h2>
          <p className="mt-1 text-sm text-slate-300">{entry.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <Pill style={ENTRY_STATUS_STYLE[entry.status]}>{ENTRY_STATUS_LABELS[entry.status]}</Pill>
            <span>{SOURCE_LABELS[entry.source_type]}</span>
            <span>·</span><span>{entry.entry_date}</span>
            <span>·</span><span className="font-mono">{cur}</span>
            {entry.reference && <><span>·</span><span>Ref {entry.reference}</span></>}
          </div>
          {entry.source_summary && <p className="mt-1 text-xs text-slate-500">{entry.source_summary}</p>}
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          {draft && <Link href={`/finance/journal/${entry.id}/edit`} className={secondaryButton}>Edit</Link>}
          {draft && <button type="button" disabled={busy || !entry.is_balanced} onClick={post} className={primaryButton}>Post Entry</button>}
          {draft && <button type="button" disabled={busy} onClick={discard} className={dangerButton}>Discard Draft</button>}
          {entry.can_reverse && !reversing && <button type="button" onClick={() => setReversing(true)} className={secondaryButton}>Reverse Entry</button>}
        </div>
      </header>

      {notice && <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300">{notice}</p>}
      {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">{error}</p>}

      {entry.reverses_entry_id && (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
          This entry reverses <Link href={`/finance/journal/${entry.reverses_entry_id}`} className="underline">another entry</Link>{entry.reversal_reason ? `: ${entry.reversal_reason}` : "."}
        </p>
      )}
      {entry.reversed_by_entry_id && (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
          This entry was reversed by <Link href={`/finance/journal/${entry.reversed_by_entry_id}`} className="underline">its reversal</Link>. It is kept exactly as it was posted.
        </p>
      )}

      {reversing && (
        <section aria-label="Reverse this entry" className="space-y-3 rounded-xl border border-slate-700 bg-slate-900/40 p-4">
          <p className="text-sm text-slate-300">
            This posts a new entry with every debit and credit swapped, dated today. The original is not changed. Say why:
          </p>
          <label className="block text-xs font-medium text-slate-400">Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={fieldClass} aria-invalid={Boolean(fieldErrors.reason)} />
            {fieldErrors.reason && <span className="mt-1 block text-red-300">{fieldErrors.reason}</span>}
          </label>
          <div className="flex gap-2">
            <button type="button" disabled={busy || reason.trim().length < 3} onClick={reverse} className={primaryButton}>{busy ? "Reversing…" : "Post Reversal"}</button>
            <button type="button" onClick={() => { setReversing(false); setReason(""); }} className={secondaryButton}>Cancel</button>
          </div>
        </section>
      )}

      <section aria-label="Lines" className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
              <tr><th className="px-3 py-2 font-semibold">Account</th><th className="px-3 py-2 font-semibold">Note</th><th className="px-3 py-2 text-right font-semibold">Debit ({cur})</th><th className="px-3 py-2 text-right font-semibold">Credit ({cur})</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {entry.lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-3 py-2"><span className="font-mono text-xs text-white">{l.account_code}</span> {l.account_name}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{l.description}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{l.debit === "0.0000" ? "" : money(l.debit)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{l.credit === "0.0000" ? "" : money(l.credit)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-slate-700 text-sm font-semibold text-white">
              <tr><td className="px-3 py-2" colSpan={2}>Totals</td><td className="px-3 py-2 text-right font-mono">{money(entry.total_debit)}</td><td className="px-3 py-2 text-right font-mono">{money(entry.total_credit)}</td></tr>
            </tfoot>
          </table>
        </div>
        {!entry.is_balanced && draft && <p className="mt-3 text-xs text-amber-300">This draft does not balance yet, so it cannot be posted. Edit it to fix the amounts.</p>}
      </section>

      <section aria-label="Provenance" className="grid gap-2 rounded-xl border border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-400 sm:grid-cols-2 sm:p-5">
        <div>Created by <span className="text-slate-200">{entry.created_by_email ?? "automatic synchronisation"}</span> · {when(entry.created_at)}</div>
        {entry.posted_at && <div>Posted by <span className="text-slate-200">{entry.posted_by_email ?? "automatic synchronisation"}</span> · {when(entry.posted_at)}</div>}
        {entry.source_key && <div className="sm:col-span-2">Source: <span className="font-mono text-slate-300">{entry.source_key}</span> (each source event is posted once)</div>}
      </section>

      <History items={entry.history} />
      <InfoNotice>{FINANCE_NOTICE}</InfoNotice>
    </div>
  );
}
