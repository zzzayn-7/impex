// Warehouses, stock quantities and movements: types and the checks shared by the browser forms (instant
// feedback) and the server routes (the real check, before anything is sent on).
//
// Quantities are ALWAYS strings: they are never turned into JavaScript numbers, so nothing is rounded or
// reformatted on the way to the database (NUMERIC(18,4)). Whether a unit may be counted in fractions is decided
// by the Inventory Service (`unit_allows_fractions`), not by a list kept here.

// ---- what the Inventory Service returns (no organization_id is ever included) --------------------------
export type Warehouse = {
  id: string;
  code: string;
  name: string;
  address: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  products_in_stock: number;
};

export type StockLine = { warehouse_id: string; warehouse_code: string; warehouse_name: string; warehouse_active: boolean; quantity: string };

export type StockProduct = {
  product_id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  unit_allows_fractions: boolean;
  is_active: boolean;
  total_quantity: string;
  available_quantity: string;
  lines: StockLine[];
};

export type MovementType = "opening" | "in" | "out" | "transfer_out" | "transfer_in";

export type Movement = {
  id: string;
  operation_id: string;
  product_id: string;
  product_sku: string;
  product_name: string;
  product_unit: string;
  unit_allows_fractions: boolean;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  movement_type: MovementType;
  quantity: string;
  balance_after: string;
  reason: string;
  transfer_id: string | null;
  created_by_email: string;
  created_at: string;
  source_type?: string | null; // 'goods_receipt' for stock added by a confirmed goods receipt
  source_reference?: string | null; // e.g. GR-000001
};

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  opening: "Opening balance",
  in: "Stock in",
  out: "Stock out",
  transfer_out: "Transfer out",
  transfer_in: "Transfer in",
};
export const MOVEMENT_TYPES = Object.keys(MOVEMENT_LABELS) as MovementType[];
// Movements that take stock away from their warehouse.
export const isDebit = (type: MovementType) => type === "out" || type === "transfer_out";

// ---- warehouses ------------------------------------------------------------------------------------------
export type WarehouseFormValues = { code: string; name: string; address: string };
export type WarehouseFieldErrors = Partial<Record<keyof WarehouseFormValues, string>>;

export const WAREHOUSE_CODE_RE = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
export const EMPTY_WAREHOUSE: WarehouseFormValues = { code: "", name: "", address: "" };

export function normalizeWarehouse<T extends Partial<WarehouseFormValues>>(values: T): T {
  const out: Partial<WarehouseFormValues> = {};
  if (typeof values.code === "string") out.code = values.code.trim().toUpperCase();
  if (typeof values.name === "string") out.name = values.name.trim().replace(/\s+/g, " ");
  if (typeof values.address === "string") out.address = values.address.trim();
  return out as T;
}

const WAREHOUSE_CHECKS: { [K in keyof WarehouseFormValues]: (value: string) => string | undefined } = {
  code: (v) =>
    !v ? "Enter a warehouse code." : v.length > 32 ? "Code must be 32 characters or fewer." : !WAREHOUSE_CODE_RE.test(v) ? "Code may contain only letters, digits and . _ -" : undefined,
  name: (v) => (!v ? "Enter the warehouse name." : v.length > 255 ? "Name must be 255 characters or fewer." : undefined),
  address: (v) => (v.length > 500 ? "Address must be 500 characters or fewer." : undefined),
};

// With `requireAll`, code and name must be present (creating); otherwise only present fields are checked (editing).
export function validateWarehouse(values: Partial<WarehouseFormValues>, requireAll = true): WarehouseFieldErrors {
  const errors: WarehouseFieldErrors = {};
  for (const key of Object.keys(WAREHOUSE_CHECKS) as (keyof WarehouseFormValues)[]) {
    if (!requireAll && !(key in values)) continue;
    const value = values[key] ?? "";
    if (key === "address" && value === "") continue; // the address is optional
    const message = WAREHOUSE_CHECKS[key](value);
    if (message) errors[key] = message;
  }
  return errors;
}

export function warehouseToForm(w: Warehouse): WarehouseFormValues {
  return { code: w.code, name: w.name, address: w.address ?? "" };
}

// The address is optional: blank means "no address" (null), which also clears an existing one when editing.
export function toWarehouseBody(v: Partial<WarehouseFormValues>) {
  const body: Record<string, string | null> = {};
  if (v.code !== undefined) body.code = v.code;
  if (v.name !== undefined) body.name = v.name;
  if (v.address !== undefined) body.address = v.address === "" ? null : v.address;
  return body;
}

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
  return `ui-${globalThis.crypto.randomUUID()}`;
}

export type StockAction = "opening" | "in" | "out" | "transfer";
export const STOCK_ACTIONS: StockAction[] = ["opening", "in", "out", "transfer"];
export const isStockAction = (value: string): value is StockAction => (STOCK_ACTIONS as string[]).includes(value);

export type StockFormValues = {
  productId: string;
  warehouseId: string; // opening / in / out
  fromWarehouseId: string; // transfer
  toWarehouseId: string; // transfer
  quantity: string;
  reason: string;
};
export type StockFieldErrors = Partial<Record<keyof StockFormValues, string>>;
export const EMPTY_STOCK_FORM: StockFormValues = { productId: "", warehouseId: "", fromWarehouseId: "", toWarehouseId: "", quantity: "", reason: "" };

export function normalizeStock<T extends Partial<StockFormValues>>(values: T): T {
  const out: Partial<StockFormValues> = {};
  for (const key of Object.keys(values) as (keyof StockFormValues)[]) {
    const value = values[key];
    if (typeof value === "string") out[key] = key === "reason" ? value.trim().replace(/\s+/g, " ") : value.trim();
  }
  return out as T;
}

export function validateStock(action: StockAction, v: StockFormValues, allowsFractions: boolean, unit?: string): StockFieldErrors {
  const errors: StockFieldErrors = {};
  if (!UUID_RE.test(v.productId)) errors.productId = "Choose a product.";
  if (action === "transfer") {
    if (!UUID_RE.test(v.fromWarehouseId)) errors.fromWarehouseId = "Choose the source warehouse.";
    if (!UUID_RE.test(v.toWarehouseId)) errors.toWarehouseId = "Choose the destination warehouse.";
    else if (v.fromWarehouseId === v.toWarehouseId) errors.toWarehouseId = "Choose a different warehouse than the source.";
  } else if (!UUID_RE.test(v.warehouseId)) {
    errors.warehouseId = "Choose a warehouse.";
  }
  const quantity = validateQuantity(v.quantity, allowsFractions, unit);
  if (quantity) errors.quantity = quantity;
  if (v.reason.length > 255) errors.reason = "Reason must be 255 characters or fewer.";
  return errors;
}

// The request body for the Inventory Service. There is deliberately no organization field.
export function toStockBody(action: StockAction, v: StockFormValues) {
  const base = { product_id: v.productId, quantity: v.quantity, ...(v.reason ? { reason: v.reason } : {}) };
  return action === "transfer"
    ? { ...base, from_warehouse_id: v.fromWarehouseId, to_warehouse_id: v.toWarehouseId }
    : { ...base, warehouse_id: v.warehouseId };
}

export const ACTION_LABELS: Record<StockAction, { title: string; submit: string; done: string }> = {
  opening: { title: "Opening balance", submit: "Record opening balance", done: "Opening balance recorded." },
  in: { title: "Add stock", submit: "Add stock", done: "Stock added." },
  out: { title: "Remove stock", submit: "Remove stock", done: "Stock removed." },
  transfer: { title: "Transfer", submit: "Transfer stock", done: "Stock transferred." },
};

export const API_FIELD_NAMES: Record<string, keyof StockFormValues> = {
  product_id: "productId",
  warehouse_id: "warehouseId",
  from_warehouse_id: "fromWarehouseId",
  to_warehouse_id: "toWarehouseId",
  quantity: "quantity",
  reason: "reason",
};
