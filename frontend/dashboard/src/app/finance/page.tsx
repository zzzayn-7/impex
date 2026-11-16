import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { listAllOrderExpenses } from "@/lib/finance";
import { buildReport, parsePeriod, periodSince, REPORT_PAGE_SIZE } from "@/lib/profit-loss";
import { listDeliveredOrders } from "@/lib/sales";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import ProfitLossView from "./profit-loss-view";

export const metadata: Metadata = {
  title: "Finance | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Finance = Profit & Loss, nothing more: the orders that were DELIVERED in the chosen period, each with its profit or loss as a percentage of everything spent on it, and the portfolio of
// the period (1 day, 1 week, 1 month, 6 months or 1 year). It never works out the organization's whole finances. Only the period and the page number are read from the address; whose orders
// they are comes from the signed-in administrator's session.
export default async function FinancePage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const period = parsePeriod(first(searchParams?.period));
  const page = Math.max(1, Math.min(10000, parseInt(first(searchParams?.page) ?? "1", 10) || 1));
  const delivered = await listDeliveredOrders(token, periodSince(period, new Date()));
  if (!delivered.ok) {
    if (delivered.reason === "unauthorized") redirect("/login");
    return <ProfitLossView period={period} page={1} problem={delivered.reason === "forbidden" ? "forbidden" : "unavailable"} rows={[]} total={0} portfolios={[]} notCalculated={0} truncated={false} deliveredTotal={0} />;
  }
  const report = buildReport(delivered.items, delivered.items.length ? await listAllOrderExpenses(token) : []);
  return (
    <ProfitLossView period={period} page={page} problem={null} rows={report.rows.slice((page - 1) * REPORT_PAGE_SIZE, page * REPORT_PAGE_SIZE)} total={report.rows.length} portfolios={report.portfolios}
      notCalculated={report.notCalculated} truncated={delivered.truncated} deliveredTotal={delivered.total} />
  );
}
