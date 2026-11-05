import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { InvoiceFilters, listClientChoices, listInvoices } from "@/lib/sales";
import { INVOICE_STATUSES, PAYMENT_FILTERS } from "@/lib/sales-routes";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import InvoiceIndex from "./invoice-index";

export const metadata: Metadata = {
  title: "Invoices | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Only search text, status, payment status, client, two dates and the page number are read from the URL. There is no organization
// parameter: whose invoices are shown is decided on the server from the signed-in administrator's session.
function parseFilters(searchParams: SearchParams): InvoiceFilters {
  const status = first(searchParams.status) ?? "";
  const payment = first(searchParams.payment) ?? "";
  const client = (first(searchParams.client) ?? "").trim();
  const from = (first(searchParams.from) ?? "").trim();
  const to = (first(searchParams.to) ?? "").trim();
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    status: (INVOICE_STATUSES as readonly string[]).includes(status) ? (status as InvoiceFilters["status"]) : "",
    paymentStatus: (PAYMENT_FILTERS as readonly string[]).includes(payment) ? (payment as InvoiceFilters["paymentStatus"]) : "",
    clientId: UUID_RE.test(client) ? client : "",
    dateFrom: DATE_RE.test(from) ? from : "",
    dateTo: DATE_RE.test(to) ? to : "",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function InvoicesPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const [list, clients] = await Promise.all([listInvoices(token, filters), listClientChoices(token, "all")]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  return <InvoiceIndex list={list} filters={filters} clients={clients} />;
}
