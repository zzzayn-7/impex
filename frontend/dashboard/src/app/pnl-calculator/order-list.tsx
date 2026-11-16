"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useStamp } from "@/components/clock";
import { formatMoney } from "@/lib/product-validation";
import { computePnl, magnitude } from "@/lib/pnl";
import type { OrderExpenses } from "@/lib/finance";
import type { OrderSummary, Paged, TradeFilters } from "@/lib/sales";

// FINANCE > PNL CALCULATOR: the orders, newest first. Opening one asks for its expenses. Once they are saved the row says Profit or Loss and how much.

const PATH = "/pnl-calculator";

export default function OrderList({ list, filters, expenses }: { list: Paged<OrderSummary>; filters: TradeFilters; expenses: OrderExpenses[] }) {
  const router = useRouter();
  const stamp = useStamp();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.q);
  const saved = new Map(expenses.map((e) => [e.order_id, e]));

  function navigate(next: Partial<TradeFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `${PATH}?${query}` : PATH));
  }

  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;

  return (
    <div className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex max-w-xl items-end gap-2" role="search">
        <label className="flex-1 text-xs font-medium text-slate-400">
          Search
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Order number or client" maxLength={100}
            className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
        </label>
        <button type="submit" className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
      </form>

      <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
        {!list.ok ? (
          <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
            {list.reason === "forbidden"
              ? "Orders are not available. This calculator reads your orders from the Sales module, which must be enabled for your organization."
              : "Orders are temporarily unavailable. Please refresh in a moment."}
          </div>
        ) : list.items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">{filters.q ? "No orders found." : "No orders yet."}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/30">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-semibold">Order</th>
                  <th className="px-4 py-3 font-semibold">Client</th>
                  <th className="hidden px-4 py-3 font-semibold sm:table-cell">Date</th>
                  <th className="hidden px-4 py-3 text-right font-semibold sm:table-cell">Selling price</th>
                  <th className="px-4 py-3 text-right font-semibold">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {list.items.map((order) => {
                  const mine = saved.get(order.id);
                  const sellable = order.prices_recorded !== false && order.total_amount && order.currency_code;
                  const result = sellable && mine && mine.currency_code === order.currency_code
                    ? computePnl({ selling: order.total_amount!, goods: mine.goods_cost, delivery: mine.delivery_charges, others: mine.other_expenses })
                    : null;
                  const price = sellable ? formatMoney(order.total_amount!, order.currency_code!) : "—";
                  return (
                    <tr key={order.id} className="hover:bg-slate-800/30">
                      <td className="px-3 py-3 whitespace-nowrap sm:px-4">
                        <Link href={`${PATH}/${order.id}`} aria-label={`Open ${order.number}`} className="font-mono text-sm font-semibold text-indigo-300 hover:text-indigo-200">{order.number}</Link>
                        <span className="mt-0.5 block text-xs text-slate-400 sm:hidden">{price}</span>
                      </td>
                      <td className="px-3 py-3 sm:px-4">{order.client.name}</td>
                      <td className="hidden px-4 py-3 text-xs whitespace-nowrap sm:table-cell">{stamp(order.created_at)}</td>
                      <td className="hidden px-4 py-3 text-right font-mono text-xs whitespace-nowrap sm:table-cell">{price}</td>
                      <td className="px-3 py-3 text-right whitespace-nowrap sm:px-4" data-result={result?.verdict ?? "none"}>
                        {!sellable ? <span className="text-xs text-slate-500">No prices</span>
                          : result === null ? <span className="text-xs text-slate-500">Not calculated</span>
                          : result.verdict === "loss" ? <span className="font-mono text-xs font-semibold text-red-300">Loss {formatMoney(magnitude(result.profit), order.currency_code!)}</span>
                          : result.verdict === "profit" ? <span className="font-mono text-xs font-semibold text-ix-gain">Profit {formatMoney(result.profit, order.currency_code!)}</span>
                          : <span className="text-xs text-slate-300">No profit, no loss</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {list.ok && total > 0 && (
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>Showing {first}–{last} of {total}</span>
          <div className="flex gap-2">
            <button type="button" disabled={filters.page <= 1 || isPending} onClick={() => navigate({ page: filters.page - 1 })} className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Previous</button>
            <button type="button" disabled={last >= total || isPending} onClick={() => navigate({ page: filters.page + 1 })} className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
