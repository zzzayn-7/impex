"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useStamp } from "@/components/clock";
import { TabNavigation } from "@/components/ui/page";
import { formatMoney } from "@/lib/product-validation";
import { magnitude } from "@/lib/pnl";
import { formatBps, PERIODS, REPORT_PAGE_SIZE as PAGE_SIZE, type Portfolio, type ReportRow } from "@/lib/profit-loss";
import type { PeriodKey } from "@/lib/finance";

// FINANCE = PROFIT & LOSS. The period tabs, the portfolio of that period (per currency) and the delivered orders with their result: a profit is "+10%" in green, a loss is "-5%" in red.
// The percentage is the profit (or loss) as a share of everything spent on the order. Nothing else about the organization's finances is shown here.

const GREEN = "text-ix-gain";
const RED = "text-red-400";

const colour = (verdict: string) => (verdict === "profit" ? GREEN : verdict === "loss" ? RED : "text-slate-200");
const signed = (profit: string, currency: string) => `${profit.startsWith("-") ? "-" : "+"}${formatMoney(magnitude(profit), currency)}`;

export default function ProfitLossView({ period, page, problem, rows, total, portfolios, notCalculated, truncated, deliveredTotal }: {
  period: PeriodKey; page: number; problem: null | "forbidden" | "unavailable"; rows: ReportRow[]; total: number; portfolios: Portfolio[]; notCalculated: number; truncated: boolean; deliveredTotal: number;
}) {
  const router = useRouter();
  const stamp = useStamp();
  const [isPending, startTransition] = useTransition();
  const go = (nextPage: number) => startTransition(() => router.push(`/finance?period=${period}${nextPage > 1 ? `&page=${nextPage}` : ""}`));
  const first = rows.length > 0 ? (page - 1) * PAGE_SIZE + 1 : 0;
  const last = (page - 1) * PAGE_SIZE + rows.length;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-white">Profit &amp; Loss</h2>
        <p className="mt-1 text-xs text-slate-400">Of every delivered order, as a share of everything spent on it.</p>
      </div>

      <TabNavigation label="Period" tabs={PERIODS.map((p) => ({ href: `/finance?period=${p.key}`, label: p.label }))} current={`/finance?period=${period}`} />

      {problem ? (
        <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
          {problem === "forbidden"
            ? "Orders are not available. Profit and loss is worked out from your delivered orders, which needs the Sales module to be enabled for your organization."
            : "Orders are temporarily unavailable. Please refresh in a moment."}
        </div>
      ) : (
        <>
          {portfolios.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-500">No delivered orders in this period.</p>
          ) : (
            portfolios.map((p) => (
              <section key={p.currency} aria-label={`Portfolio in ${p.currency}`} data-portfolio={p.currency} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-white">Portfolio · {p.currency}</h3>
                  <span className="text-xs text-slate-400">{p.calculated} of {p.orders} {p.orders === 1 ? "order" : "orders"} worked out</span>
                </div>
                <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Figure label="Sales" value={formatMoney(p.sales, p.currency)} />
                  <Figure label="Invested" value={p.calculated > 0 ? formatMoney(p.invested, p.currency) : "—"} />
                  <Figure label={p.verdict === "loss" ? "Loss" : "Profit"} value={p.calculated > 0 ? signed(p.profit, p.currency) : "—"} tone={colour(p.verdict)} data="amount" />
                  <Figure label="Return" value={p.bps !== null ? formatBps(p.bps) : "—"} tone={colour(p.verdict)} data="return" big />
                </dl>
              </section>
            ))
          )}

          {notCalculated > 0 && (
            <p role="status" className="text-xs text-slate-400">
              {notCalculated} delivered {notCalculated === 1 ? "order has" : "orders have"} no expenses yet, so {notCalculated === 1 ? "it is" : "they are"} left out of the profit. Add them in the <Link href="/pnl-calculator" className="text-ix-accent hover:underline">PNL Calculator</Link>.
            </p>
          )}
          {truncated && <p role="status" className="text-xs text-slate-400">This period has {deliveredTotal} delivered orders; only the newest {total} are counted.</p>}

          {total > 0 && (
            <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
              <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/30">
                <table className="w-full text-left text-sm text-slate-300">
                  <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Order</th>
                      <th className="px-4 py-3 font-semibold">Client</th>
                      <th className="hidden px-4 py-3 font-semibold sm:table-cell">Delivered</th>
                      <th className="hidden px-4 py-3 text-right font-semibold sm:table-cell">Sales</th>
                      <th className="px-4 py-3 text-right font-semibold">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {rows.map((row) => (
                      <tr key={row.id} className="hover:bg-slate-800/30">
                        <td className="px-3 py-3 whitespace-nowrap sm:px-4">
                          <Link href={`/pnl-calculator/${row.id}`} aria-label={`Open ${row.number}`} className="font-mono text-sm font-semibold text-indigo-300 hover:text-indigo-200">{row.number}</Link>
                          <span className="mt-0.5 block text-xs text-slate-400 sm:hidden">{row.total_amount && row.currency_code ? formatMoney(row.total_amount, row.currency_code) : "—"}</span>
                        </td>
                        <td className="px-3 py-3 sm:px-4">{row.client_name}</td>
                        <td className="hidden px-4 py-3 text-xs whitespace-nowrap sm:table-cell">{stamp(row.completed_at)}</td>
                        <td className="hidden px-4 py-3 text-right font-mono text-xs whitespace-nowrap sm:table-cell">{row.total_amount && row.currency_code ? formatMoney(row.total_amount, row.currency_code) : "—"}</td>
                        <td className="px-3 py-3 text-right whitespace-nowrap sm:px-4" data-result={row.state}>
                          {row.state === "no-prices" ? <span className="text-xs text-slate-500">No prices</span>
                            : row.state === "no-expenses" ? <Link href={`/pnl-calculator/${row.id}`} className="text-xs text-ix-accent hover:underline">Add expenses</Link>
                            : (
                              <>
                                <span data-percent className={`font-mono text-sm font-semibold ${colour(row.state)}`}>{row.bps !== null ? formatBps(row.bps) : row.state === "even" ? "0%" : "—"}</span>
                                <span className="mt-0.5 block font-mono text-[11px] text-slate-400">{signed(row.profit!, row.currency_code!)}</span>
                              </>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
                <span>Showing {first}–{last} of {total}</span>
                <div className="flex gap-2">
                  <button type="button" disabled={page <= 1 || isPending} onClick={() => go(page - 1)} className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Previous</button>
                  <button type="button" disabled={last >= total || isPending} onClick={() => go(page + 1)} className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Next</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Figure({ label, value, tone = "text-white", big = false, data }: { label: string; value: string; tone?: string; big?: boolean; data?: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd {...(data ? { [`data-${data}`]: "" } : {})} className={`font-mono ${big ? "text-xl" : "text-base"} font-semibold ${tone}`}>{value}</dd>
    </div>
  );
}
