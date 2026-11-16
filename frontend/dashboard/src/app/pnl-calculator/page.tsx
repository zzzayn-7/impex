import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { listOrderExpenses } from "@/lib/finance";
import { listTradeOrders, TradeFilters } from "@/lib/sales";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import OrderList from "./order-list";

export const metadata: Metadata = {
  title: "PNL Calculator | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Only the search text and the page number are read from the URL. There is no organization parameter: whose orders are shown is decided on the server from the signed-in
// administrator's session.
function parseFilters(searchParams: SearchParams): TradeFilters {
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

// Finance > PNL Calculator: the organization's orders, newest first (every order lands here as soon as it is made), each with its result once its expenses are entered.
export default async function PnlCalculatorPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const list = await listTradeOrders(token, filters);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  const expenses = list.ok ? await listOrderExpenses(token, list.items.map((o) => o.id)) : [];
  return <OrderList list={list} filters={filters} expenses={expenses} />;
}
