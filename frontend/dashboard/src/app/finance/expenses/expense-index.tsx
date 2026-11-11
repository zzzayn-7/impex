"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { EXPENSE_NOTICE, EXPENSE_STATUS_LABELS, EXPENSE_STATUS_STYLE, money } from "@/lib/finance-browser";
import type { Account, Expense, ExpenseFilters, ExpenseStatus, Paged } from "@/lib/finance";
import { fieldClass, InfoNotice, Pill, primaryButton, selectClass, Unavailable } from "../ui";

export default function ExpenseIndex({ list, filters, categories }: { list: Paged<Expense>; filters: ExpenseFilters; categories: Account[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.q);

  function navigate(next: Partial<ExpenseFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.status) params.set("status", merged.status);
    if (merged.accountId) params.set("category", merged.accountId);
    if (merged.currency) params.set("currency", merged.currency);
    if (merged.dateFrom) params.set("from", merged.dateFrom);
    if (merged.dateTo) params.set("to", merged.dateTo);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/finance/expenses?${query}` : "/finance/expenses"));
  }

  const filtered = Boolean(filters.q || filters.status || filters.accountId || filters.currency || filters.dateFrom || filters.dateTo);
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Expenses</h2>
          <p className="text-xs text-slate-400">Record the costs of running your business and put each in a category. Recording an expense does not move money.</p>
        </div>
        <Link href="/finance/expenses/new" className={primaryButton}>Record Expense</Link>
      </div>

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[14rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">Search
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Description, vendor, reference or number" maxLength={100} className={fieldClass} />
            </label>
            <button type="submit" className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="text-xs font-medium text-slate-400">Status
            <select value={filters.status} onChange={(e) => navigate({ status: e.target.value as ExpenseStatus | "" })} className={selectClass}>
              <option value="">All statuses</option>
              {(Object.keys(EXPENSE_STATUS_LABELS) as ExpenseStatus[]).map((s) => <option key={s} value={s}>{EXPENSE_STATUS_LABELS[s]}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">Category
            <select value={filters.accountId} onChange={(e) => navigate({ accountId: e.target.value })} className={selectClass}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">From
            <input type="date" value={filters.dateFrom} onChange={(e) => navigate({ dateFrom: e.target.value })} className={selectClass} />
          </label>
          <label className="text-xs font-medium text-slate-400">To
            <input type="date" value={filters.dateTo} onChange={(e) => navigate({ dateTo: e.target.value })} className={selectClass} />
          </label>
        </div>

        <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
          {!list.ok ? (
            <Unavailable reason={list.reason} what="expenses" />
          ) : list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No expenses match these filters." : "No expenses yet. Choose Record Expense to add the first one."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Expense</th><th className="px-4 py-3 font-semibold">Date</th><th className="px-4 py-3 font-semibold">Description</th>
                    <th className="px-4 py-3 font-semibold">Category</th><th className="px-4 py-3 text-right font-semibold">Amount</th><th className="px-4 py-3 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((x) => (
                    <tr key={x.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3"><Link href={`/finance/expenses/${x.id}`} className="font-mono text-sm font-semibold text-indigo-300 hover:text-indigo-200">{x.number}</Link></td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">{x.expense_date}</td>
                      <td className="px-4 py-3"><div>{x.description}</div>{x.vendor && <div className="text-xs text-slate-500">{x.vendor}</div>}</td>
                      <td className="px-4 py-3 text-xs">{x.account_code} {x.account_name}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{money(x.amount)} <span className="text-slate-500">{x.currency_code}</span></td>
                      <td className="px-4 py-3"><Pill style={EXPENSE_STATUS_STYLE[x.status]}>{EXPENSE_STATUS_LABELS[x.status]}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {list.ok && total > 0 && (
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Showing {first}–{last} of {total}</span>
            <div className="flex gap-2">
              <button type="button" disabled={filters.page <= 1 || isPending} onClick={() => navigate({ page: filters.page - 1 })} className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Previous</button>
              <button type="button" disabled={last >= total || isPending} onClick={() => navigate({ page: filters.page + 1 })} className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
        <InfoNotice>{EXPENSE_NOTICE}</InfoNotice>
      </section>
    </div>
  );
}
