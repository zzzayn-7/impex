import { validatePrice } from "@/lib/purchasing-browser";

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
