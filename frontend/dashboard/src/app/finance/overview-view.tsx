import Link from "next/link";

import { Stamp } from "@/components/clock";

import { ENTRY_STATUS_LABELS, ENTRY_STATUS_STYLE, FINANCE_NOTICE, money, SOURCE_LABELS, SYNC_NOTICE } from "@/lib/finance-browser";
import type { Overview } from "@/lib/finance";
import SyncPanel from "./sync-panel";
import { InfoNotice, Pill, primaryButton, secondaryButton } from "./ui";


function Stat({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link href={href} className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 hover:bg-slate-800/40">
      <div className="text-2xl font-semibold text-white">{value}</div>
      <div className="text-xs text-slate-400">{label}</div>
    </Link>
  );
}

/** A first look at the books from real records: counts, the position in EACH currency on its own, the latest entries and the health of the
 *  automatic postings. (Full financial statements arrive in a later release.) */
export default function OverviewView({ overview }: { overview: Overview }) {
  const o = overview;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Financial Overview</h2>
          <p className="text-xs text-slate-400">Default currency for new entries: <span className="font-mono text-slate-200">{o.default_currency}</span> · Finance on since {o.activated_at.slice(0, 10)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/finance/expenses/new" className={secondaryButton}>Record Expense</Link>
          <Link href="/finance/journal/new" className={primaryButton}>New Journal Entry</Link>
        </div>
      </div>

      <section aria-label="Counts" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={`Accounts (${o.active_accounts} active)`} value={o.accounts} href="/finance/accounts" />
        <Stat label="Posted journal entries" value={o.posted_entries} href="/finance/journal?status=posted" />
        <Stat label="Draft journal entries" value={o.draft_entries} href="/finance/journal?status=draft" />
        <Stat label="Expenses (posted / draft)" value={o.posted_expenses} href="/finance/expenses" />
      </section>

      <section aria-label="Position by currency" className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-white">Position by currency</h3>
        {o.totals_by_currency.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">
            Nothing is posted yet. Post a journal entry or an expense, or issue an invoice in Sales: it appears here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-semibold">Currency</th><th className="px-3 py-2 text-right font-semibold">Assets</th><th className="px-3 py-2 text-right font-semibold">Liabilities</th>
                  <th className="px-3 py-2 text-right font-semibold">Equity</th><th className="px-3 py-2 text-right font-semibold">Revenue</th><th className="px-3 py-2 text-right font-semibold">Expenses</th>
                  <th className="px-3 py-2 text-right font-semibold">Entries</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {o.totals_by_currency.map((t) => (
                  <tr key={t.currency_code}>
                    <td className="px-3 py-2 font-mono font-semibold text-white">{t.currency_code}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{money(t.assets)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{money(t.liabilities)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{money(t.equity)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{money(t.revenue)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{money(t.expenses)}</td>
                    <td className="px-3 py-2 text-right text-xs">{t.posted_entries}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <InfoNotice>{FINANCE_NOTICE}</InfoNotice>
      </section>

      <section aria-label="Recent journal entries" className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Latest journal entries</h3>
          <Link href="/finance/journal" className="text-xs text-indigo-300 hover:text-indigo-200">All entries</Link>
        </div>
        {o.recent_entries.length === 0 ? (
          <p className="text-sm text-slate-500">No journal entries yet.</p>
        ) : (
          <ul className="divide-y divide-slate-800/60 text-sm">
            {o.recent_entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <Link href={`/finance/journal/${e.id}`} className="font-mono text-sm font-semibold text-indigo-300 hover:text-indigo-200">{e.entry_number ?? "Draft"}</Link>
                  <span className="ml-2 text-slate-300">{e.description}</span>
                  <span className="ml-2 text-xs text-slate-500">{SOURCE_LABELS[e.source_type]} · {e.entry_date}</span>
                </div>
                <div className="flex items-center gap-3">
                  {e.total && <span className="font-mono text-xs">{money(e.total)} {e.currency_code}</span>}
                  <Pill style={ENTRY_STATUS_STYLE[e.status]}>{ENTRY_STATUS_LABELS[e.status]}</Pill>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Automatic postings" className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-white">Automatic postings from Sales and Purchasing</h3>
        <ul className="grid gap-2 text-xs sm:grid-cols-2">
          {o.sync.sources.map((s) => (
            <li key={s.source} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="font-medium capitalize text-slate-100">{s.source}</span>
                <Pill style={s.status === "error" ? "border-red-500/30 bg-red-500/10 text-red-300" : s.status === "ok" ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-slate-600/40 bg-slate-700/30 text-slate-400"}>
                  {s.status === "error" ? "Not reachable" : s.status === "ok" ? "Up to date" : "Not checked yet"}
                </Pill>
              </div>
              <div className="mt-1 text-slate-400">{s.last_success_at ? <>Last read <Stamp iso={s.last_success_at} /></> : "Not read yet"}</div>
              {s.status === "error" && (
                <div role="alert" className="mt-1 text-red-300">
                  {s.last_error ?? "Could not be reached"} — trying again automatically ({s.consecutive_failures} {s.consecutive_failures === 1 ? "attempt" : "attempts"} so far). Nothing is lost.
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className="text-xs text-slate-400">
          {o.sync.posted} posted · {o.sync.pending} waiting · {o.sync.skipped} skipped (nothing to post) ·{" "}
          <span className={o.sync.failed > 0 ? "font-semibold text-red-300" : ""}>{o.sync.failed} failed</span>
        </p>
        <SyncPanel failed={o.sync.failed} />
        <InfoNotice>{SYNC_NOTICE}</InfoNotice>
      </section>
    </div>
  );
}
