"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { HistoryPage, ModuleKey, ModulesState, Preview } from "@/lib/modules";
import { api, jsonBody } from "@/lib/support-browser";

const ORDER: ModuleKey[] = ["inventory", "purchasing", "sales", "finance"];

function stamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const ACTION_LABEL: Record<string, string> = { enabled: "Enabled", disabled: "Disabled", seeded: "Default for a new organization", migrated: "Kept when modules were introduced" };

/** Module management for one organization. The flow is always: choose → REVIEW (nothing changes) → CONFIRM. The Organization Service
 *  decides what is allowed (dependencies, operations in progress, an out-of-date review); this page only shows its answers. */
export default function ModuleManager({ initial, initialHistory, historyUnavailable = false }: { initial: ModulesState; initialHistory: HistoryPage; historyUnavailable?: boolean }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [history, setHistory] = useState(initialHistory);
  const [desired, setDesired] = useState<Record<string, boolean>>(() => Object.fromEntries(initial.modules.map((m) => [m.key, m.enabled])));
  const [review, setReview] = useState<{ preview: Preview; changes: Record<string, boolean> } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const byKey = Object.fromEntries(state.modules.map((m) => [m.key, m]));
  const changes: Record<string, boolean> = {};
  for (const m of state.modules) if (m.available && desired[m.key] !== m.enabled) changes[m.key] = desired[m.key];
  const changed = Object.keys(changes).length > 0;
  const base = `/api/organizations/${state.organization_id}/modules`;

  function sync(next: ModulesState) {
    setState(next);
    setDesired(Object.fromEntries(next.modules.map((m) => [m.key, m.enabled])));
  }

  async function reloadHistory() {
    const r = await api(`${base}/history?limit=50`);
    if (r.ok && r.data && Array.isArray(r.data.items)) setHistory(r.data);
  }

  async function reviewChanges() {
    if (busy || !changed) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await api(`${base}/preview`, { method: "POST", ...jsonBody({ changes }) });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setError(r.error);
    setReview({ preview: r.data.preview, changes: { ...changes } });
  }

  async function confirm() {
    if (busy || !review) return;
    setBusy(true);
    setError(null);
    const r = await api(`${base}`, { method: "PUT", ...jsonBody({ changes: review.changes, expected_revision: review.preview.revision, reason: reason.trim() || undefined }) });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      setError(r.error);
      // stale: somebody changed it since the review. Load the current state so the next review starts from the truth.
      if (r.code === "stale_revision") {
        const fresh = await api(`${base}/preview`, { method: "POST", ...jsonBody({ changes: review.changes }) });
        setReview(fresh.ok ? { preview: fresh.data.preview, changes: review.changes } : null);
        router.refresh();
      } else if (r.code === "blocked") {
        const fresh = await api(`${base}/preview`, { method: "POST", ...jsonBody({ changes: review.changes }) });
        if (fresh.ok) setReview({ preview: fresh.data.preview, changes: review.changes });
      }
      return;
    }
    sync(r.data.state);
    setReview(null);
    setReason("");
    setNotice("Saved. The change applies to the next request the organization makes.");
    await reloadHistory();
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Module management</h2>
        <p className="text-sm text-slate-300">{state.organization_name}</p>
        <p className="mt-1 text-xs text-slate-400">Choose which business modules this organization can use. Switching a module off keeps all of its records; switching it on again restores access to them.</p>
      </div>

      {notice && <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
      {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

      <section className="space-y-3" aria-label="Business modules">
        {ORDER.map((key) => {
          const m = byKey[key];
          if (!m) return null;
          const on = desired[key];
          const needs = m.requires.map((r) => byKey[r]?.name ?? r);
          return (
            <div key={key} data-module={key} className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-white">{m.name}</h3>
                    {!m.available ? (
                      <span className="rounded-full border border-slate-600/40 bg-slate-700/30 px-2 py-0.5 text-xs text-slate-300">Planned: not available yet</span>
                    ) : (
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${m.enabled ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-slate-600/40 bg-slate-700/30 text-slate-300"}`}>{m.enabled ? "Enabled" : "Disabled"}</span>
                    )}
                    {needs.length > 0 && <span className="text-xs text-slate-500">Requires {needs.join(", ")}</span>}
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{m.description}</p>
                  <p className="mt-2 text-xs text-slate-500">Includes: {m.features.join(", ")}</p>
                  {m.updated_by_name && m.updated_at && <p className="mt-1 text-xs text-slate-500">Last changed by {m.updated_by_name} · {stamp(m.updated_at)}</p>}
                </div>
                <label className={`flex min-h-10 items-center gap-2 text-sm ${m.available ? "text-slate-200" : "text-slate-500"}`}>
                  <input
                    type="checkbox" role="switch" checked={on} disabled={!m.available || busy || review !== null}
                    aria-label={`${m.name} enabled`}
                    onChange={(e) => { setDesired((d) => ({ ...d, [key]: e.target.checked })); setNotice(null); setError(null); }}
                    className="h-5 w-5 rounded border-slate-700 bg-slate-950"
                  />
                  {m.available ? (on ? "On" : "Off") : "Unavailable"}
                </label>
              </div>
              {on && m.requires.some((r) => !desired[r]) && (
                <p className="mt-2 text-xs text-amber-300">{m.name} needs {needs.join(", ")}: enable it in the same change.</p>
              )}
            </div>
          );
        })}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/20 p-4 sm:p-5" aria-label="Always available">
        <h3 className="text-sm font-semibold text-white">Always available</h3>
        <p className="mt-1 text-xs text-slate-400">These platform capabilities cannot be switched off and are not part of any module.</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {state.permanent.map((p) => (
            <li key={p.key} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
              <p className="text-sm text-slate-200">{p.name}</p>
              <p className="text-xs text-slate-500">{p.description}</p>
            </li>
          ))}
        </ul>
      </section>

      {review === null ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-400">{changed ? `${Object.keys(changes).length} change${Object.keys(changes).length === 1 ? "" : "s"} to review.` : "No changes yet."}</p>
          <button type="button" disabled={!changed || busy} onClick={() => void reviewChanges()} className="min-h-11 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">{busy ? "Checking…" : "Review changes"}</button>
        </div>
      ) : (
        <section role="region" aria-label="Review changes" className="space-y-4 rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4 sm:p-5">
          <h3 className="text-base font-semibold text-white">Review before confirming</h3>
          <ul className="space-y-1 text-sm text-slate-200">
            {review.preview.changes.map((c) => (
              <li key={c.module}>
                <span className="font-medium">{c.name}</span>: {c.from_enabled ? "Enabled" : "Disabled"} → <span className={c.to_enabled ? "text-emerald-300" : "text-amber-300"}>{c.to_enabled ? "Enabled" : "Disabled"}</span>
              </li>
            ))}
          </ul>

          {review.preview.blockers.length > 0 && (
            <div role="alert" className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
              <p className="text-sm font-semibold text-red-300">This cannot be applied yet</p>
              <ul className="space-y-2 text-sm text-red-200">
                {review.preview.blockers.map((b, i) => (
                  <li key={`${b.code}-${b.module}-${i}`}>
                    {b.message}
                    {b.counts && <ul className="mt-1 list-disc pl-5 text-xs">{b.counts.map((c) => <li key={c.code}>{c.count} × {c.label}</li>)}</ul>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {review.preview.warnings.length > 0 && (
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <p className="text-sm font-semibold text-amber-300">Good to know</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-amber-100">
                {review.preview.warnings.map((w) => <li key={`${w.module}-${w.code}`}>{w.count} × {w.label}: these stay exactly as they are, and are not reachable by the organization until the module is enabled again.</li>)}
              </ul>
            </div>
          )}
          {review.preview.changes.some((c) => !c.to_enabled) && (
            <p className="text-xs text-slate-400">Nothing is deleted. People in the organization lose access to the module on their next request; its records are kept and come back when it is enabled again.</p>
          )}

          <label className="block text-xs font-medium text-slate-400">
            Reason (optional, kept in the history)
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Approved in support ticket SUP-000123"
              className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
          </label>

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button type="button" disabled={busy} onClick={() => { setReview(null); setError(null); }} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50">Back to editing</button>
            <button type="button" disabled={busy || !review.preview.can_apply} onClick={() => void confirm()} className="min-h-10 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">{busy ? "Saving…" : "Confirm changes"}</button>
          </div>
        </section>
      )}

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="History">
        <h3 className="text-base font-semibold text-white">History</h3>
        {historyUnavailable && history.items.length === 0 ? (
          <p role="alert" className="text-sm text-slate-400">The history could not be loaded just now. Refresh in a moment.</p>
        ) : history.items.length === 0 ? (
          <p className="text-sm text-slate-500">No changes recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                  <th scope="col" className="px-2 py-2 font-medium">When</th>
                  <th scope="col" className="px-2 py-2 font-medium">Module</th>
                  <th scope="col" className="px-2 py-2 font-medium">Change</th>
                  <th scope="col" className="px-2 py-2 font-medium">By</th>
                  <th scope="col" className="px-2 py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {history.items.map((h) => (
                  <tr key={h.id}>
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-slate-400">{stamp(h.created_at)}</td>
                    <td className="px-2 py-2 text-slate-200">{h.module_name}</td>
                    <td className="px-2 py-2 text-slate-300">{ACTION_LABEL[h.action] ?? h.action}{h.action === "seeded" || h.action === "migrated" ? ` (${h.new_enabled ? "enabled" : "disabled"})` : ""}</td>
                    <td className="px-2 py-2 text-xs text-slate-300">{h.changed_by_name ?? "System"}{h.changed_by_email ? <span className="block text-slate-500">{h.changed_by_email}</span> : null}</td>
                    <td className="px-2 py-2 text-xs text-slate-400">{h.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {history.total > history.items.length && <p className="mt-2 text-xs text-slate-500">Showing the latest {history.items.length} of {history.total} entries.</p>}
          </div>
        )}
      </section>
    </div>
  );
}
