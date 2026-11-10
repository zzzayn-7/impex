import { PAGE_SIZE, listStock, type StockFilters } from "@/lib/inventory";
import { lineTotal } from "@/lib/product-validation";
import { sumMoney } from "@/lib/sales-browser";

// The "Total cost" of the Stock page: what ALL the products of the current filter are worth at what they cost you - the sum of (pieces on hand x cost) over every
// product, not just the rows on the visible page. Exact decimal strings throughout. Different currencies are never added together: one total per currency.
// A product with no cost recorded adds nothing (it is not valued at zero by a guess; its own row shows a dash).

const MAX_PAGES = 200; // a safety stop: 5,000 products per request is far beyond what the page is meant for

export async function stockTotals(token: string, filters: StockFilters): Promise<{ currency: string; amount: string }[]> {
  const byCurrency = new Map<string, string[]>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await listStock(token, { ...filters, page });
    if (!result.ok) return [];
    for (const item of result.items) {
      if (!item.cost_price || !item.currency_code) continue;
      const total = lineTotal(item.total_quantity, item.cost_price);
      if (total === null) continue;
      byCurrency.set(item.currency_code, [...(byCurrency.get(item.currency_code) ?? []), total]);
    }
    if (page * PAGE_SIZE >= result.total) break;
  }
  return Array.from(byCurrency.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([currency, values]) => ({ currency, amount: sumMoney(values) }));
}
