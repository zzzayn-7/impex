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


export type DispatchLineBody = { delivery_list_item_id: string; warehouse_id: string; quantity: string };

/** The lines of a dispatch as sent by the browser: only an item id, a warehouse id and an exact quantity string are read. */
export function parseDispatchLines(value: unknown): { ok: true; lines: DispatchLineBody[] } | { ok: false; message: string; fieldErrors?: Record<string, string> } {
  if (!Array.isArray(value)) return { ok: false, message: "Send the dispatch lines as a list." };
  if (value.length > 500) return { ok: false, message: "A dispatch can have at most 500 lines." };
  const lines: DispatchLineBody[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, message: "Invalid dispatch line." };
    const item = entry as Record<string, unknown>;
    const itemId = checkUuid(item.deliveryListItemId);
    if (!itemId) return { ok: false, message: "That product is not on this delivery list." };
    const warehouseId = checkUuid(item.warehouseId);
    if (!warehouseId) return { ok: false, message: "Choose a warehouse for every line.", fieldErrors: { warehouseId: "Choose a warehouse." } };
    const quantity = checkQuantity(item.quantity);
    if (!quantity.ok) return { ok: false, message: quantity.message, fieldErrors: { quantity: quantity.message } };
    lines.push({ delivery_list_item_id: itemId, warehouse_id: warehouseId, quantity: quantity.value });
  }
  return { ok: true, lines };
}

/** A date input value (YYYY-MM-DD) that is a real calendar date, or null. */
export function checkDispatchDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}
