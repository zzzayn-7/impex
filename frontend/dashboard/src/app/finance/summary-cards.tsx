"use client";

import { useId } from "react";

import { CardHeader, CardNote, GlassCard } from "@/components/dashboard/glass";
import { buttonClass } from "@/components/ui/controls";
import type { CurrencyBlock, FinanceSummary } from "@/lib/finance";
import { changeView, formatDay, isZero, signed, toneOfAmount, trendPoints, withCurrency, type ChangeView } from "@/lib/finance-view";
import { formatMoney } from "@/lib/sales-browser";

/** The arrow, the percentage (or "New") and the absolute change, coloured by direction. The text carries the meaning too: colour alone never does. */
function Change({ view, testId }: { view: ChangeView; testId: string }) {
  return (
    <p data-testid={testId} aria-label={view.aria} className={`mt-1.5 flex flex-wrap items-center gap-x-2 text-sm font-medium ${view.tone}`}>
      <span aria-hidden="true">{view.arrow}</span>
      <span>{view.label}</span>
      <span className="text-xs font-normal text-ix-muted">({view.absolute})</span>
    </p>
  );
}

function SetupNeeded({ message, onSetup }: { message: string | null; onSetup: () => void }) {
  return (
    <div data-testid="capital-setup" className="space-y-3">
      <p className="text-base font-semibold text-amber-100">Setup required</p>
      <p className="text-xs leading-relaxed text-ix-muted">{message ?? "Set your opening position or record an owner contribution."}</p>
      <button type="button" onClick={onSetup} className={`${buttonClass.secondary} !min-h-9 !px-3 !py-1.5 text-xs`}>Set opening position</button>
    </div>
  );
}

/** The three summary cards: Capital, Investment, Profit & Loss - for ONE currency, for the selected period. */
export function SummaryCards({ summary, block, currency, onSetup, onInventoryActivity }: {
  summary: FinanceSummary;
  block: CurrencyBlock;
  currency: string;
  onSetup: () => void;
  onInventoryActivity: () => void;
}) {
  const capital = block.capital;
  const investment = block.investment;
  const pnl = block.profit_loss;
  const purchases = !isZero(investment.inventory_purchases);
  return (
    <div className="grid gap-4 md:grid-cols-3" data-testid="finance-cards">
      <GlassCard className="p-5" aria-label="Capital">
        <CardHeader title="Capital" subtitle="What the business is worth to its owner: assets minus liabilities" />
        {capital.ready && capital.closing !== undefined && capital.change ? (
          <>
            <p data-testid="capital-value" className="text-2xl font-semibold tracking-tight text-ix-text">{withCurrency(capital.closing, currency)}</p>
            <Change view={changeView(capital.change, currency)} testId="capital-change" />
            <p className="mt-3 text-xs text-ix-muted">
              {capital.basis === "opening_position" ? "From your opening position, plus everything since." : "From the owner contributions recorded, plus profit since. Set an opening position to include earlier history."}
            </p>
          </>
        ) : (
          <SetupNeeded message={summary.setup_message} onSetup={onSetup} />
        )}
      </GlassCard>

      <GlassCard className="p-5" aria-label="Investment">
        <CardHeader title="Investment" subtitle="Net capital the owner has invested" />
        <p data-testid="investment-value" className="text-2xl font-semibold tracking-tight text-ix-text">{withCurrency(investment.closing, currency)}</p>
        <Change view={changeView(investment.change, currency)} testId="investment-change" />
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-ix-muted">
          <div><dt>Contributions</dt><dd data-testid="investment-contributions" className="font-medium text-emerald-300">{signed(investment.contributions)}</dd></div>
          <div><dt>Withdrawals</dt><dd data-testid="investment-withdrawals" className={`font-medium ${isZero(investment.withdrawals) ? "text-ix-muted" : "text-red-300"}`}>{isZero(investment.withdrawals) ? formatMoney("0") : `-${formatMoney(investment.withdrawals)}`}</dd></div>
        </dl>
        {purchases && (
          <button type="button" onClick={onInventoryActivity} data-testid="inventory-activity-link" className="mt-3 text-left text-xs text-ix-accent underline-offset-2 hover:underline">
            Inventory investment activity: {withCurrency(investment.inventory_purchases, currency)} bought this period →
          </button>
        )}
      </GlassCard>

      <GlassCard className="p-5" aria-label="Profit and Loss">
        <CardHeader title="Profit & Loss" subtitle="Net result of trading in this period" />
        <p data-testid="pnl-value" className={`text-2xl font-semibold tracking-tight ${toneOfAmount(pnl.net)}`}>{isZero(pnl.net) ? withCurrency(pnl.net, currency) : `${currency} ${signed(pnl.net)}`}</p>
        <dl className="mt-3 space-y-1 text-xs text-ix-muted">
          <div className="flex justify-between gap-3"><dt>Gross trading profit</dt><dd data-testid="pnl-gross" className={`font-medium ${toneOfAmount(pnl.gross_profit)}`}>{signed(pnl.gross_profit)}</dd></div>
          <div className="flex justify-between gap-3"><dt>Expenses included</dt><dd data-testid="pnl-expenses" className="font-medium text-ix-text">{isZero(pnl.expenses) ? formatMoney("0") : `-${formatMoney(pnl.expenses)}`}</dd></div>
          {!isZero(pnl.adjustments) && <div className="flex justify-between gap-3"><dt>Invoice adjustments</dt><dd className={`font-medium ${toneOfAmount(pnl.adjustments)}`}>{signed(pnl.adjustments)}</dd></div>}
        </dl>
        {pnl.needs_cost_count > 0 && (
          <p className="mt-3 text-xs text-amber-100/90">{pnl.needs_cost_count} {pnl.needs_cost_count === 1 ? "delivery needs" : "deliveries need"} cost reconciliation and {pnl.needs_cost_count === 1 ? "is" : "are"} not included.</p>
        )}
      </GlassCard>
    </div>
  );
}

/** One minimal line: the capital at each step of the period. */
export function TrendChart({ block, currency, timeZone }: { block: CurrencyBlock; currency: string; timeZone: string }) {
  const id = useId().replace(/:/g, "");
  const trend = block.trend;
  if (!block.capital.ready || trend.length < 2) {
    return <CardNote>The capital trend appears once capital can be calculated.</CardNote>;
  }
  const { line, area, last, flat } = trendPoints(trend, 600, 150);
  const first = trend[0];
  const end = trend[trend.length - 1];
  return (
    <figure className="space-y-2" data-testid="capital-trend">
      <svg viewBox="0 0 600 150" preserveAspectRatio="none" role="img" aria-label={`Capital from ${withCurrency(first.capital, currency)} on ${formatDay(first.at, timeZone)} to ${withCurrency(end.capital, currency)} on ${formatDay(end.at, timeZone)}${flat ? ", unchanged" : ""}`} className="h-36 w-full text-ix-accent">
        <defs>
          <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#fill-${id})`} />
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {last && <circle cx={last.x} cy={last.y} r="3.5" fill="currentColor" />}
      </svg>
      <figcaption className="flex justify-between text-[11px] text-ix-muted">
        <span>{formatDay(first.at, timeZone)}</span>
        <span>Capital, {currency}</span>
        <span>{formatDay(end.at, timeZone)}</span>
      </figcaption>
    </figure>
  );
}
