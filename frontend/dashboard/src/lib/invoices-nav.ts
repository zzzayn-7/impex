// The Invoices module: two tabs over two existing systems. "Suppliers Invoice" lists the Goods Receipts of the Purchasing Service; "Sales Invoice" lists the
// Sales Service's client invoices. Nothing here stores anything: it is only the routes and the compatibility redirects.

export const SUPPLIER_INVOICES_HREF = "/invoices/suppliers";
export const SALES_INVOICES_HREF = "/invoices/sales";

// The only query parameters each list reads (their own filters and page number). The old addresses (/goods-receipts, /invoices) forward exactly these,
// so a bookmarked, filtered list opens the same filtered list in its new place.
export const SALES_LIST_PARAMS = ["q", "status", "payment", "client", "from", "to", "page"] as const;
export const RECEIPT_LIST_PARAMS = ["q", "status", "supplier", "from", "to", "page"] as const;

type SearchParams = Record<string, string | string[] | undefined>;

/** "?a=1&b=2" for the listed parameters that are present (first value of each), or "" when there are none. */
export function forwardQuery(searchParams: SearchParams | undefined, keys: readonly string[]): string {
  const params = new URLSearchParams();
  for (const key of keys) {
    const raw = searchParams?.[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value !== "") params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
