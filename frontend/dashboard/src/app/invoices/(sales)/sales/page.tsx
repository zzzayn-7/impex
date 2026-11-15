import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PreparedFilters, listClientChoices, listOrderInvoiceRefs, listPreparedOrders } from "@/lib/sales";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import NewInvoice from "./new-invoice";

export const metadata: Metadata = {
  title: "Sales Invoice | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Only the client, the search text and the page number are read from the URL. There is no organization parameter: whose orders are shown is decided on the server from the
// signed-in administrator's session.
function parseFilters(searchParams: SearchParams): PreparedFilters {
  const client = (first(searchParams.client) ?? "").trim();
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    clientId: UUID_RE.test(client) ? client : "",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

// Sales Invoice > New invoice: the orders that are prepared (booked, waiting to be dispatched), newest first, for one client or for all of them.
export default async function SalesInvoicePage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const [list, clients] = await Promise.all([listPreparedOrders(token, filters), listClientChoices(token, "all")]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  const refs = list.ok ? await listOrderInvoiceRefs(token, list.items.map((o) => o.id)) : [];
  return <NewInvoice list={list} filters={filters} clients={clients} refs={refs} />;
}
