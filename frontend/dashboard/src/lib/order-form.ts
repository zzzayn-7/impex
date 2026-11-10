// The order form's rules, shared by Create Order and Edit Order (and tested without a browser). Quantities are ALWAYS strings: nothing is turned into
// a JavaScript number, so nothing is rounded on its way to the database (NUMERIC(18,4)). The Sales Service and the Inventory Service judge every
// rule again; this only gives instant feedback.
import { lineTotal } from "@/lib/product-validation";
import { MONEY_RE, exceeds, qty, sumMoney } from "@/lib/sales-browser";
import { newIdempotencyKey, validateQuantity } from "@/lib/stock-validation";

/** A product as the picker shows it: physical stock, what other orders reserved, and what is still available to order. */
export type PickerProduct = {
  product_id: string;
  sku: string;
  name: string;
  unit: string;
  unit_allows_fractions: boolean;
  total_quantity: string;
  reserved_quantity?: string;
  available_quantity?: string;
};

export type OrderRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  fractions: boolean;
  quantity: string;
  onHand: string; // physical stock now
  reserved: string; // reserved in total (this order's own booking included)
  available: string; // the most this line may be set to: available + what this order already holds for it
  min: string; // what was already dispatched: the quantity cannot go below it ("0" for a new line)
  max?: string; // when editing an existing line: the most it may be set to (what is ordered now + what is still free). Without it, `available` is the limit.
  /** The price of ONE unit agreed with THIS client for this order, exactly as typed (a string: never a JavaScript number). "" = not entered yet: it is NEVER read as zero. */
  unitPrice: string;
  /** Once part of the line was dispatched its agreed price is frozen (goods already delivered are never re-priced). */
  priceLocked?: boolean;
};

const ZERO = "0";

export function rowFromProduct(p: PickerProduct): OrderRow {
  const reserved = p.reserved_quantity ?? ZERO;
  return {
    productId: p.product_id, sku: p.sku, name: p.name, unit: p.unit, fractions: p.unit_allows_fractions, quantity: "",
    onHand: p.total_quantity, reserved, available: p.available_quantity ?? p.total_quantity, min: ZERO, unitPrice: "",
  };
}

// ---- the agreed price per piece --------------------------------------------------------------------------------------------------------------------
/** Why this price cannot be used, or undefined. The same rule as an invoice's selling price (a non-negative decimal with at most 14 whole digits and 4
 *  decimals, as the Sales Service's NUMERIC(18,4) takes): an EMPTY price is "not entered" (never zero); an explicit 0 is a price. */
export function validatePrice(value: string, unit = "piece"): string | undefined {
  const v = value.trim();
  if (v === "") return `Enter the price per ${unit}.`;
  if (v.startsWith("-")) return "A price cannot be negative.";
  if (!/^[0-9]*\.?[0-9]*$/.test(v) || v === ".") return "Enter a number such as 120000 or 49.99.";
  if (/^[0-9]*\.[0-9]{5,}$/.test(v)) return "Use at most 4 decimal places.";
  if (!MONEY_RE.test(v)) return /^[0-9]{15,}/.test(v) ? "That price is too large." : "Enter a number such as 120000 or 49.99.";
  return undefined;
}

export function priceErrors(rows: OrderRow[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const row of rows) {
    const problem = validatePrice(row.unitPrice, row.unit);
    if (problem) errors[row.productId] = problem;
  }
  return errors;
}

/** Quantity x per-piece price, exactly (null until both are valid). */
export const rowTotal = (row: OrderRow): string | null => (validateRow(row) === undefined && validatePrice(row.unitPrice) === undefined ? lineTotal(row.quantity.trim(), row.unitPrice.trim()) : null);

/** The order total: the sum of every line total, exactly, or null while any line is not valid yet. */
export function orderTotal(rows: OrderRow[]): string | null {
  const totals = rows.map(rowTotal);
  return rows.length > 0 && totals.every((t): t is string => t !== null) ? sumMoney(totals) : null;
}

/** Checkout may be saved only when there is a product, every quantity is valid and EVERY price is valid (one missing price keeps it off). */
export const readyToSave = (clientId: string, rows: OrderRow[]) => Boolean(clientId) && rows.length > 0 && Object.keys(rowErrors(rows)).length === 0 && Object.keys(priceErrors(rows)).length === 0;

/** Why this line cannot be saved yet, or undefined. */
export function validateRow(row: OrderRow): string | undefined {
  const q = row.quantity.trim();
  const problem = validateQuantity(q, row.fractions, row.unit);
  if (problem) return problem;
  if (row.max !== undefined) {
    if (exceeds(q, row.max)) return `Cannot increase to ${qty(q)}: only ${qty(row.available)} more ${row.unit} ${row.available === "1" ? "is" : "are"} currently available.`;
  } else if (exceeds(q, row.available)) {
    return `Only ${qty(row.available)} ${row.unit} available (${qty(row.reserved)} reserved for orders, ${qty(row.onHand)} on hand).`;
  }
  if (row.min !== ZERO && exceeds(row.min, q)) return `${qty(row.min)} ${row.unit} was already dispatched: the quantity cannot go below that.`;
  return undefined;
}

export function rowErrors(rows: OrderRow[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const row of rows) {
    const problem = validateRow(row);
    if (problem) errors[row.productId] = problem;
  }
  return errors;
}

/** The body the portal's route reads: only product ids, exact quantity strings and (for a priced order) the exact agreed price of one unit. */
export function orderLines(rows: OrderRow[], priced = true) {
  return rows.map((r) => ({ productId: r.productId, quantity: r.quantity.trim(), ...(priced && r.unitPrice.trim() !== "" ? { unitPrice: r.unitPrice.trim() } : {}) }));
}

/** One Idempotency-Key per intended order: pressing Save twice, or retrying after a timeout, reuses it (the order is saved once); a CHANGED order
 *  gets a new key. */
export function keyFor(signature: string, previous: { signature: string; key: string } | null): { signature: string; key: string } {
  return previous && previous.signature === signature ? previous : { signature, key: newIdempotencyKey() };
}

export const signatureOf = (clientId: string, rows: OrderRow[], currency = "") => `${clientId}|${currency}|${rows.map((r) => `${r.productId}:${r.quantity.trim()}:${r.unitPrice.trim()}`).join(",")}`;

/** "Water bottle" typed in the client box matches a registered client regardless of case and spacing: no duplicate customer is ever offered. */
export const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
