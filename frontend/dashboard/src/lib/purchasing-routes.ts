import { validatePrice } from "@/lib/purchasing-browser";
import { QUANTITY_RE, checkUuid, text } from "@/lib/sales-routes";

export * from "@/lib/sales-routes"; // fail, readObject, sessionToken, text, collapse, checkUuid, checkQuantity, ...

/** Unit price as an exact string (zero is allowed, e.g. a free sample). */
export function checkPrice(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: false, message: "Enter the price as a number." };
  const problem = validatePrice(value.trim());
  return problem ? { ok: false, message: problem } : { ok: true, value: value.trim() };
}

/** A date input value (YYYY-MM-DD) that is a real calendar date, or null. */
export function checkDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

export const CURRENCY_RE = /^[A-Z]{3}$/;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A quantity that may be zero: exact decimal text, at most 14 digits before and 4 after the point. */
export function checkReceivedQuantity(value: unknown, label: string): { ok: true; value: string } | { ok: false; message: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: "0" };
  if (typeof value !== "string") return { ok: false, message: `Enter the ${label} quantity as a number.` };
  const trimmed = value.trim();
  return QUANTITY_RE.test(trimmed) ? { ok: true, value: trimmed } : { ok: false, message: `Use a number with at most 4 decimals for the ${label} quantity.` };
}

export type ReceiptLineBody = { purchase_order_line_id: string; accepted_quantity: string; rejected_quantity: string; notes?: string };

/** The lines of a goods receipt as sent by the browser: only ids, quantities (exact strings) and a note are read. */
export function parseReceiptLines(value: unknown): { ok: true; lines: ReceiptLineBody[] } | { ok: false; message: string; fieldErrors?: Record<string, string> } {
  if (!Array.isArray(value)) return { ok: false, message: "Send the receipt lines as a list." };
  if (value.length > 500) return { ok: false, message: "A receipt can have at most 500 lines." };
  const lines: ReceiptLineBody[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, message: "Invalid receipt line." };
    const item = entry as Record<string, unknown>;
    const lineId = checkUuid(item.purchaseOrderLineId);
    if (!lineId) return { ok: false, message: "Product not found on this purchase order." };
    const accepted = checkReceivedQuantity(item.acceptedQuantity, "accepted");
    if (!accepted.ok) return { ok: false, message: accepted.message, fieldErrors: { acceptedQuantity: accepted.message } };
    const rejected = checkReceivedQuantity(item.rejectedQuantity, "rejected");
    if (!rejected.ok) return { ok: false, message: rejected.message, fieldErrors: { rejectedQuantity: rejected.message } };
    const notes = text(item.notes) ?? "";
    if (notes.length > 500) return { ok: false, message: "Use 500 characters or fewer for a line note." };
    lines.push({
      purchase_order_line_id: lineId, accepted_quantity: accepted.value, rejected_quantity: rejected.value,
      ...(notes ? { notes } : {}),
    });
  }
  return { ok: true, lines };
}
