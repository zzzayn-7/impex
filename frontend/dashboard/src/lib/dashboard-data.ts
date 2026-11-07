import { financeRequest, type Overview } from "@/lib/finance";
import { inventoryRequest } from "@/lib/inventory";
import { purchasingRequest, type PurchaseOrderSummary } from "@/lib/purchasing";
import { salesRequest, type InvoiceSummary } from "@/lib/sales";
import type { Movement, Warehouse } from "@/lib/stock-validation";
import { lastDays, lastMonths, startOfMonths, totalsByCurrency, type Money } from "@/lib/dashboard-metrics";
import { formatDate, type Preferences } from "@/lib/format";
import { usableModules, type ModuleKey } from "@/lib/modules";

// What the Organization Dashboard shows, read from the services' EXISTING read APIs with the administrator's own session token (nothing is
// written, nothing is sent to name an organization: each service derives it from the token). A module that is not enabled is not asked at all, so
// its numbers can never appear. A service that cannot answer is reported as "unavailable" for ITS widgets only; the rest of the page still renders.
//
// The list APIs return at most 200 rows per call, so a few calls are made where a window needs more; `truncated` says honestly when even that
// was not enough, and the widget then states that it shows the latest records.

export const TREND_MONTHS = 6;
export const ACTIVITY_DAYS = 14;
const PAGE = 200;
const MAX_PAGES = 3;

export type Section<T> = { status: "ok"; data: T } | { status: "unavailable" };

export type InventoryData = {
  products: number; // active products
  warehouses: { id: string; code: string; name: string; products: number }[]; // active warehouses and how many different products each holds
  movements: Movement[]; // the latest (newest first)
  movementsTruncated: boolean;
};

export type PurchasingData = {
  open: { count: number; byCurrency: Money[]; truncated: boolean }; // ordered + partially received
  recentOpen: PurchaseOrderSummary[];
  trend: { rows: { date: string; currency: string; amount: string }[]; truncated: boolean }; // purchase orders actually placed in the window
};

export type SalesData = {
  trend: { rows: { date: string; currency: string; amount: string }[]; truncated: boolean }; // invoices issued in the window (not drafts or voids)
  receivables: { count: number; outstanding: Money[]; overdue: Money[]; paid: Money[]; invoiced: Money[]; truncated: boolean }; // issued + partially paid
  recent: InvoiceSummary[]; // latest invoices (any state but void)
};

export type DashboardData = {
  today: string;
  months: string[];
  days: string[];
  inventory?: Section<InventoryData>;
  purchasing?: Section<PurchasingData>;
  sales?: Section<SalesData>;
  finance?: Section<Overview>;
};

type Result = { status: number; data: any } | null;
type Fetcher = (path: string) => Promise<Result>;

/** Every row of a list endpoint, up to MAX_PAGES x 200. `total` is what exists; `rows` is what was read. */
async function readRows<T>(get: Fetcher, path: string): Promise<{ rows: T[]; total: number } | null> {
  const rows: T[] = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const result = await get(`${path}${separator}limit=${PAGE}&offset=${page * PAGE}`);
    if (!result || result.status !== 200 || !result.data || !Array.isArray(result.data.items)) return null;
    rows.push(...(result.data.items as T[]));
    total = Number(result.data.total) || rows.length;
    if (rows.length >= total || result.data.items.length === 0) break;
  }
  return { rows, total };
}

async function loadInventory(token: string): Promise<Section<InventoryData>> {
  const get: Fetcher = (path) => inventoryRequest("GET", path, token);
  const [stock, warehouses, movements] = await Promise.all([
    get("/api/v1/inventory/stock?status=active&limit=1"),
    readRows<Warehouse>(get, "/api/v1/inventory/warehouses?status=active"),
    get(`/api/v1/inventory/stock/movements?limit=${PAGE}`),
  ]);
  if (!stock || stock.status !== 200 || !warehouses || !movements || movements.status !== 200 || !Array.isArray(movements.data?.items)) return { status: "unavailable" };
  return {
    status: "ok",
    data: {
      products: Number(stock.data?.total) || 0,
      warehouses: warehouses.rows.map((w) => ({ id: w.id, code: w.code, name: w.name, products: Number(w.products_in_stock) || 0 })),
      movements: movements.data.items as Movement[],
      movementsTruncated: Number(movements.data.total) > movements.data.items.length,
    },
  };
}

async function loadPurchasing(token: string, since: string): Promise<Section<PurchasingData>> {
  const get: Fetcher = (path) => purchasingRequest("GET", path, token);
  const [ordered, partial, window] = await Promise.all([
    readRows<PurchaseOrderSummary>(get, "/api/v1/purchasing/purchase-orders?status=ordered"),
    readRows<PurchaseOrderSummary>(get, "/api/v1/purchasing/purchase-orders?status=partially_received"),
    readRows<PurchaseOrderSummary>(get, `/api/v1/purchasing/purchase-orders?date_from=${since}`),
  ]);
  if (!ordered || !partial || !window) return { status: "unavailable" };
  const open = [...ordered.rows, ...partial.rows];
  return {
    status: "ok",
    data: {
      open: {
        count: ordered.total + partial.total,
        byCurrency: totalsByCurrency(open.map((o) => ({ currency: o.currency_code, amount: o.total_amount }))),
        truncated: ordered.total > ordered.rows.length || partial.total > partial.rows.length,
      },
      recentOpen: [...open].sort((a, b) => (a.order_date < b.order_date ? 1 : a.order_date > b.order_date ? -1 : b.created_at.localeCompare(a.created_at))).slice(0, 5),
      trend: {
        rows: window.rows.filter((o) => o.status !== "draft" && o.status !== "cancelled").map((o) => ({ date: o.order_date, currency: o.currency_code, amount: o.total_amount })),
        truncated: window.total > window.rows.length,
      },
    },
  };
}

async function loadSales(token: string, since: string): Promise<Section<SalesData>> {
  const get: Fetcher = (path) => salesRequest("GET", path, token);
  const [window, issued, partial] = await Promise.all([
    readRows<InvoiceSummary>(get, `/api/v1/sales/invoices?date_from=${since}`),
    readRows<InvoiceSummary>(get, "/api/v1/sales/invoices?status=issued"),
    readRows<InvoiceSummary>(get, "/api/v1/sales/invoices?status=partially_paid"),
  ]);
  if (!window || !issued || !partial) return { status: "unavailable" };
  const open = [...issued.rows, ...partial.rows];
  const live = window.rows.filter((i) => i.status === "issued" || i.status === "partially_paid" || i.status === "paid");
  return {
    status: "ok",
    data: {
      trend: { rows: live.map((i) => ({ date: i.invoice_date, currency: i.currency_code, amount: i.total })), truncated: window.total > window.rows.length },
      receivables: {
        count: issued.total + partial.total,
        outstanding: totalsByCurrency(open.map((i) => ({ currency: i.currency_code, amount: i.outstanding }))),
        overdue: totalsByCurrency(open.filter((i) => i.overdue).map((i) => ({ currency: i.currency_code, amount: i.outstanding }))),
        paid: totalsByCurrency(open.map((i) => ({ currency: i.currency_code, amount: i.paid_total }))),
        invoiced: totalsByCurrency(open.map((i) => ({ currency: i.currency_code, amount: i.total }))),
        truncated: issued.total > issued.rows.length || partial.total > partial.rows.length,
      },
      recent: window.rows.filter((i) => i.status !== "void").slice(0, 5),
    },
  };
}

async function loadFinance(token: string): Promise<Section<Overview>> {
  const result = await financeRequest("GET", "/api/v1/finance/overview", token);
  return result && result.status === 200 && result.data ? { status: "ok", data: result.data as Overview } : { status: "unavailable" };
}

/** The dashboard's data for the modules this organization can use. `modules` is the Organization Service's list (an unknown list means none). */
export async function loadDashboardData(token: string, modules: unknown, prefs: Preferences, now: Date = new Date()): Promise<DashboardData> {
  const enabled = new Set<ModuleKey>(usableModules(modules));
  const today = formatDate(now, { ...prefs, date_format: "YYYY-MM-DD" });
  const months = lastMonths(today, TREND_MONTHS);
  const days = lastDays(today, ACTIVITY_DAYS);
  const since = startOfMonths(months);
  const [inventory, purchasing, sales, finance] = await Promise.all([
    enabled.has("inventory") ? loadInventory(token) : undefined,
    enabled.has("purchasing") ? loadPurchasing(token, since) : undefined,
    enabled.has("sales") ? loadSales(token, since) : undefined,
    enabled.has("finance") ? loadFinance(token) : undefined,
  ]);
  return { today, months, days, ...(inventory ? { inventory } : {}), ...(purchasing ? { purchasing } : {}), ...(sales ? { sales } : {}), ...(finance ? { finance } : {}) };
}
