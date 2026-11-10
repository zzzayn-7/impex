// Browser-safe helpers for the Finance page (Capital, Investment and Profit & Loss). Amounts are exact decimal STRINGS from the Finance Service; nothing here turns
// them into numbers except for DRAWING the trend line.
import { formatMoney } from "@/lib/sales-browser";
import type { ChangeFigure, CurrencyBlock, HistoryCategory, HistoryRow, PeriodKey } from "@/lib/finance";

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "1w", label: "1 Week" },
  { key: "1m", label: "1 Month" },
  { key: "1y", label: "1 Year" },
];

export const CATEGORY_LABELS: Record<HistoryCategory, string> = {
  all: "All",
  investments: "Investments",
  profitable_sales: "Profitable sales",
  loss_sales: "Loss-making sales",
  expenses_adjustments: "Expenses & adjustments",
  reconciliation: "Needs reconciliation",
};
export const CATEGORY_ORDER: HistoryCategory[] = ["all", "investments", "profitable_sales", "loss_sales", "expenses_adjustments", "reconciliation"];

export const TITLE = "Finance Overview";
export const SUBTITLE = "Track your business capital, investments, and trading performance.";

export const isNegative = (value: string | null | undefined) => typeof value === "string" && value.startsWith("-");
export const isZero = (value: string | null | undefined) => typeof value === "string" && /^-?0+(\.0+)?$/.test(value);

/** "5400000.0000" -> "PKR 5,400,000.00". */
export const withCurrency = (value: string, currency: string) => `${currency} ${formatMoney(value)}`;

/** "+400,000.00", "-200,000.00" or "0.00". */
export function signed(value: string): string {
  if (isZero(value)) return formatMoney("0");
  return `${isNegative(value) ? "" : "+"}${formatMoney(value)}`;
}

export const TONE_UP = "text-emerald-300";
export const TONE_DOWN = "text-red-300";
export const TONE_FLAT = "text-ix-muted";
export const toneOfDirection = (direction: ChangeFigure["direction"]) => (direction === "up" ? TONE_UP : direction === "down" ? TONE_DOWN : TONE_FLAT);
export const toneOfAmount = (value: string | null | undefined) => (!value || isZero(value) ? TONE_FLAT : isNegative(value) ? TONE_DOWN : TONE_UP);

export type ChangeView = { arrow: "▲" | "▼" | "▬"; label: string; absolute: string; tone: string; aria: string };

/** The percentage change as the page shows it: an arrow and colour, "+50.0%" / "-25.0%" / "0.0%", or "New" for a zero baseline (never a percentage of zero). */
export function changeView(change: ChangeFigure, currency: string): ChangeView {
  const arrow = change.direction === "up" ? "▲" : change.direction === "down" ? "▼" : "▬";
  const absolute = `${signed(change.absolute)} ${currency}`;
  const label = change.state === "new" ? "New" : change.percent === null ? "N/A" : `${change.percent.startsWith("-") || change.percent === "0.0" ? "" : "+"}${change.percent}%`;
  const word = change.direction === "up" ? "increase" : change.direction === "down" ? "decrease" : "no change";
  return { arrow, label, absolute, tone: toneOfDirection(change.direction), aria: `${label}, ${word} of ${absolute} since the start of the period` };
}

/** A date shown in the organization's own time zone ("12 Nov 2026"). */
export function formatDay(iso: string, timeZone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** The page of the portal a history row came from, or null. The Finance Service only says WHAT it came from. */
export function sourceHref(row: Pick<HistoryRow, "source_type" | "source_id">): string | null {
  if (!row.source_id) return row.source_type === "dispatch" ? "/delivery-lists" : null;
  switch (row.source_type) {
    case "goods_receipt": return `/goods-receipts/${row.source_id}`;
    case "expense": return `/finance/expenses/${row.source_id}`;
    case "invoice": return `/invoices/${row.source_id}`;
    case "dispatch": return "/delivery-lists";
    default: return null;
  }
}

/** The trend as SVG points. Display only: the values are plotted as numbers, but they are never shown from these. */
export function trendPoints(trend: CurrencyBlock["trend"], width: number, height: number, pad = 10): { line: string; area: string; last: { x: number; y: number } | null; flat: boolean } {
  if (trend.length < 2) return { line: "", area: "", last: null, flat: true };
  const values = trend.map((p) => Number(p.capital));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const flat = max === min;
  const x = (index: number) => pad + (index * (width - pad * 2)) / (trend.length - 1);
  const y = (value: number) => (flat ? height / 2 : height - pad - ((value - min) * (height - pad * 2)) / (max - min));
  const coords = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  const lastIndex = values.length - 1;
  return {
    line: coords.join(" "),
    area: `${x(0).toFixed(1)},${height - pad} ${coords.join(" ")} ${x(lastIndex).toFixed(1)},${height - pad}`,
    last: { x: x(lastIndex), y: y(values[lastIndex]) },
    flat,
  };
}

export const todayISO = () => new Date().toISOString().slice(0, 10);

export const RECONCILIATION_HELP =
  "These deliveries have no recorded price or no reliable cost yet. Impex never assumes a cost of zero or invents a price, so they are not counted in any profit figure until you reconcile them.";

export const FINANCE_PAGE_NOTE =
  "Capital and Investment are balances at the end of the period compared with the start. Profit & Loss is what happened during it. Buying stock is an investment activity, not new capital; " +
  "profit is recognised once, when goods are delivered. Different currencies are never added together.";
