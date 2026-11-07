import Link from "next/link";

import { ACTION_LABELS } from "@/lib/finance-browser";
import type { AuditLine } from "@/lib/finance";

// Small pieces shared by the Finance pages (plain presentation, no data fetching).
export const fieldClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";
export const selectClass = "mt-1.5 block max-w-[14rem] rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500";
export const primaryButton = "inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 hover:bg-indigo-500 disabled:opacity-60";
export const secondaryButton = "inline-flex min-h-10 items-center rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-60";
export const dangerButton = "inline-flex min-h-10 items-center rounded-lg border border-red-500/40 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-60";

export function Pill({ children, style }: { children: React.ReactNode; style: string }) {
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}>{children}</span>;
}

export function InfoNotice({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-xs leading-relaxed text-slate-400">{children}</p>;
}

export function Unavailable({ reason, what }: { reason: "unauthorized" | "forbidden" | "not-found" | "unavailable"; what: string }) {
  return (
    <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
      {reason === "forbidden"
        ? `Your organization is currently inactive or unavailable, so ${what} cannot be used. Please contact your platform administrator.`
        : `${what[0].toUpperCase()}${what.slice(1)} are temporarily unavailable. Please refresh in a moment.`}
    </div>
  );
}

export function Missing({ back, what }: { back: React.ReactNode; what: string }) {
  return (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">{what} not found.</p>
    </div>
  );
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="print:hidden text-xs text-indigo-300 hover:text-indigo-200">← {children}</Link>;
}

const when = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";

/** The audit trail of one record: who (a person, or the Sales/Purchasing synchronisation) did what, and when. */
export function History({ items }: { items: AuditLine[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-label="History" className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-white">History</h3>
      <ol className="space-y-1.5 text-xs text-slate-300">
        {items.map((h) => (
          <li key={h.seq} className="flex flex-wrap gap-x-2">
            <span className="font-medium text-slate-100">{ACTION_LABELS[h.action] ?? h.action}</span>
            <span className="text-slate-400">by {h.source === "sync" ? "automatic synchronisation" : h.actor_email ?? "an administrator"}</span>
            <span className="text-slate-500">{when(h.created_at)}</span>
            {h.detail && <span className="w-full text-slate-500">{h.detail}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
