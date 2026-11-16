import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { HistoryFilters, listClientChoices, listPendingPayments } from "@/lib/sales";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import InvoiceHistory from "../history/invoice-history";

export const metadata: Metadata = {
  title: "Pending Payments | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Only the client, one date and the page number are read from the URL (alone or together). There is no organization parameter: whose installments are shown is decided on the
// server from the signed-in administrator's session.
function parseFilters(searchParams: SearchParams): HistoryFilters {
  const client = (first(searchParams.client) ?? "").trim();
  const date = (first(searchParams.date) ?? "").trim();
  return {
    clientId: UUID_RE.test(client) ? client : "",
    day: DATE_RE.test(date) ? date : "",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

// Sales Invoice > Pending payments: the installments of the orders paid in parts, whose date has not come yet, the nearest first. Each one is an invoice already (it can be opened,
// printed or downloaded); on its date it moves to History by itself.
export default async function PendingPaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const [list, clients] = await Promise.all([listPendingPayments(token, filters), listClientChoices(token, "all")]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  return <InvoiceHistory list={list} filters={filters} clients={clients} view="pending" />;
}
