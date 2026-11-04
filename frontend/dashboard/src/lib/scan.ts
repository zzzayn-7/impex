// Scanning: turning what a scanner, a camera or a keyboard produced into a product lookup.
//
// Everything here is plain functions so it can be tested without a browser. Two rules run through it:
//   * a scanned value is TEXT. It is never opened, fetched or navigated to, even if it looks like a link;
//   * looking a code up never changes stock. Stock changes only through the existing, confirmed, idempotent forms.

import type { Product } from "@/lib/product-validation";
import type { StockProduct } from "@/lib/stock-validation";

export type ScanSource = "scanner" | "manual" | "camera";

export type ScanResult = {
  matched_by: "identifier" | "sku";
  identifier_kind: "generated" | "manufacturer" | "supplier" | null;
  product: Product;
  stock: StockProduct;
};

export const MAX_CODE_LENGTH = 64;
// Letters, digits and . _ : / + - (what the Inventory Service accepts; no spaces).
const CODE_RE = /^[A-Z0-9][A-Z0-9._:/+-]*$/;
// Scanners can be configured to prefix an AIM symbology identifier: ]C0 (Code 128), ]E0 (EAN-13), ]Q1 (QR) ...
const AIM_PREFIX_RE = /^\][A-Za-z][0-9A-Za-z]/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const LINK_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export type Normalized =
  | { ok: true; code: string }
  | { ok: false; reason: "empty" | "too-long" | "link" | "invalid"; message: string };

const REJECT: Record<Exclude<Normalized, { ok: true }>["reason"], string> = {
  empty: "Scan a code or type a SKU or barcode.",
  "too-long": `That is longer than ${MAX_CODE_LENGTH} characters, so it cannot be a product code.`,
  link: "That code is a web link, not a product code. The link was not opened.",
  invalid: "That is not a valid product code. Codes use letters, digits and . _ : / + - only.",
};
const reject = (reason: keyof typeof REJECT): Normalized => ({ ok: false, reason, message: REJECT[reason] });

// What reaches the input from a keyboard-emulating scanner is the code plus whatever suffix the scanner is set to send
// (Enter = \r or \n, sometimes Tab). Strip that framing, keep the code, and refuse anything that cannot be one.
export function normalizeScanned(raw: string): Normalized {
  const framed = String(raw ?? "").replace(/^[\s\u0000-\u001f]+|[\s\u0000-\u001f]+$/g, "");
  const unprefixed = framed.replace(AIM_PREFIX_RE, "").trim();
  if (!unprefixed) return reject("empty");
  if (LINK_RE.test(unprefixed) || /^(javascript|data|vbscript|file):/i.test(unprefixed)) return reject("link");
  if (unprefixed.length > MAX_CODE_LENGTH) return reject("too-long");
  if (CONTROL_RE.test(unprefixed)) return reject("invalid");
  const code = unprefixed.toUpperCase();
  return CODE_RE.test(code) ? { ok: true, code } : reject("invalid");
}

// ---- asking the server ---------------------------------------------------------------------------------------------
export type LookupResult =
  | { kind: "found"; result: ScanResult }
  | { kind: "not-found" | "retired" | "ambiguous" | "invalid" | "forbidden" | "unavailable"; message: string }
  | { kind: "unauthorized"; message: string };

const MESSAGES = {
  "not-found": "No product in your catalog matches this code.",
  retired: "This barcode was retired and no longer identifies a product.",
  ambiguous: "This code matches more than one product. Fix it in the catalog, or find the product another way.",
  invalid: "That is not a valid product code.",
  forbidden: "Your organization is currently inactive or unavailable, so scanning cannot be used.",
  unavailable: "The inventory service is temporarily unavailable. Please try again.",
  unauthorized: "Your session has expired. Please sign in again.",
} as const;

// GET /api/scan/resolve?code=... on this portal (the browser never talks to the Inventory Service directly).
export async function lookupOnServer(code: string, fetchFn: typeof fetch = fetch): Promise<LookupResult> {
  try {
    const res = await fetchFn(`/api/scan/resolve?code=${encodeURIComponent(code)}`, { method: "GET", cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (res.status === 200 && data?.product && data?.stock) return { kind: "found", result: data as ScanResult };
    const kind =
      res.status === 401 ? "unauthorized" : res.status === 404 ? "not-found" : res.status === 410 ? "retired" : res.status === 409 ? "ambiguous"
      : res.status === 400 || res.status === 422 ? "invalid" : res.status === 403 ? "forbidden" : "unavailable";
    return { kind, message: (kind === "invalid" || kind === "forbidden") && typeof data?.error === "string" ? data.error : MESSAGES[kind] } as LookupResult;
  } catch {
    return { kind: "unavailable", message: MESSAGES.unavailable };
  }
}

// ---- one scan, once -----------------------------------------------------------------------------------------------------
export type ScanOutcome =
  | { kind: "ignored"; reason: "duplicate" | "busy" }
  | { kind: "rejected"; message: string; reason: Exclude<Normalized, { ok: true }>["reason"] }
  | { kind: "lookup"; code: string; result: LookupResult };

// Scanners and cameras repeat themselves: a camera sees the same code on every frame, a scanner with a sticky trigger or a
// double Enter sends it twice. The session lets one lookup run at a time and ignores the same code arriving again within
// the window. (Lookups are read-only anyway; stock changes have their own protection: confirmation + Idempotency-Key.)
export function createScanSession(options: {
  lookup: (code: string) => Promise<LookupResult>;
  now?: () => number;
  duplicateWindowMs?: number;
}) {
  const now = options.now ?? Date.now;
  const windowMs = options.duplicateWindowMs ?? 1500;
  let busy = false;
  let last: { code: string; at: number } | null = null;

  return {
    async submit(raw: string, source: ScanSource = "scanner"): Promise<ScanOutcome> {
      const normalized = normalizeScanned(raw);
      if (!normalized.ok) return { kind: "rejected", message: normalized.message, reason: normalized.reason };
      if (busy) return { kind: "ignored", reason: "busy" };
      const at = now();
      // A camera produces the same value many times a second, so it gets a longer memory than a person pressing Enter twice.
      const window = source === "camera" ? Math.max(windowMs, 4000) : windowMs;
      if (last && last.code === normalized.code && at - last.at < window) return { kind: "ignored", reason: "duplicate" };
      busy = true;
      last = { code: normalized.code, at };
      try {
        return { kind: "lookup", code: normalized.code, result: await options.lookup(normalized.code) };
      } finally {
        busy = false;
        last = { code: normalized.code, at: now() };
      }
    },
    /** Forget the last code, e.g. when the user clears the result and wants to scan the same label again. */
    reset() {
      last = null;
    },
  };
}
