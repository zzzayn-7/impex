"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";

import { GlassCard } from "@/components/dashboard/glass";
import { buttonClass } from "@/components/ui/controls";
import { PageHeader, SectionHeader } from "@/components/ui/page";
import type { Account, CurrencyBlock, FinanceHistory, FinanceSummary, HistoryCategory, HistoryRow, PeriodKey, PnlTrend } from "@/lib/finance";
import { api } from "@/lib/finance-browser";
import { FINANCE_PAGE_NOTE, PERIODS, RECONCILIATION_HELP, SUBTITLE, TITLE } from "@/lib/finance-view";
import { ExpenseModal, OpeningPositionModal, RecordInvestmentModal, ReconcileModal, ReverseModal, StockCostModal } from "./finance-modals";
import HistoryPanel from "./history-panel";
import PnlChart, { type PnlState } from "./pnl-chart";
import { SummaryCards, TrendChart } from "./summary-cards";

type Modal = null | { kind: "investment" } | { kind: "expense" } | { kind: "opening" } | { kind: "stock" } | { kind: "reconcile"; focus: string | null } | { kind: "reverse"; row: HistoryRow };

/** A currency with no records yet: all zeros (nothing is shown as a figure that was never calculated). */
function emptyBlock(currency: string): CurrencyBlock {
  const flat = { absolute: "0.0000", percent: "0.0", state: "value" as const, direction: "flat" as const };
  return {
    currency_code: currency, capital: { ready: false, basis: null },
    investment: { closing: "0.0000", opening: "0.0000", change: flat, contributions: "0.0000", withdrawals: "0.0000", net_invested: "0.0000", inventory_purchases: "0.0000" },
    profit_loss: { net: "0.0000", gross_profit: "0.0000", revenue: "0.0000", cost_of_goods_sold: "0.0000", expenses: "0.0000", adjustments: "0.0000", needs_cost_count: 0, needs_cost_revenue: "0.0000" }, trend: [],
  };
}

/** The Finance page: three summary cards (Capital, Investment, Profit & Loss), one trend line and the transaction history, for a rolling period. */
export default function FinanceView({ initialSummary, initialHistory, expenseCategories, initialPnl = null }: { initialSummary: FinanceSummary; initialHistory: FinanceHistory; expenseCategories: Account[]; initialPnl?: PnlTrend | null }) {
  const [summary, setSummary] = useState(initialSummary);
  const [history, setHistory] = useState(initialHistory);
  const [period, setPeriod] = useState<PeriodKey>(initialSummary.period.key);
  const [category, setCategory] = useState<HistoryCategory>("all");
  const [currency, setCurrency] = useState<string | null>(null);
  const [pnl, setPnl] = useState<PnlState>(initialPnl ? { status: "ready", trend: initialPnl } : { status: "error", message: "The profit and loss chart could not be loaded." });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const latest = useRef(0);

  const active = currency && summary.currencies.includes(currency) ? currency : summary.currencies[0] ?? summary.default_currency;
  const block = summary.by_currency[active] ?? emptyBlock(active);
  const timeZone = summary.period.timezone;

  const fetchAll = useCallback(async (next: { period: PeriodKey; category: HistoryCategory; currency: string | null; offset: number }, what: "both" | "history" = "both") => {
    const ticket = ++latest.current; // a slower, older answer can never overwrite a newer one
    setBusy(true);
    setError(null);
    const params = new URLSearchParams({ period: next.period, category: next.category, offset: String(next.offset), limit: "25" });
    if (next.currency) params.set("currency", next.currency);
    if (what === "both") setPnl((current) => (current.status === "ready" ? current : { status: "loading" }));
    const [s, h, t] = await Promise.all([
      what === "both" ? api<FinanceSummary>(`/api/finance/summary?period=${next.period}`) : Promise.resolve(null), api<FinanceHistory>(`/api/finance/history?${params}`),
      what === "both" ? api<PnlTrend>(`/api/finance/pnl-trend?period=${next.period}`) : Promise.resolve(null),
    ]);
    if (ticket !== latest.current) return;
    if (t) setPnl(t.ok && t.data ? { status: "ready", trend: t.data } : { status: "error", message: t.error }); // (the chart reports its own failure: the figures above stay)
    setBusy(false);
    if (s && !s.ok) return setError(s.status === 401 ? "Your session has expired. Please sign in again." : s.error);
    if (!h.ok) return setError(h.status === 401 ? "Your session has expired. Please sign in again." : h.error);
    if (s?.data) setSummary(s.data);
    if (h.data) setHistory(h.data);
  }, []);

  const retryPnl = async () => {
    setPnl({ status: "loading" });
    const t = await api<PnlTrend>(`/api/finance/pnl-trend?period=${period}`);
    setPnl(t.ok && t.data ? { status: "ready", trend: t.data } : { status: "error", message: t.error });
  };
  const choosePeriod = (next: PeriodKey) => { if (next === period || busy) return; setPeriod(next); void fetchAll({ period: next, category, currency, offset: 0 }); };
  const chooseCategory = (next: HistoryCategory) => { setCategory(next); void fetchAll({ period, category: next, currency, offset: 0 }, "history"); };
  const chooseCurrency = (next: string) => { setCurrency(next); void fetchAll({ period, category, currency: next, offset: 0 }, "history"); };
  const choosePage = (page: number) => void fetchAll({ period, category, currency, offset: (page - 1) * history.limit }, "history");
  const reload = () => { setModal(null); void fetchAll({ period, category, currency, offset: 0 }); };
  const showInvestments = () => { setCategory("investments"); void fetchAll({ period, category: "investments", currency, offset: 0 }, "history"); document.getElementById("finance-history")?.scrollIntoView?.({ behavior: "smooth", block: "start" }); };

  const tools = (
    <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Finance actions">
      <button type="button" className={buttonClass.primary} onClick={() => setModal({ kind: "investment" })}>Record Investment</button>
      <button type="button" className={buttonClass.secondary} onClick={() => setModal({ kind: "expense" })}>Add Expense</button>
      <button type="button" className={buttonClass.secondary} onClick={() => setModal({ kind: "opening" })}>Opening position</button>
      <button type="button" className={buttonClass.secondary} onClick={() => setModal({ kind: "stock" })}>Stock cost</button>
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <div role="radiogroup" aria-label="Period" className="inline-flex max-w-full overflow-x-auto rounded-xl border border-ix-mist/20 bg-ix-mist/5 p-1" data-testid="period-selector">
            {PERIODS.map((p) => (
              <button
                key={p.key} type="button" role="radio" aria-checked={period === p.key} disabled={busy && period !== p.key} onClick={() => choosePeriod(p.key)}
                className={`min-h-9 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${period === p.key ? "bg-ix-butter text-ix-on-accent shadow" : "text-ix-muted hover:text-ix-text"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        }
      />

      {error && <div role="alert" className="rounded-2xl border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</div>}

      {tools}

      {summary.setup_required && (
        <GlassCard className="flex flex-wrap items-center justify-between gap-3 p-4" role="status" data-testid="setup-banner">
          <p className="min-w-0 flex-1 text-sm text-ix-accent">{summary.setup_message}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass.secondary} onClick={() => setModal({ kind: "opening" })}>Set opening position</button>
            <button type="button" className={buttonClass.secondary} onClick={() => setModal({ kind: "investment" })}>Record contribution</button>
          </div>
        </GlassCard>
      )}

      {summary.reconciliation.total > 0 && (
        <GlassCard className="flex flex-wrap items-center justify-between gap-3 p-4" role="status" data-testid="reconciliation-banner">
          <div className="min-w-0 flex-1 text-sm text-ix-accent">
            <p><span className="inline-flex items-center rounded-full border border-ix-accent/30 bg-ix-accent/10 px-2.5 py-0.5 text-xs font-medium text-ix-accent">{summary.reconciliation.total} {summary.reconciliation.total === 1 ? "delivery needs" : "deliveries need"} reconciliation</span></p>
            <p className="mt-1 text-xs text-ix-muted">{RECONCILIATION_HELP}</p>
          </div>
          <button type="button" className={buttonClass.secondary} onClick={() => setModal({ kind: "reconcile", focus: null })}>Reconcile</button>
        </GlassCard>
      )}

      {summary.currencies.length > 1 && (
        <GlassCard className="space-y-3 p-4" data-testid="currency-note">
          <div role="tablist" aria-label="Currency" className="flex flex-wrap gap-2">
            {summary.currencies.map((c) => (
              <button key={c} type="button" role="tab" aria-selected={c === active} onClick={() => chooseCurrency(c)} className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold ${c === active ? "border-ix-accent/60 bg-ix-accent/15 text-ix-text" : "border-ix-mist/20 bg-ix-mist/5 text-ix-muted hover:bg-ix-mist/10"}`}>{c}</button>
            ))}
          </div>
          <p className="text-xs text-ix-muted">{summary.combined_note}</p>
        </GlassCard>
      )}

      <div aria-busy={busy} className={busy ? "opacity-70 transition-opacity" : "transition-opacity"}>
        <SummaryCards summary={summary} block={block} currency={active} onSetup={() => setModal({ kind: "opening" })} onInventoryActivity={showInvestments} />
      </div>

      <GlassCard className="p-5" aria-label="Capital trend">
        <SectionHeader title="Capital trend" subtitle={`${summary.period.label}, ${active}`} />
        <TrendChart block={block} currency={active} timeZone={timeZone} />
      </GlassCard>

      <PnlChart state={pnl} currency={active} onRetry={() => void retryPnl()} />

      <HistoryPanel
        history={history} category={category} busy={busy} timeZone={timeZone} onCategory={chooseCategory} onPage={choosePage}
        onReconcile={(row) => setModal({ kind: "reconcile", focus: row.delivery_id })} onReverse={(row) => setModal({ kind: "reverse", row })}
      />

      <p className="text-xs leading-relaxed text-ix-muted">{FINANCE_PAGE_NOTE}</p>
      <nav aria-label="Accounting records" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ix-muted">
        <span>Accounting records:</span>
        <Link href="/finance/accounting" className="text-ix-accent hover:underline">Accounting overview</Link>
        <Link href="/finance/expenses" className="text-ix-accent hover:underline">Expenses</Link>
        <Link href="/finance/journal" className="text-ix-accent hover:underline">Journal entries</Link>
        <Link href="/finance/accounts" className="text-ix-accent hover:underline">Accounts</Link>
      </nav>

      {modal?.kind === "investment" && <RecordInvestmentModal defaultCurrency={active} onClose={() => setModal(null)} onDone={reload} />}
      {modal?.kind === "expense" && <ExpenseModal categories={expenseCategories} defaultCurrency={active} onClose={() => setModal(null)} onDone={reload} />}
      {modal?.kind === "opening" && <OpeningPositionModal defaultCurrency={active} onClose={() => setModal(null)} onDone={reload} />}
      {modal?.kind === "stock" && <StockCostModal defaultCurrency={active} onClose={() => setModal(null)} onDone={reload} />}
      {modal?.kind === "reconcile" && <ReconcileModal focus={modal.focus} onClose={() => setModal(null)} onDone={() => void fetchAll({ period, category, currency, offset: 0 })} />}
      {modal?.kind === "reverse" && <ReverseModal row={modal.row} onClose={() => setModal(null)} onDone={reload} />}
    </div>
  );
}
