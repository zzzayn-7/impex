import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DispatchFilters, listClientChoices, listDeliveryLists, listDispatches } from "@/lib/sales";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import DispatchIndex from "./dispatch-index";

export const metadata: Metadata = {
  title: "Dispatches | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Only search text, status, client, delivery list, two dates and the page number are read from the URL. There is no organization
// parameter: whose dispatches are shown is decided on the server from the signed-in administrator's session.
function parseFilters(searchParams: SearchParams): DispatchFilters {
  const status = first(searchParams.status);
  const client = (first(searchParams.client) ?? "").trim();
  const list = (first(searchParams.list) ?? "").trim();
  const from = (first(searchParams.from) ?? "").trim();
  const to = (first(searchParams.to) ?? "").trim();
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    status: status === "draft" || status === "posting" || status === "confirmed" || status === "cancelled" ? status : "",
    clientId: UUID_RE.test(client) ? client : "",
    listId: UUID_RE.test(list) ? list : "",
    dateFrom: DATE_RE.test(from) ? from : "",
    dateTo: DATE_RE.test(to) ? to : "",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function DispatchesPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const [list, clients, ready, partial] = await Promise.all([
    listDispatches(token, filters),
    listClientChoices(token, "all"),
    listDeliveryLists(token, { q: "", clientId: "", status: "ready", page: 1 }),
    listDeliveryLists(token, { q: "", clientId: "", status: "partially_dispatched", page: 1 }),
  ]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  const dispatchable = [...(ready.ok ? ready.items : []), ...(partial.ok ? partial.items : [])];
  return <DispatchIndex list={list} filters={filters} clients={clients} dispatchable={dispatchable} />;
}
