import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { HistoryFilters, listClientChoices, listInvoiceHistory } from "@/lib/sales";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import InvoiceHistory from "./invoice-history";

export const metadata: Metadata = {
  title: "Sales Invoice History | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Only the client, one date and the page number are read from the URL (alone or together). There is no organization parameter: whose invoices are shown is decided on the
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

export default async function SalesInvoiceHistoryPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const [list, clients] = await Promise.all([listInvoiceHistory(token, filters), listClientChoices(token, "all")]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  return <InvoiceHistory list={list} filters={filters} clients={clients} />;
}
