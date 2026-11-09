// The order form's rules, shared by Create Order and Edit Order (and tested without a browser). Quantities are ALWAYS strings: nothing is turned into
// a JavaScript number, so nothing is rounded on its way to the database (NUMERIC(18,4)). The Sales Service and the Inventory Service judge every
// rule again; this only gives instant feedback.
import { exceeds, qty } from "@/lib/sales-browser";
import { newIdempotencyKey, validateQuantity } from "@/lib/stock-validation";

/** A product as the picker shows it: physical stock, what other orders reserved, and what is still available to order. */
export type PickerProduct = {
  product_id: string;
  sku: string;
  name: string;
  category?: string;
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
};

const ZERO = "0";

export function rowFromProduct(p: PickerProduct): OrderRow {
  const reserved = p.reserved_quantity ?? ZERO;
  return {
    productId: p.product_id, sku: p.sku, name: p.name, unit: p.unit, fractions: p.unit_allows_fractions, quantity: "",
    onHand: p.total_quantity, reserved, available: p.available_quantity ?? p.total_quantity, min: ZERO,
  };
}

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

/** The body the portal's route reads: only product ids and exact quantity strings. */
export function orderLines(rows: OrderRow[]) {
  return rows.map((r) => ({ productId: r.productId, quantity: r.quantity.trim() }));
}

/** One Idempotency-Key per intended order: pressing Save twice, or retrying after a timeout, reuses it (the order is saved once); a CHANGED order
 *  gets a new key. */
export function keyFor(signature: string, previous: { signature: string; key: string } | null): { signature: string; key: string } {
  return previous && previous.signature === signature ? previous : { signature, key: newIdempotencyKey() };
}

export const signatureOf = (clientId: string, rows: OrderRow[]) => `${clientId}|${rows.map((r) => `${r.productId}:${r.quantity.trim()}`).join(",")}`;

/** "Water bottle" typed in the client box matches a registered client regardless of case and spacing: no duplicate customer is ever offered. */
export const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
