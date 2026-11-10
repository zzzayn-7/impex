"use client";

import Link from "next/link";

import { CardNote } from "@/components/dashboard/glass";
import { GlassPanel } from "@/components/ui/glass";
import { SectionHeader, StatusBadge } from "@/components/ui/page";
import { DataTable, Pagination, TableHead, Th } from "@/components/ui/table";
import type { FinanceHistory, HistoryCategory, HistoryRow } from "@/lib/finance";
import { CATEGORY_LABELS, CATEGORY_ORDER, formatDay, isZero, signed, sourceHref, toneOfAmount } from "@/lib/finance-view";
import { formatMoney } from "@/lib/sales-browser";

function AmountCell({ row }: { row: HistoryRow }) {
  if (row.amount === null) return <span className="text-ix-muted">Unknown</span>;
  const code = row.currency_code ? <span className="ml-1 text-[10px] text-ix-muted">{row.currency_code}</span> : null;
  if (row.category === "investments" && row.direction !== "exchange") {
    return <span className={`font-medium ${toneOfAmount(row.amount)}`}>{signed(row.amount)}{code}</span>;
  }
  return <span className="text-ix-text">{formatMoney(row.amount)}{code}</span>;
}

function ProfitCell({ row }: { row: HistoryRow }) {
  if (row.status === "needs_cost" || row.status === "needs_price") return <span className="text-amber-100/80">Pending</span>;
  if (row.profit_loss === null) return <span className="text-ix-muted">—</span>;
  return <span className={`font-medium ${toneOfAmount(row.profit_loss)}`}>{isZero(row.profit_loss) ? formatMoney("0") : signed(row.profit_loss)}</span>;
}

/** The transactions behind the figures: filterable by category, newest first, each with a link to where it came from and the actions that apply to it. */
export default function HistoryPanel({ history, category, busy, timeZone, onCategory, onPage, onReconcile, onReverse }: {
  history: FinanceHistory;
  category: HistoryCategory;
  busy: boolean;
  timeZone: string;
  onCategory: (category: HistoryCategory) => void;
  onPage: (page: number) => void;
  onReconcile: (row: HistoryRow) => void;
  onReverse: (row: HistoryRow) => void;
}) {
  return (
    <GlassPanel className="space-y-4 p-4 sm:p-5" aria-label="Transaction history" id="finance-history">
      <SectionHeader title="Transaction history" subtitle={`${history.period.label}: every investment, sale, expense and adjustment behind the figures above.`} />
      <div role="group" aria-label="Filter transactions" className="flex flex-wrap gap-2">
        {CATEGORY_ORDER.map((key) => (
          <button
            key={key} type="button" aria-pressed={category === key} onClick={() => onCategory(key)} disabled={busy}
            className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${category === key ? "border-ix-accent/60 bg-ix-accent/15 text-ix-text" : "border-ix-mist/20 bg-ix-mist/5 text-ix-muted hover:bg-ix-mist/10"}`}
          >
            {CATEGORY_LABELS[key]}
          </button>
        ))}
      </div>

      {history.items.length === 0 ? (
        <CardNote>No transactions in this period{category === "all" ? "" : ` under “${CATEGORY_LABELS[category]}”`}.</CardNote>
      ) : (
        <DataTable caption="Transactions">
          <TableHead><Th>Date</Th><Th>Client / Description</Th><Th>Transaction</Th><Th right>Amount</Th><Th right>Profit / Loss</Th></TableHead>
          <tbody className="divide-y divide-ix-mist/10">
            {history.items.map((row) => {
              const href = sourceHref(row);
              const needs = row.status === "needs_cost" || row.status === "needs_price";
              return (
                <tr key={row.id} data-testid="history-row" data-kind={row.kind} className="align-top">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-ix-muted">{formatDay(row.occurred_at, timeZone)}</td>
                  <td className="px-4 py-3">
                    {row.counterparty && <div className="text-sm font-medium text-ix-text">{row.counterparty}</div>}
                    <div className={row.counterparty ? "text-xs text-ix-muted" : "text-sm text-ix-text"}>
                      {href ? <Link href={href} className="underline-offset-2 hover:text-ix-accent hover:underline">{row.description}</Link> : row.description}
                    </div>
                    {(row.reference || row.notes) && <div className="mt-0.5 text-[11px] text-ix-muted/80">{[row.reference, row.notes].filter(Boolean).join(" · ")}</div>}
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-xs sm:hidden" data-testid="history-row-compact">
                      <span><span className="font-sans text-ix-muted">Amount </span><AmountCell row={row} /></span>
                      {row.category !== "investments" && <span><span className="font-sans text-ix-muted">Profit / Loss </span><ProfitCell row={row} /></span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {needs ? <StatusBadge tone="warning">{row.status === "needs_cost" ? "Needs cost reconciliation" : "Needs price reconciliation"}</StatusBadge> : <span className="text-ix-text">{row.transaction}</span>}
                    {row.kind === "inventory_purchase" && <div className="mt-0.5 text-[11px] text-ix-muted">Not new capital</div>}
                    <div className="mt-1 flex flex-wrap gap-2">
                      {needs && row.delivery_id && <button type="button" onClick={() => onReconcile(row)} className="text-ix-accent underline-offset-2 hover:underline">Reconcile</button>}
                      {row.can_reverse && <button type="button" onClick={() => onReverse(row)} className="text-ix-accent underline-offset-2 hover:underline">Reverse</button>}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs"><AmountCell row={row} /></td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs"><ProfitCell row={row} /></td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
      <Pagination total={history.total} offset={history.offset} shown={history.items.length} page={Math.floor(history.offset / history.limit) + 1} busy={busy} onPage={onPage} />
    </GlassPanel>
  );
}
