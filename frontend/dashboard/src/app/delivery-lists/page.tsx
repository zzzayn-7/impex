import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ListFilters, listClientChoices, listDeliveryLists } from "@/lib/sales";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import DeliveryListIndex from "./delivery-list-index";

export const metadata: Metadata = {
  title: "Delivery Lists | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Only the search text, the client id, the status and the page number are read from the URL. There is no organization
// parameter: whose lists are shown is decided on the server from the signed-in administrator's session, and a client id
// from another organization simply matches nothing.
function parseFilters(searchParams: SearchParams): ListFilters {
  const status = first(searchParams.status);
  const client = (first(searchParams.client) ?? "").trim();
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    clientId: UUID_RE.test(client) ? client : "",
    status: status === "draft" || status === "ready" || status === "cancelled" ? status : "",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function DeliveryListsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin(); // the layout already redirects invalid sessions; this keeps the page safe on its own too
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const [list, clients] = await Promise.all([listDeliveryLists(token, filters), listClientChoices(token, "all")]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  return <DeliveryListIndex list={list} filters={filters} clients={clients} />;
}
