"use client";

import { useState } from "react";
import Link from "next/link";

import { formatAmount } from "@/lib/dashboard-metrics";
import type { Preferences } from "@/lib/format";
import type { PeriodKey } from "@/lib/finance";
import { formatBps, PERIODS, type PnlPeriodCurrency, type PnlWidgetData } from "@/lib/profit-loss";

// THE HOME PAGE'S PROFIT & LOSS WIDGET: a line graph of the profit (or loss) of the orders delivered in each slice of the chosen period (hours of a day, days of a week or month, months of
// 6 months or a year), with the five period buttons (1 Day, 1 Week, 1 Month, 6 Months, 1 Year). Above it, the total of the period and the return on what was invested. It is drawn here, in the
// browser, from figures the server already worked out for every period, so changing the period needs no new request. Only delivered orders whose expenses were entered in the PNL Calculator
// count. A currency is never added to another: with more than one, a dropdown chooses which is drawn.

const W = 560;
const H = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 16 };

const signed = (value: string, currency: string, prefs: Preferences) => `${value.startsWith("-") ? "-" : "+"}${formatAmount(value.replace("-", ""), prefs)} ${currency}`;

export default function PnlTrendWidget({ data, prefs }: { data: PnlWidgetData; prefs: Preferences }) {
  const [period, setPeriod] = useState<PeriodKey>("1m");
  const [chosen, setChosen] = useState<string>("");
  const currencies = data.periods[period];
  // the currency the person chose, else the one with the most worked-out orders (a business has one main currency)
  const fallback = [...currencies].sort((a, b) => b.calculated - a.calculated || a.currency.localeCompare(b.currency))[0];
  const current: PnlPeriodCurrency | undefined = currencies.find((c) => c.currency === chosen) ?? fallback;
  const label = PERIODS.find((p) => p.key === period)!.label;

  return (
    <div className="space-y-4" data-pnl-widget>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Period" className="flex flex-wrap gap-1 rounded-xl border border-ix-mist/10 bg-ix-deep/30 p-1">
          {PERIODS.map((p) => (
            <button key={p.key} type="button" onClick={() => setPeriod(p.key)} aria-pressed={p.key === period}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${p.key === period ? "bg-ix-accent/15 text-ix-accent-text shadow-[inset_0_0_0_1px_rgb(var(--ix-accent-text-rgb)/0.3)]" : "text-ix-muted hover:bg-ix-mist/10 hover:text-ix-text"}`}>
              {p.label}
            </button>
          ))}
        </div>
        {currencies.length > 1 && (
          <select aria-label="Currency" value={current?.currency ?? ""} onChange={(e) => setChosen(e.target.value)} className="min-h-9 rounded-lg border border-ix-mist/15 bg-ix-deep/50 px-2.5 py-1 text-xs text-ix-text">
            {currencies.map((c) => <option key={c.currency} value={c.currency}>{c.currency}</option>)}
          </select>
        )}
      </div>

      {data.needsSales ? (
        <p className="rounded-xl border border-dashed border-ix-mist/15 px-4 py-8 text-center text-sm text-ix-muted">Profit and loss is worked out from your delivered orders, which needs the Sales module.</p>
      ) : !current ? (
        <p className="rounded-xl border border-dashed border-ix-mist/15 px-4 py-8 text-center text-sm text-ix-muted">
          No delivered order with expenses entered in the last {label.toLowerCase()} yet. Open the <Link href="/pnl-calculator" className="text-ix-accent-text hover:underline">PNL Calculator</Link> to enter them.
        </p>
      ) : (
        <>
          <Summary current={current} prefs={prefs} />
          <LineChart current={current} prefs={prefs} label={`Profit and loss over the last ${label.toLowerCase()} in ${current.currency}`} />
        </>
      )}
    </div>
  );
}

function Summary({ current, prefs }: { current: PnlPeriodCurrency; prefs: Preferences }) {
  const verdict = current.profit.startsWith("-") ? "loss" : /[1-9]/.test(current.profit) ? "profit" : "even";
  const tone = verdict === "loss" ? "text-red-400" : verdict === "profit" ? "text-ix-gain" : "text-ix-text";
  return (
    <dl className="flex flex-wrap items-end gap-x-8 gap-y-2">
      <div>
        <dt className="text-xs text-ix-muted">{verdict === "loss" ? "Loss" : "Profit"}</dt>
        <dd data-pnl-total className={`text-2xl font-semibold tabular-nums tracking-tight ${tone}`}>{signed(current.profit, current.currency, prefs)}</dd>
      </div>
      <div>
        <dt className="text-xs text-ix-muted">Return on investment</dt>
        <dd data-pnl-return className={`text-lg font-semibold tabular-nums ${tone}`}>{current.bps !== null ? formatBps(current.bps) : "—"}</dd>
      </div>
      <div>
        <dt className="text-xs text-ix-muted">Orders</dt>
        <dd className="text-lg font-semibold tabular-nums text-ix-text">{current.calculated}</dd>
      </div>
    </dl>
  );
}

function LineChart({ current, prefs, label }: { current: PnlPeriodCurrency; prefs: Preferences; label: string }) {
  const values = current.points.map((p) => Number(p.value));
  const hi = Math.max(0, ...values), lo = Math.min(0, ...values);
  const span = hi - lo || 1;
  const top = hi + span * 0.08, bottom = lo - (lo < 0 ? span * 0.08 : 0);
  const n = current.points.length;
  const x = (i: number) => PAD.left + (n <= 1 ? (W - PAD.left - PAD.right) / 2 : (i * (W - PAD.left - PAD.right)) / (n - 1));
  const y = (v: number) => PAD.top + ((top - v) / (top - bottom || 1)) * (H - PAD.top - PAD.bottom);
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
  const area = `${line} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const every = Math.max(1, Math.ceil(n / 6));
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full overflow-visible" data-pnl-chart>
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} strokeDasharray="4 4" className="stroke-ix-mist" strokeOpacity="0.35" strokeWidth="1" data-zero-line />
        <path d={area} className="fill-ix-accent-text" fillOpacity="0.1" />
        <path d={line} fill="none" className="stroke-ix-accent-text" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-pnl-line />
        {current.points.map((p, i) => {
          const v = values[i];
          return (
            <circle key={i} cx={x(i)} cy={y(v)} r={n > 40 ? 2 : 3.2} className={`${v > 0 ? "fill-ix-gain" : v < 0 ? "fill-red-400" : "fill-ix-muted"} stroke-ix-deep`} strokeWidth="1.2" data-point={v > 0 ? "gain" : v < 0 ? "loss" : "flat"}>
              <title>{`${p.label}: ${v === 0 ? "0" : signed(p.value, current.currency, prefs)}`}</title>
            </circle>
          );
        })}
        {current.points.map((p, i) => (i % every === 0 || i === n - 1) && (n - 1 - i >= every || i === n - 1 || i % every === 0) ? (
          <text key={`l${i}`} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize="11" className="fill-ix-muted">{p.label}</text>
        ) : null)}
      </svg>
      <div className="sr-only">
        <table>
          <caption>{label}</caption>
          <thead><tr><th scope="col">Period</th><th scope="col">Profit or loss</th></tr></thead>
          <tbody>{current.points.map((p) => <tr key={p.label}><th scope="row">{p.label}</th><td>{signed(p.value, current.currency, prefs)}</td></tr>)}</tbody>
        </table>
      </div>
    </figure>
  );
}
