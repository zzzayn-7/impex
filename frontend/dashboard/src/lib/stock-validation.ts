// Stock quantities and movements: types and the checks shared by the browser forms (instant
// feedback) and the server routes (the real check, before anything is sent on).
//
// Quantities are ALWAYS strings: they are never turned into JavaScript numbers, so nothing is rounded or
// reformatted on the way to the database (NUMERIC(18,4)). Whether a unit may be counted in fractions is decided
// by the Inventory Service (`unit_allows_fractions`), not by a list kept here.

// ---- what the Inventory Service returns (no organization_id is ever included) --------------------------
export type StockProduct = {
  product_id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  unit_allows_fractions: boolean;
  is_active: boolean;
  total_quantity: string;
};

export type MovementType = "opening" | "in" | "out";

export type Movement = {
  id: string;
  operation_id: string;
  product_id: string;
  product_sku: string;
  product_name: string;
  product_unit: string;
  unit_allows_fractions: boolean;
  movement_type: MovementType;
  quantity: string;
  balance_after: string;
  reason: string;
  created_by_email: string;
  created_at: string;
  source_type?: string | null; // 'goods_receipt' for stock added by a confirmed goods receipt
  source_reference?: string | null; // e.g. GR-000001
};

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  opening: "Opening balance",
  in: "Stock in",
  out: "Stock out",
};
export const MOVEMENT_TYPES = Object.keys(MOVEMENT_LABELS) as MovementType[];
// Movements that take stock away.
export const isDebit = (type: MovementType) => type === "out";

// ---- quantities --------------------------------------------------------------------------------------------
export const QUANTITY_RE = /^[0-9]{1,14}(?:\.[0-9]{1,4})?$/; // at most 14 digits before and 4 after the point
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,100}$/;

const isZero = (value: string) => /^0*(?:\.0*)?$/.test(value);
const hasFraction = (value: string) => /\.0*[1-9]/.test(value);

export function validateQuantity(value: string, allowsFractions: boolean, unit?: string): string | undefined {
  if (!value) return "Enter a quantity.";
  if (!QUANTITY_RE.test(value)) return "Use a positive number with at most 4 decimals, e.g. 12 or 2.5.";
  if (isZero(value)) return "Quantity must be greater than zero.";
  if (!allowsFractions && hasFraction(value)) return `Use a whole number${unit ? `: this product is counted in '${unit}'` : ""}.`;
  return undefined;
}

// Strings in, strings out: no Number() anywhere. "10.5000" -> "10.5", "1234.0000" -> "1,234", "0.0000" -> "0".
export function formatQuantity(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

// One key per intended action: resubmitting the same form (a double click, a retry after a timeout) reuses it,
// so the stock service applies the change once and replays the first answer.
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  // crypto.randomUUID() exists only in secure contexts (https or localhost). Over plain http on a LAN address (a phone, another PC) it is
  // missing and used to crash the whole form, so fall back to getRandomValues(), which every browser offers everywhere.
  if (typeof c?.randomUUID === "function") return `ui-${c.randomUUID()}`;
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `ui-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type StockAction = "opening" | "in" | "out";
export const STOCK_ACTIONS: StockAction[] = ["opening", "in", "out"];
export const isStockAction = (value: string): value is StockAction => (STOCK_ACTIONS as string[]).includes(value);

export type StockFormValues = {
  productId: string;
  quantity: string;
  reason: string;
};
export type StockFieldErrors = Partial<Record<keyof StockFormValues, string>>;
export const EMPTY_STOCK_FORM: StockFormValues = { productId: "", quantity: "", reason: "" };

export function normalizeStock<T extends Partial<StockFormValues>>(values: T): T {
  const out: Partial<StockFormValues> = {};
  for (const key of Object.keys(values) as (keyof StockFormValues)[]) {
    const value = values[key];
    if (typeof value === "string") out[key] = key === "reason" ? value.trim().replace(/\s+/g, " ") : value.trim();
  }
  return out as T;
}

export function validateStock(_action: StockAction, v: StockFormValues, allowsFractions: boolean, unit?: string): StockFieldErrors {
  const errors: StockFieldErrors = {};
  if (!UUID_RE.test(v.productId)) errors.productId = "Choose a product.";
  const quantity = validateQuantity(v.quantity, allowsFractions, unit);
  if (quantity) errors.quantity = quantity;
  if (v.reason.length > 255) errors.reason = "Reason must be 255 characters or fewer.";
  return errors;
}

// The request body for the Inventory Service. There is deliberately no organization field.
export function toStockBody(_action: StockAction, v: StockFormValues) {
  return { product_id: v.productId, quantity: v.quantity, ...(v.reason ? { reason: v.reason } : {}) };
}

export const ACTION_LABELS: Record<StockAction, { title: string; submit: string; done: string }> = {
  opening: { title: "Opening balance", submit: "Record opening balance", done: "Opening balance recorded." },
  in: { title: "Add stock", submit: "Add stock", done: "Stock added." },
  out: { title: "Remove stock", submit: "Remove stock", done: "Stock removed." },
};

export const API_FIELD_NAMES: Record<string, keyof StockFormValues> = {
  product_id: "productId",
  quantity: "quantity",
  reason: "reason",
};
