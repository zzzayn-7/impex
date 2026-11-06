import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { TicketFilters, listTickets } from "@/lib/support";
import { CATEGORIES, STATUSES } from "@/lib/support-labels";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import SupportIndex from "./support-index";

export const metadata: Metadata = {
  title: "Help & Support | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Only search text, status, category, the unread switch and the page number are read from the URL. There is no organization parameter:
// whose tickets are shown is decided by the Support Service from the signed-in administrator's session.
function parseFilters(searchParams: SearchParams): TicketFilters {
  const status = first(searchParams.status) ?? "";
  const category = first(searchParams.category) ?? "";
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    status: (STATUSES as readonly string[]).includes(status) ? (status as TicketFilters["status"]) : "",
    category: (CATEGORIES as readonly string[]).includes(category) ? (category as TicketFilters["category"]) : "",
    unread: first(searchParams.unread) === "true",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function SupportPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const filters = parseFilters(searchParams ?? {});
  const list = await listTickets(getTenantToken() ?? "", filters);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  return <SupportIndex list={list} filters={filters} />;
}
