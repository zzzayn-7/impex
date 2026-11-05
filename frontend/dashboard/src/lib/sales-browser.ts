// Browser-side helper for the portal's own /api/sales/* routes. The browser never talks to the Sales Service directly and
// never names an organization; the HttpOnly cookie identifies the administrator on the server.
import type { DeliveryItem, DispatchStatus, InvoiceStatus, ListStatus, PaymentMethod, PaymentStatusFilter } from "@/lib/sales";

export const STOCK_NOTICE =
  "Stock is not reserved by a delivery list. Saving it, marking it Ready or cancelling it never changes inventory, and the quantities on hand may change before dispatch.";

export const STATUS_LABELS: Record<ListStatus, string> = {
  draft: "Draft", ready: "Ready", partially_dispatched: "Partially Dispatched", dispatched: "Dispatched", cancelled: "Cancelled",
};

export const STATUS_STYLE: Record<ListStatus, string> = {
  draft: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  ready: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  partially_dispatched: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  dispatched: "border-teal-500/20 bg-teal-500/10 text-teal-300",
  cancelled: "border-slate-600/40 bg-slate-700/30 text-slate-400",
};

export const DISPATCH_STATUS_LABELS: Record<DispatchStatus, string> = { draft: "Draft", posting: "Posting to stock", confirmed: "Confirmed", cancelled: "Cancelled" };

export const DISPATCH_STATUS_STYLE: Record<DispatchStatus, string> = {
  draft: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  posting: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  confirmed: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  cancelled: "border-slate-600/40 bg-slate-700/30 text-slate-400",
};

export const DISPATCH_NOTICE =
  "Preparing, saving or reviewing a dispatch does not change your stock. Stock is deducted only when you confirm the dispatch, and only the quantities on its lines.";

// ---- invoices and payments (Step 17B) ------------------------------------------------------------------------------------------------
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = { draft: "Draft", issued: "Issued", partially_paid: "Partially paid", paid: "Paid", void: "Void" };

export const INVOICE_STATUS_STYLE: Record<InvoiceStatus, string> = {
  draft: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  issued: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  partially_paid: "border-violet-500/20 bg-violet-500/10 text-violet-300",
  paid: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  void: "border-slate-600/40 bg-slate-700/30 text-slate-400",
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatusFilter, string> = { unpaid: "Unpaid", partial: "Partially paid", paid: "Paid", overdue: "Overdue" };

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash", bank_transfer: "Bank transfer", cheque: "Cheque", card: "Card", mobile_wallet: "Mobile wallet", other: "Other",
};

export const INVOICE_NOTICE =
  "Invoicing never changes your stock: it bills goods that were already dispatched. Prices, discounts and taxes are exactly what you enter; Impex applies no country's tax rules. Payments are recorded by hand; nothing is collected from a bank or card.";

export const MONEY_RE = /^[0-9]{1,14}(?:\.[0-9]{1,4})?$/;
export const RATE_RE = /^(?:100(?:\.0{1,4})?|[0-9]{1,2}(?:\.[0-9]{1,4})?)$/;

const UNIT = () => BigInt(10000);
/** A plain decimal string (at most 4 decimals, validated by the caller) as whole units of 0.0001. */
function toUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(4, "0"));
}
function fromUnits(units: bigint): string {
  const negative = units < BigInt(0);
  const digits = (negative ? -units : units).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

export type LineAmounts = { ok: true; subtotal: string; net: string; tax: string; total: string } | { ok: false; message: string };

/** The amounts of one invoice line, worked out EXACTLY (integers, no floating point) the way the Sales Service and its database do:
 *  subtotal = round(quantity x price), net = subtotal - discount, tax = round(net x rate / 100), total = net + tax; halves round UP.
 *  This is only a preview: the service calculates the saved amounts again. */
export function lineAmounts(quantity: string, unitPrice: string, discount: string, taxRate: string): LineAmounts {
  const q = quantity.trim(), p = unitPrice.trim(), d = discount.trim() || "0", r = taxRate.trim() || "0";
  if (!MONEY_RE.test(q) || !MONEY_RE.test(p)) return { ok: false, message: "Enter a quantity and a price." };
  if (!MONEY_RE.test(d)) return { ok: false, message: "Enter the discount as an amount." };
  if (!RATE_RE.test(r)) return { ok: false, message: "Enter the tax rate as a percentage from 0 to 100." };
  const subtotal = (toUnits(q) * toUnits(p) + BigInt(5000)) / UNIT();
  const discountUnits = toUnits(d);
  if (discountUnits > subtotal) return { ok: false, message: "The discount cannot be more than the line amount." };
  const net = subtotal - discountUnits;
  const tax = (net * toUnits(r) + BigInt(500000)) / BigInt(1000000);
  return { ok: true, subtotal: fromUnits(subtotal), net: fromUnits(net), tax: fromUnits(tax), total: fromUnits(net + tax) };
}

/** Add exact money strings. */
export function sumMoney(values: string[]): string {
  return fromUnits(values.reduce((total, v) => total + toUnits(v), BigInt(0)));
}

/** a - b, exactly (may be negative). */
export function subtractMoney(a: string, b: string): string {
  return fromUnits(toUnits(a) - toUnits(b));
}

/** Is money string `a` greater than `b`? */
export function moneyExceeds(a: string, b: string): boolean {
  return toUnits(a) > toUnits(b);
}

/** "25.0000" -> "25.00", "1234.5" -> "1,234.50", "1.6667" -> "1.6667": grouped, at least 2 decimals, never rounded. */
export function formatMoney(value: string): string {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${trimmed}`;
}

/** "10 of 15" as a 0-100 percentage of two plain decimal strings (display only; strings in, an integer out, no floats for the data itself). */
export function percent(part: string, whole: string): number {
  const scale = Math.max(part.split(".")[1]?.length ?? 0, whole.split(".")[1]?.length ?? 0);
  const scaled = (v: string) => { const [i, f = ""] = v.split("."); return BigInt(i + f.padEnd(scale, "0")); };
  const w = scaled(whole);
  if (w === BigInt(0)) return 0;
  const result = Number((scaled(part) * BigInt(100)) / w);
  return Math.max(0, Math.min(100, result));
}

export type ApiResult<T = any> = { ok: boolean; status: number; data: T | null; error: string; code?: string; item?: DuplicateItem; line?: any; fieldErrors?: Record<string, string> };
export type DuplicateItem = { id: string; quantity: string; unit: string; product_name: string };

export async function api<T = any>(url: string, init: RequestInit = {}, fetchFn: typeof fetch = fetch): Promise<ApiResult<T>> {
  try {
    const res = await fetchFn(url, {
      ...init,
      headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
      cache: "no-store",
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return {
      ok: res.ok,
      status: res.status,
      data,
      error: res.ok ? "" : typeof data?.error === "string" ? data.error : "That did not work. Please try again.",
      code: data?.code,
      item: data?.item,
      line: data?.line,
      fieldErrors: data?.fieldErrors,
    };
  } catch {
    return { ok: false, status: 0, data: null, error: "Unable to reach the server. Please try again." };
  }
}

export const jsonBody = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/** Pretty quantity: "10.5000" -> "10.5", "1234.0000" -> "1,234". Strings only: nothing is rounded. */
export function qty(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

/** Add two plain decimal strings exactly (no floats), e.g. for "5" + "8.5" -> "13.5". */
export function addDecimal(a: string, b: string): string {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const total = BigInt(ai + af.padEnd(scale, "0")) + BigInt(bi + bf.padEnd(scale, "0"));
  const digits = total.toString().padStart(scale + 1, "0");
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** Is `wanted` more than `available`? Exact comparison of plain decimal strings. */
export function exceeds(wanted: string, available: string): boolean {
  const scale = Math.max(wanted.split(".")[1]?.length ?? 0, available.split(".")[1]?.length ?? 0);
  const scaled = (v: string) => { const [i, f = ""] = v.split("."); return BigInt(i + f.padEnd(scale, "0")); };
  return scaled(wanted) > scaled(available);
}

/** How much more than available is wanted (exact), as a plain decimal string; "0" when it fits. */
export function shortfall(wanted: string, available: string): string {
  if (!exceeds(wanted, available)) return "0";
  const scale = Math.max(wanted.split(".")[1]?.length ?? 0, available.split(".")[1]?.length ?? 0);
  const scaled = (v: string) => { const [i, f = ""] = v.split("."); return BigInt(i + f.padEnd(scale, "0")); };
  const diff = (scaled(wanted) - scaled(available)).toString().padStart(scale + 1, "0");
  return scale === 0 ? diff : `${diff.slice(0, -scale)}.${diff.slice(-scale)}`;
}

export type { DeliveryItem };
