// THE PNL CALCULATOR's arithmetic. Profit = the selling price of the order - the cost of the goods - the delivery charges - every other expense. Every amount is an exact decimal
// string in the order's one currency (nothing is converted, nothing goes through floating point); a blank box counts as zero.

import { lineTotal } from "@/lib/product-validation";

const MONEY_RE = /^[0-9]{1,14}(?:\.[0-9]{1,4})?$/; // up to 14 digits and 4 decimals, the same as the services

export type OtherExpense = { label: string; amount: string };
export type PnlInput = { selling: string; goods: string; delivery: string; others: OtherExpense[] };
export type PnlResult = {
  selling: string;
  goods: string;
  delivery: string;
  others: string;
  /** goods + delivery + every other expense */
  expenses: string;
  /** selling price - expenses: negative when the trade loses money */
  profit: string;
  verdict: "profit" | "loss" | "even";
};

export const MAX_OTHER_EXPENSES = 20;

export const toUnits = (value: string): bigint => {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const units = BigInt(whole + fraction.padEnd(4, "0").slice(0, 4));
  return negative ? -units : units;
};
export const fromUnits = (units: bigint): string => {
  const negative = units < BigInt(0);
  const digits = (negative ? -units : units).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
};

/** What was typed as an amount: the exact decimal (up to 14 digits and 4 decimals, zero or more), "0.0000" for a blank box, null when it is not an amount. */
export function amountOf(value: string): string | null {
  const v = value.trim();
  if (v === "") return "0.0000";
  if (!MONEY_RE.test(v)) return null;
  return fromUnits(toUnits(v));
}

/** The result of one trade, or null while any amount is not a valid amount. */
export function computePnl(input: PnlInput): PnlResult | null {
  const selling = amountOf(input.selling), goods = amountOf(input.goods), delivery = amountOf(input.delivery);
  if (selling === null || goods === null || delivery === null) return null;
  let others = BigInt(0);
  for (const item of input.others) {
    const amount = amountOf(item.amount);
    if (amount === null) return null;
    others += toUnits(amount);
  }
  const expenses = toUnits(goods) + toUnits(delivery) + others;
  const profit = toUnits(selling) - expenses;
  return {
    selling, goods, delivery, others: fromUnits(others), expenses: fromUnits(expenses), profit: fromUnits(profit),
    verdict: profit > BigInt(0) ? "profit" : profit < BigInt(0) ? "loss" : "even",
  };
}

/** A signed result without its sign ("-1200.5000" -> "1200.5000"): the words Profit / Loss carry the meaning. */
export const magnitude = (signed: string): string => (signed.startsWith("-") ? signed.slice(1) : signed);

type Line = { product_id: string; ordered_quantity: string };
export type ProductCost = { cost_price: string; currency_code: string };

/** The cost of the goods on an order from the products' cost prices (quantity x cost price, exact). `complete` is false when a product has no cost price in the order's currency:
 *  the person is then asked to enter the cost, and `missing` says how many products could not be priced. */
export function goodsCostOf(lines: Line[], costs: Record<string, ProductCost | undefined>, currency: string): { value: string; complete: boolean; missing: number } {
  let sum = BigInt(0);
  let missing = 0;
  for (const line of lines) {
    const cost = costs[line.product_id];
    const total = cost && cost.currency_code === currency ? lineTotal(line.ordered_quantity, cost.cost_price) : null;
    if (total === null) missing += 1;
    else sum += toUnits(total);
  }
  return { value: fromUnits(sum), complete: missing === 0, missing };
}
