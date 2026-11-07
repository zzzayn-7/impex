"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { api } from "@/lib/finance-browser";
import type { SyncEvent } from "@/lib/finance";
import { Pill, secondaryButton } from "./ui";

const STYLE: Record<SyncEvent["status"], string> = {
  pending: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  posted: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  skipped: "border-slate-600/40 bg-slate-700/30 text-slate-400",
  failed: "border-red-500/30 bg-red-500/10 text-red-300",
};

/** "Sync now", and the events that need a person (failed ones can be retried). Posting is idempotent, so pressing a button twice is harmless. */
export default function SyncPanel({ failed }: { failed: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<SyncEvent[] | null>(null);

  async function syncNow() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const r = await api("/api/finance/sync/run", { method: "POST" });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setError(r.error);
    const d = r.data.result;
    setMessage(`Done: ${d.received} new ${d.received === 1 ? "event" : "events"} received, ${d.posted} posted, ${d.skipped} skipped, ${d.retrying} waiting to retry, ${d.failed} failed.`);
    router.refresh();
  }

  async function loadFailed() {
    const r = await api("/api/finance/sync/events?status=failed&limit=50");
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setError(r.error);
    setEvents(r.data.items);
  }

  async function retry(id: string) {
    const r = await api(`/api/finance/sync/events/${id}/retry`, { method: "POST" });
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setError(r.error);
    setEvents((current) => (current ?? []).filter((e) => e.id !== id));
    setMessage("The event will be tried again on the next synchronisation.");
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={syncNow} disabled={busy} className={secondaryButton}>{busy ? "Syncing…" : "Sync now"}</button>
        {failed > 0 && events === null && <button type="button" onClick={loadFailed} className="text-sm text-red-300 hover:text-red-200">Show the {failed} failed {failed === 1 ? "event" : "events"}</button>}
      </div>
      {message && <p role="status" className="text-xs text-emerald-300">{message}</p>}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {events && events.length > 0 && (
        <ul className="space-y-2 text-xs">
          {events.map((e) => (
            <li key={e.id} className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-slate-200">{e.event_key}</span>
                <span className="flex items-center gap-2"><Pill style={STYLE[e.status]}>Failed</Pill><button type="button" onClick={() => retry(e.id)} className="text-indigo-300 hover:text-indigo-200">Retry</button></span>
              </div>
              <div className="mt-1 text-slate-400">{e.last_error}</div>
              <div className="mt-1 text-slate-500">This event is kept exactly as received: nothing was posted and nothing was guessed. Fix the cause in Sales or Purchasing, then retry.</div>
            </li>
          ))}
        </ul>
      )}
      {events && events.length === 0 && <p className="text-xs text-slate-500">No failed events.</p>}
    </div>
  );
}
