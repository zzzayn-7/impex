import { newIdempotencyKey } from "@/lib/stock-validation";

// Posting ONE stock change from the browser to the portal's own /api/stock/<action> route, and telling the caller what happened in a form it can act on.
// The Inventory Service stays the authority (units, reservations, history rules); this only carries the request, with its Idempotency-Key, and reports the
// answer. The same key with the same body is applied ONCE however often it is sent, so a retry can never count a quantity twice.

export type StockPost =
  | { ok: true; replayed: boolean }
  | { ok: false; status: number; message: string; unreachable?: boolean; unauthorized?: boolean };

export async function postStockChange(action: "opening" | "in" | "out", body: { product_id: string; quantity: string; reason?: string }, key: string = newIdempotencyKey()): Promise<StockPost> {
  try {
    const res = await fetch(`/api/stock/${action}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (res.status === 401) return { ok: false, status: 401, message: "Your session has expired. Please sign in again.", unauthorized: true };
    if (!res.ok) {
      const field = data?.fieldErrors && typeof data.fieldErrors === "object" ? Object.values(data.fieldErrors as Record<string, string>)[0] : null;
      return { ok: false, status: res.status, message: typeof field === "string" ? field : typeof data?.error === "string" ? data.error : "That did not work. Please try again." };
    }
    return { ok: true, replayed: Boolean(data?.operation?.replayed) };
  } catch {
    return { ok: false, status: 0, message: "Unable to reach the server.", unreachable: true };
  }
}
