// Browser-safe helpers for purchasing: constants and EXACT decimal arithmetic on strings (no floats, ever).
//
// The totals shown while typing are a convenience preview computed here; the Purchasing Service recalculates every line total
// and the order total itself (half-up to 4 decimals, re-checked by the database) and its numbers are the ones that are saved
// and displayed afterwards.
import type { OrderStatus } from "@/lib/purchasing";

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = { draft: "Draft", ordered: "Ordered", cancelled: "Cancelled" };

export const ORDER_STATUS_STYLE: Record<OrderStatus, string> = {
  draft: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  ordered: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  cancelled: "border-slate-600/40 bg-slate-700/30 text-slate-400",
};

export const NO_STOCK_NOTICE =
  "A purchase order does not change your stock. Placing an order does not add the goods to inventory; they are added only when they are received (a later step).";

export const PRICE_RE = /^[0-9]{1,14}(?:\.[0-9]{1,4})?$/; // at most 14 digits before and 4 after the point; zero is allowed

export function validatePrice(value: string): string | undefined {
  if (!value) return "Enter the unit price.";
  if (!PRICE_RE.test(value)) return "Use a number with at most 4 decimals, e.g. 12.50.";
  return undefined;
}

const big = (value: number | string) => BigInt(value);
const pow10 = (n: number) => big("1" + "0".repeat(n)); // 10^n without BigInt literals or `**` (the project's TypeScript target predates them)

const parts = (v: string): [bigint, number] => {
  const [whole, fraction = ""] = v.split(".");
  return [big(whole + fraction), fraction.length];
};

const fixed4 = (value: bigint): string => {
  const digits = value.toString().padStart(5, "0");
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
};

/** round-half-up(quantity x unit price, 4 decimals), as a plain decimal string. Both inputs must be plain non-negative decimals. */
export function lineTotal(quantity: string, unitPrice: string): string {
  const [q, qScale] = parts(quantity);
  const [p, pScale] = parts(unitPrice);
  const scale = qScale + pScale;
  let product = q * p;
  if (scale > 4) {
    const divisor = pow10(scale - 4);
    product = (product + divisor / big(2)) / divisor; // half up (all values are non-negative)
  } else if (scale < 4) {
    product = product * pow10(4 - scale);
  }
  return fixed4(product);
}

/** Sum of plain non-negative decimal strings with at most 4 decimals, exactly. */
export function sumDecimals(values: string[]): string {
  let total = big(0);
  for (const v of values) {
    const [n, scale] = parts(v);
    total = total + n * pow10(Math.max(0, 4 - scale));
  }
  return fixed4(total);
}
