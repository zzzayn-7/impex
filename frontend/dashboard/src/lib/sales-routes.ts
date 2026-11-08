import { NextRequest, NextResponse } from "next/server";

import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { QUANTITY_RE, UUID_RE, validateQuantity } from "@/lib/stock-validation";

// Shared by the /api/sales/* route handlers. Every handler: reads the tenant session from the HttpOnly cookie (no cookie =
// 401 and nothing is sent anywhere), accepts only the fields it lists, validates them, and lets the Sales Service decide
// everything that matters (the organization, product details, stock). The browser never supplies those.

export const NO_STORE = { "Cache-Control": "no-store" };

export function fail(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

export function sessionToken(req: NextRequest): string | undefined {
  return req.cookies.get(TENANT_SESSION_COOKIE)?.value;
}

/** The JSON object of a write request, or the error response to return. */
export async function readObject(req: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Invalid request.", 415);
  const body = (await req.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Invalid request.", 400);
  return body as Record<string, unknown>;
}

export const isResponse = (value: unknown): value is NextResponse => value instanceof NextResponse;

export const text = (value: unknown): string | undefined => (typeof value === "string" ? value.trim() : undefined);
export const collapse = (value: string) => value.replace(/\s+/g, " ");

export function checkUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/** Quantity as an exact string. (Whether fractions are allowed for the product's unit is decided by the Sales Service.) */
export function checkQuantity(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: false, message: "Enter the quantity as a number." };
  const problem = validateQuantity(value.trim(), true);
  return problem ? { ok: false, message: problem } : { ok: true, value: value.trim() };
}

export { QUANTITY_RE, UUID_RE };


export type DispatchLineBody = { delivery_list_item_id: string; quantity: string };

/** The lines of a dispatch as sent by the browser: only an item id and an exact quantity string are read. */
export function parseDispatchLines(value: unknown): { ok: true; lines: DispatchLineBody[] } | { ok: false; message: string; fieldErrors?: Record<string, string> } {
  if (!Array.isArray(value)) return { ok: false, message: "Send the dispatch lines as a list." };
  if (value.length > 500) return { ok: false, message: "A dispatch can have at most 500 lines." };
  const lines: DispatchLineBody[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, message: "Invalid dispatch line." };
    const item = entry as Record<string, unknown>;
    const itemId = checkUuid(item.deliveryListItemId);
    if (!itemId) return { ok: false, message: "That product is not on this delivery list." };
    const quantity = checkQuantity(item.quantity);
    if (!quantity.ok) return { ok: false, message: quantity.message, fieldErrors: { quantity: quantity.message } };
    lines.push({ delivery_list_item_id: itemId, quantity: quantity.value });
  }
  return { ok: true, lines };
}

/** A date input value (YYYY-MM-DD) that is a real calendar date, or null. */
export function checkDispatchDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}


// ---- invoices and payments (Step 17B) -------------------------------------------------------------------------------------------------------
const MONEY = /^[0-9]{1,14}(?:\.[0-9]{1,4})?$/;
const RATE = /^(?:100(?:\.0{1,4})?|[0-9]{1,2}(?:\.[0-9]{1,4})?)$/;
export const PAYMENT_METHODS = ["cash", "bank_transfer", "cheque", "card", "mobile_wallet", "other"] as const;
export const INVOICE_STATUSES = ["draft", "issued", "partially_paid", "paid", "void"] as const;
export const PAYMENT_FILTERS = ["unpaid", "partial", "paid", "overdue"] as const;

/** A money amount as an exact string (never a number). Zero is allowed only where `allowZero` says so. */
export function checkMoney(value: unknown, allowZero: boolean): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!MONEY.test(v)) return null;
  return !allowZero && /^0+(?:\.0+)?$/.test(v) ? null : v;
}

/** A tax rate in percent, 0 to 100 with at most 4 decimals, as an exact string. */
export function checkRate(value: unknown): string | null {
  return typeof value === "string" && RATE.test(value.trim()) ? value.trim() : null;
}

export const checkCurrency = (value: unknown): string | null => (typeof value === "string" && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : null);

export type InvoiceLineBody = { dispatch_line_id: string; quantity: string; unit_price: string; discount_amount: string; tax_rate: string; tax_label?: string };

/** The lines of an invoice as sent by the browser: only a dispatch line id, an exact quantity, price, discount and tax rate (and a tax label) are
 *  read. Product, SKU, name, unit and every total come from the Sales Service. */
export function parseInvoiceLines(value: unknown): { ok: true; lines: InvoiceLineBody[] } | { ok: false; message: string; fieldErrors?: Record<string, string> } {
  if (!Array.isArray(value)) return { ok: false, message: "Send the invoice lines as a list." };
  if (value.length > 500) return { ok: false, message: "An invoice can have at most 500 lines." };
  const lines: InvoiceLineBody[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, message: "Invalid invoice line." };
    const line = entry as Record<string, unknown>;
    const id = checkUuid(line.dispatchLineId);
    if (!id) return { ok: false, message: "That dispatched product was not found." };
    const quantity = checkMoney(line.quantity, false);
    if (!quantity) return { ok: false, message: "Enter a quantity greater than zero (at most 4 decimals).", fieldErrors: { quantity: "Enter a quantity greater than zero." } };
    const price = checkMoney(line.unitPrice, true);
    if (!price) return { ok: false, message: "Enter the selling price (zero or more, at most 4 decimals).", fieldErrors: { unitPrice: "Enter the selling price." } };
    const discount = line.discountAmount === undefined || line.discountAmount === "" ? "0" : checkMoney(line.discountAmount, true);
    if (!discount) return { ok: false, message: "Enter the discount as an amount (at most 4 decimals).", fieldErrors: { discountAmount: "Enter the discount as an amount." } };
    const rate = line.taxRate === undefined || line.taxRate === "" ? "0" : checkRate(line.taxRate);
    if (!rate) return { ok: false, message: "Enter the tax rate as a percentage from 0 to 100.", fieldErrors: { taxRate: "Enter a rate from 0 to 100." } };
    const label = collapse(text(line.taxLabel) ?? "");
    if (label.length > 50) return { ok: false, message: "Use 50 characters or fewer for the tax label.", fieldErrors: { taxLabel: "Use 50 characters or fewer." } };
    lines.push({ dispatch_line_id: id, quantity, unit_price: price, discount_amount: discount, tax_rate: rate, ...(label ? { tax_label: label } : {}) });
  }
  return { ok: true, lines };
}
