// Browser-side helper for the portal's own /api/sales/* routes. The browser never talks to the Sales Service directly and
// never names an organization; the HttpOnly cookie identifies the administrator on the server.
import type { DeliveryItem, ListStatus } from "@/lib/sales";

export const STOCK_NOTICE =
  "Stock is not reserved by a delivery list. Saving it, marking it Ready or cancelling it never changes inventory, and the quantities on hand may change before dispatch.";

export const STATUS_LABELS: Record<ListStatus, string> = { draft: "Draft", ready: "Ready", cancelled: "Cancelled" };

export const STATUS_STYLE: Record<ListStatus, string> = {
  draft: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  ready: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  cancelled: "border-slate-600/40 bg-slate-700/30 text-slate-400",
};

export type ApiResult<T = any> = { ok: boolean; status: number; data: T | null; error: string; code?: string; item?: DuplicateItem; fieldErrors?: Record<string, string> };
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
