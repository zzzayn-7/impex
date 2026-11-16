// FINANCE > PROFIT & LOSS: the delivered orders, each with its profit or loss as a percentage of everything spent on it, and the portfolio of a period.
//
// Nothing here is the organization's books. For every order that was DELIVERED the selling price is the order's own total (from Sales) and the investment is everything spent on it:
// the cost of the goods, the delivery charges and every other expense entered in the PNL Calculator. Profit = selling price - investment; the percentage is profit / investment.
// An order whose expenses were never entered is listed as "not calculated" and is left out of the profit figures (the page says how many). Amounts are exact decimals in the order's
// own currency: nothing is converted, so each currency has its own portfolio.

import { computePnl, fromUnits, toUnits } from "@/lib/pnl";
import type { OrderExpenses, PeriodKey } from "@/lib/finance";

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "1d", label: "1 Day" }, { key: "1w", label: "1 Week" }, { key: "1m", label: "1 Month" }, { key: "6m", label: "6 Months" }, { key: "1y", label: "1 Year" },
];
export const REPORT_PAGE_SIZE = 25;
export const DEFAULT_PERIOD: PeriodKey = "1m";
export const parsePeriod = (value: unknown): PeriodKey => (PERIODS.some((p) => p.key === value) ? (value as PeriodKey) : DEFAULT_PERIOD);

/** The start of a period ending at `now`: a day and a week are 24 hours and 7 days back; a month, 6 months and a year are calendar months back (the 31st stays at the end of a shorter month). */
export function periodSince(key: PeriodKey, now: Date): Date {
  if (key === "1d") return new Date(now.getTime() - 24 * 3600 * 1000);
  if (key === "1w") return new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const months = key === "1m" ? 1 : key === "6m" ? 6 : 12;
  const month = now.getUTCMonth() - months;
  const year = now.getUTCFullYear() + Math.floor(month / 12);
  const monthIndex = ((month % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(now.getUTCDate(), lastDay), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds()));
}

export type DeliveredOrder = { id: string; number: string; client_name: string; currency_code: string | null; total_amount: string | null; completed_at: string };

export type RowState = "profit" | "loss" | "even" | "no-expenses" | "no-prices";
export type ReportRow = DeliveredOrder & {
  state: RowState;
  /** signed profit (negative for a loss) and everything spent on the order: only when the state is profit, loss or even */
  profit: string | null;
  invested: string | null;
  /** the result in hundredths of a percent (+10% = 1000, -5.25% = -525); null when nothing was invested, so there is nothing to compare with */
  bps: number | null;
};

/** profit / invested in hundredths of a percent, rounded half away from zero; null when nothing was invested. */
export function bpsOf(profit: string, invested: string): number | null {
  const p = toUnits(profit), i = toUnits(invested);
  if (i === BigInt(0)) return null;
  const scaled = p * BigInt(10000);
  const half = i / BigInt(2);
  const q = (scaled >= BigInt(0) ? scaled + half : scaled - half) / i;
  return Number(q);
}

/** "+10%", "+12.5%", "-5.25%", "0%": at most two decimals, a sign on every result that is not zero. */
export function formatBps(bps: number): string {
  if (bps === 0) return "0%";
  const abs = Math.abs(bps);
  const whole = Math.floor(abs / 100);
  const hundredths = abs % 100;
  const fraction = hundredths === 0 ? "" : `.${String(hundredths).padStart(2, "0").replace(/0$/, "")}`;
  return `${bps > 0 ? "+" : "-"}${whole}${fraction}%`;
}

export type Portfolio = {
  currency: string;
  /** every delivered order of the period that has prices */
  orders: number;
  sales: string;
  /** the orders whose expenses were entered, and what they add up to */
  calculated: number;
  invested: string;
  profit: string;
  bps: number | null;
  verdict: "profit" | "loss" | "even" | "none";
};

export function buildReport(delivered: DeliveredOrder[], saved: OrderExpenses[]): { rows: ReportRow[]; portfolios: Portfolio[]; notCalculated: number } {
  const byOrder = new Map(saved.map((e) => [e.order_id, e]));
  const rows: ReportRow[] = [];
  const books = new Map<string, { orders: number; sales: bigint; calculated: number; invested: bigint; profit: bigint }>();
  let notCalculated = 0;
  for (const order of delivered) {
    if (!order.total_amount || !order.currency_code) {
      rows.push({ ...order, state: "no-prices", profit: null, invested: null, bps: null });
      continue;
    }
    const book = books.get(order.currency_code) ?? { orders: 0, sales: BigInt(0), calculated: 0, invested: BigInt(0), profit: BigInt(0) };
    books.set(order.currency_code, book);
    book.orders += 1;
    book.sales += toUnits(order.total_amount);
    const mine = byOrder.get(order.id);
    const result = mine && mine.currency_code === order.currency_code
      ? computePnl({ selling: order.total_amount, goods: mine.goods_cost, delivery: mine.delivery_charges, others: mine.other_expenses })
      : null;
    if (!result) {
      notCalculated += 1;
      rows.push({ ...order, state: "no-expenses", profit: null, invested: null, bps: null });
      continue;
    }
    book.calculated += 1;
    book.invested += toUnits(result.expenses);
    book.profit += toUnits(result.profit);
    rows.push({ ...order, state: result.verdict, profit: result.profit, invested: result.expenses, bps: bpsOf(result.profit, result.expenses) });
  }
  const portfolios: Portfolio[] = Array.from(books.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([currency, b]) => {
    const profit = fromUnits(b.profit), invested = fromUnits(b.invested);
    return {
      currency, orders: b.orders, sales: fromUnits(b.sales), calculated: b.calculated, invested, profit, bps: b.calculated > 0 ? bpsOf(profit, invested) : null,
      verdict: b.calculated === 0 ? "none" : b.profit > BigInt(0) ? "profit" : b.profit < BigInt(0) ? "loss" : "even",
    };
  });
  return { rows, portfolios, notCalculated };
}
