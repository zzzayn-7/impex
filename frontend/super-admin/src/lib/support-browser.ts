// Browser-side helper for the portal's own /api/support/* routes. The browser never talks to the Support Service directly; the HttpOnly
// session cookie identifies the Super Admin on the server.

export type ApiResult<T = any> = { ok: boolean; status: number; data: T | null; error: string; code?: string };

export async function api<T = any>(url: string, init: RequestInit = {}, fetchFn: typeof fetch = fetch): Promise<ApiResult<T>> {
  try {
    const res = await fetchFn(url, {
      ...init,
      headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
      cache: "no-store",
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data, error: res.ok ? "" : typeof data?.error === "string" ? data.error : "That did not work. Please try again.", code: data?.code };
  } catch {
    return { ok: false, status: 0, data: null, error: "Unable to reach the server. Please try again." };
  }
}

export const jsonBody = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

// One key per message the Super Admin writes: pressing Reply twice, or retrying after a lost connection, records it once.
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
