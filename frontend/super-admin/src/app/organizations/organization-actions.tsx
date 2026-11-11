"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

type Props = {
  organization: { id: string; name: string; isLocked: boolean; deletionPending: boolean };
};

type Dialog = null | "lock" | "unlock" | "delete";

const quiet = "rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium transition hover:bg-slate-800 disabled:opacity-60";
const field = "mt-1.5 block w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/25";

// Lock / Unlock and Delete for one organization. LOCK is reversible (the administrators can still sign in, but only Settings and Help & Support work); DELETE is for good and
// asks for the organization's exact name. Both are decided by the Organization Service, which records who did it; this component only asks.
export default function OrganizationActions({ organization }: Props) {
  const router = useRouter();
  const titleId = useId();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const first = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!dialog) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) close(); };
    document.addEventListener("keydown", escape);
    first.current?.focus();
    return () => document.removeEventListener("keydown", escape);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog, busy]);

  function open(which: Exclude<Dialog, null>) {
    setError(null);
    setDone(null);
    setNote("");
    setTyped("");
    setDialog(which);
  }
  function close() {
    if (busy) return;
    setDialog(null);
    setError(null);
  }

  async function send(path: string, body: unknown, success: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/organizations/${organization.id}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (!res.ok) {
        setError(data?.error ?? "That did not work. Please try again.");
        if (res.status === 404) router.refresh(); // it is already gone
        return;
      }
      setDialog(null);
      setDone(success);
      router.refresh();
    } catch {
      setError("Unable to reach the server. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  const nameMatches = typed.trim() === organization.name;
  const deleting = organization.deletionPending;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!deleting && (organization.isLocked
        ? <button type="button" onClick={() => open("unlock")} className={`${quiet} text-emerald-300`}>Unlock</button>
        : <button type="button" onClick={() => open("lock")} className={`${quiet} text-amber-300`}>Lock</button>)}
      <button type="button" onClick={() => open("delete")} className={`${quiet} border-red-500/30 text-red-300 hover:bg-red-500/10`}>{deleting ? "Finish deleting" : "Delete"}</button>
      {done && <span role="status" className="basis-full text-xs text-emerald-300">{done}</span>}

      {/* in the page itself, not inside the table: the panel around it has a backdrop filter, which would make "fixed" mean "fixed to the panel" */}
      {dialog && createPortal(
        <div className="ix-overlay-in fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
          <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="ix-dialog-in w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-left shadow-2xl">
            {dialog === "lock" && (
              <>
                <h3 id={titleId} className="text-base font-semibold text-white">Lock {organization.name}?</h3>
                <p className="mt-2 text-sm text-slate-300">Use this when the organization&apos;s monthly payment is late. Its administrators can still sign in, but <strong className="text-white">every module is switched off for them</strong>: they can only use Settings and Help &amp; Support.</p>
                <p className="mt-2 text-sm text-slate-400">Nothing is deleted, and its module settings are kept: unlocking gives back exactly what it had.</p>
                <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Your note (optional, only you see it)
                  <textarea ref={(el) => { first.current = el; }} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} placeholder="e.g. October invoice unpaid" className={field} />
                </label>
              </>
            )}
            {dialog === "unlock" && (
              <>
                <h3 id={titleId} className="text-base font-semibold text-white">Unlock {organization.name}?</h3>
                <p className="mt-2 text-sm text-slate-300">Its administrators get every module they had before the lock back, straight away.</p>
              </>
            )}
            {dialog === "delete" && (
              <>
                <h3 id={titleId} className="text-base font-semibold text-red-300">{deleting ? "Finish deleting" : "Delete"} {organization.name} for good?</h3>
                <p className="mt-2 text-sm text-slate-300">Use this only when the organization is no longer part of your CRM. <strong className="text-white">Everything related to it is deleted and cannot be recovered:</strong></p>
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-slate-300">
                  <li>products, stock and every stock movement</li>
                  <li>suppliers, purchase orders and goods receipts</li>
                  <li>clients, delivery lists, dispatches, invoices and payments</li>
                  <li>finance accounts, journal, expenses and reports</li>
                  <li>its Help &amp; Support tickets and messages</li>
                  <li>its administrators&apos; accounts, its logo and its settings</li>
                </ul>
                <p className="mt-2 text-xs text-slate-400">It is locked first, so nobody can use it meanwhile. If a service cannot be reached the deletion stops and you can run it again. Only a short record that it happened (who, when, the name) is kept.</p>
                <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Type <span className="font-mono normal-case text-white">{organization.name}</span> to confirm
                  <input ref={(el) => { first.current = el; }} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className={field} />
                </label>
              </>
            )}
            {error && <p role="alert" className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={close} disabled={busy} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-60">Cancel</button>
              {dialog === "lock" && <button type="button" disabled={busy} onClick={() => send("lock", note.trim() ? { reason: note.trim() } : {}, `${organization.name} is locked.`)} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-60">{busy ? "Locking…" : "Lock access"}</button>}
              {dialog === "unlock" && <button type="button" disabled={busy} onClick={() => send("unlock", {}, `${organization.name} is unlocked.`)} className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60">{busy ? "Unlocking…" : "Unlock"}</button>}
              {dialog === "delete" && <button type="button" disabled={busy || !nameMatches} onClick={() => send("delete", { confirm_name: typed }, `${organization.name} was deleted.`)} className="rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-40">{busy ? "Deleting…" : "Delete permanently"}</button>}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
