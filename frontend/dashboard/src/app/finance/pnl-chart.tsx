"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { GlassCard } from "@/components/dashboard/glass";
import { buttonClass } from "@/components/ui/controls";
import type { PnlTrend } from "@/lib/finance";
import { bucketLabel, bucketPeriod, compactNumber, isNegative, isZero, pnlScale, signedWithCurrency, withCurrency } from "@/lib/finance-view";

export type PnlState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; trend: PnlTrend };

const PROFIT = "bg-[rgb(var(--ix-profit-rgb))]";
const LOSS = "bg-red-400";
/** Profit in green, loss in red, zero neutral - the chart's own colours (the rest of the page uses the theme accent for gains). */
const tone = (value: string) => (isZero(value) ? "text-ix-muted" : isNegative(value) ? "text-red-400" : "text-[rgb(var(--ix-profit-rgb))]");

/** The Profit & Loss Trend: one bar per hour, day, week or month of the selected period - green above the zero baseline for a profit, red below it for a loss. Every figure comes
 *  from the Finance Service (the same recognised facts as the Profit & Loss card), nothing is calculated here except the bar heights. */
export default function PnlChart({ state, currency, onRetry }: { state: PnlState; currency: string; onRetry: () => void }) {
  const [active, setActive] = useState<number | null>(null);
  const [grown, setGrown] = useState(false); // the bars grow from the baseline when new data arrives (no animation for people who asked for reduced motion: see the classes)
  const root = useRef<HTMLDivElement>(null);
  const touch = useRef(false); // a finger has no "mouse leaving the bar": on a phone the tooltip stays until another tap
  const trend = state.status === "ready" ? state.trend : null;
  const chart = trend?.by_currency[currency];
  const timeZone = trend?.period.timezone ?? "UTC";
  const scale = useMemo(() => (chart ? pnlScale(chart.buckets) : null), [chart]);

  useEffect(() => {
    setActive(null);
    setGrown(false);
    const id = setTimeout(() => setGrown(true), 30);
    return () => clearTimeout(id);
  }, [chart]);

  useEffect(() => {
    // a tap elsewhere closes the tooltip (on a phone there is no mouse leaving the bar)
    const away = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setActive(null); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, []);

  const header = (
    <div className="mb-4">
      <h3 className="text-[15px] font-semibold tracking-tight text-ix-text">Profit &amp; Loss Trend</h3>
      <p className="mt-0.5 text-xs leading-relaxed text-ix-muted">Track your business profitability over time.</p>
    </div>
  );

  if (state.status === "loading") {
    return (
      <GlassCard className="p-5" aria-label="Profit and Loss Trend" data-testid="pnl-chart">
        {header}
        <p role="status" className="rounded-2xl border border-dashed border-ix-mist/15 px-4 py-10 text-center text-sm text-ix-muted">Loading profit and loss…</p>
      </GlassCard>
    );
  }
  if (state.status === "error") {
    return (
      <GlassCard className="p-5" aria-label="Profit and Loss Trend" data-testid="pnl-chart">
        {header}
        <div role="alert" data-testid="pnl-error" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200/25 bg-amber-100/10 px-4 py-4 text-sm text-amber-100">
          <span>We couldn&apos;t load the profit and loss chart just now. Nothing was lost.</span>
          <button type="button" onClick={onRetry} className={buttonClass.secondary}>Try again</button>
        </div>
      </GlassCard>
    );
  }

  const incomplete = trend ? trend.incomplete.needs_cost + trend.incomplete.needs_price : 0;
  const hasActivity = Boolean(chart?.totals.has_activity);
  const notice = incomplete > 0 && (
    <p role="note" data-testid="pnl-incomplete" className="mb-3 rounded-xl border border-amber-200/25 bg-amber-100/10 px-3 py-2 text-xs text-amber-100">
      {incomplete} {incomplete === 1 ? "delivery has" : "deliveries have"} no reliable {trend!.incomplete.needs_price > 0 && trend!.incomplete.needs_cost === 0 ? "price" : "cost"} yet, so {incomplete === 1 ? "its" : "their"} profit is not in this chart. Reconcile {incomplete === 1 ? "it" : "them"} to include it.
    </p>
  );

  if (!chart || !scale || !hasActivity) {
    return (
      <GlassCard className="p-5" aria-label="Profit and Loss Trend" data-testid="pnl-chart">
        {header}
        {notice}
        <p data-testid="pnl-empty" className="rounded-2xl border border-dashed border-ix-mist/15 px-4 py-10 text-center text-sm text-ix-muted">No profit or loss activity for this period.</p>
      </GlassCard>
    );
  }

  const n = chart.buckets.length;
  const step = Math.ceil(n / 8); // at most about eight labels along the bottom
  const tip = active !== null ? chart.buckets[active] : null;
  const total = chart.totals.net;

  return (
    <GlassCard className="p-5" aria-label="Profit and Loss Trend" data-testid="pnl-chart">
      {header}
      <dl className="mb-4 grid grid-cols-3 gap-3 text-xs">
        <div className="rounded-xl border border-ix-mist/10 bg-ix-deep/30 px-3 py-2">
          <dt className="text-ix-muted">Total net profit / loss</dt>
          <dd data-testid="pnl-total" className={`mt-0.5 text-sm font-semibold ${tone(total)}`}>{signedWithCurrency(total, currency)}</dd>
        </div>
        <div className="rounded-xl border border-ix-mist/10 bg-ix-deep/30 px-3 py-2">
          <dt className="text-ix-muted">Profitable periods</dt>
          <dd data-testid="pnl-profitable" className="mt-0.5 text-sm font-semibold text-ix-text">{chart.totals.profitable_periods}</dd>
        </div>
        <div className="rounded-xl border border-ix-mist/10 bg-ix-deep/30 px-3 py-2">
          <dt className="text-ix-muted">Loss-making periods</dt>
          <dd data-testid="pnl-loss" className="mt-0.5 text-sm font-semibold text-ix-text">{chart.totals.loss_periods}</dd>
        </div>
      </dl>
      {notice}
      {isZero(total) && <p role="note" data-testid="pnl-zero" className="mb-3 text-xs text-ix-muted">Profit and loss balance out to zero over this period.</p>}
      {trend && !trend.combined_available && <p className="mb-3 text-xs text-ix-muted">Shown in {currency} only: other currencies are never added to it.</p>}

      <div ref={root} className="relative pl-12 pr-1" onPointerDown={(e) => { touch.current = e.pointerType === "touch"; }} onMouseLeave={() => { if (!touch.current) setActive(null); }}>
        <div className="relative h-56" role="group" aria-label={`Net profit or loss per ${trend!.granularity}, ${currency}`}>
          {scale.ticks.map((t) => (
            <div key={t.value} aria-hidden="true" className="absolute inset-x-0 border-t border-dashed border-ix-mist/10" style={{ bottom: `${t.pct}%` }}>
              <span className="absolute -left-12 w-10 -translate-y-1/2 pr-1 text-right text-[10px] text-ix-muted">{compactNumber(t.value)}</span>
            </div>
          ))}
          <div aria-hidden="true" data-testid="pnl-baseline" className="absolute inset-x-0 z-10 border-t-2 border-ix-mist/60" style={{ bottom: `${scale.baselinePct}%` }}>
            <span className="absolute -left-12 w-10 -translate-y-1/2 pr-1 text-right text-[10px] font-medium text-ix-muted">0</span>
          </div>
          <div className="absolute inset-0 flex gap-1 sm:gap-1.5">
            {chart.buckets.map((bucket, i) => {
              const bar = scale.bars[i];
              const label = `${bucketPeriod(bucket, trend!.granularity, timeZone)}: ${bar.kind === "none" ? "no activity" : `${bar.kind === "zero" ? "zero" : bar.kind === "profit" ? "profit" : "loss"} ${signedWithCurrency(bucket.net, currency)}`}`;
              return (
                <button
                  key={bucket.start} type="button" data-testid="pnl-bar" data-kind={bar.kind} aria-label={label} aria-describedby={active === i ? "pnl-tooltip" : undefined}
                  onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onClick={() => setActive(i)} onKeyDown={(e) => { if (e.key === "Escape") setActive(null); }}
                  className={`relative h-full min-w-0 flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60 ${active === i ? "bg-ix-mist/10" : "hover:bg-ix-mist/5"}`}
                >
                  {bar.kind === "profit" && (
                    <span className={`absolute inset-x-[12%] rounded-t-md ${PROFIT} transition-[height] duration-500 ease-out motion-reduce:transition-none`} style={{ bottom: `${scale.baselinePct}%`, height: grown ? `${bar.heightPct}%` : "0%" }} />
                  )}
                  {bar.kind === "loss" && (
                    <span className={`absolute inset-x-[12%] rounded-b-md ${LOSS} transition-[height] duration-500 ease-out motion-reduce:transition-none`} style={{ top: `${100 - scale.baselinePct}%`, height: grown ? `${bar.heightPct}%` : "0%" }} />
                  )}
                  {bar.kind === "zero" && <span className="absolute inset-x-[12%] h-0.5 -translate-y-1/2 rounded bg-ix-muted" style={{ bottom: `${scale.baselinePct}%` }} />}
                </button>
              );
            })}
          </div>

          {tip && active !== null && (
            <div
              id="pnl-tooltip" role="tooltip" data-testid="pnl-tooltip"
              className={`pointer-events-none absolute top-0 z-20 w-64 max-w-[80vw] rounded-2xl border border-ix-mist/25 bg-ix-deep px-3.5 py-3 text-xs text-ix-text shadow-xl shadow-black/30 ${active < n / 2 ? "" : "-translate-x-full"}`}
              style={{ left: `${((active + (active < n / 2 ? 0.8 : 0.2)) / n) * 100}%` }}
            >
              <p className="mb-1.5 font-semibold">{bucketPeriod(tip, trend!.granularity, timeZone)}</p>
              <dl className="space-y-1">
                <div className="flex justify-between gap-3"><dt className="text-ix-muted">Sales Revenue</dt><dd className="whitespace-nowrap">{withCurrency(tip.revenue, currency)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-ix-muted">Cost of Goods Sold</dt><dd className="whitespace-nowrap">{withCurrency(tip.cost_of_goods_sold, currency)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-ix-muted">Expenses / Adjustments</dt><dd className="whitespace-nowrap">{withCurrency(tip.other_costs, currency)}</dd></div>
                <div className="flex justify-between gap-3 border-t border-ix-mist/15 pt-1 font-semibold"><dt>Net Profit / Loss</dt><dd data-testid="pnl-tooltip-net" className={tone(tip.net)}>{signedWithCurrency(tip.net, currency)}</dd></div>
              </dl>
            </div>
          )}
        </div>
        <div aria-hidden="true" className="mt-2 flex gap-1 sm:gap-1.5">
          {chart.buckets.map((bucket, i) => (
            <span key={bucket.start} className="min-w-0 flex-1 truncate text-center text-[10px] text-ix-muted">{i % step === 0 ? bucketLabel(bucket, trend!.granularity, timeZone) : ""}</span>
          ))}
        </div>
      </div>
    </GlassCard>
  );
}
