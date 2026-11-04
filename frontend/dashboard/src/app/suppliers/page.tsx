import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SupplierFilters, listSuppliers } from "@/lib/purchasing";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import SupplierManager from "./supplier-manager";

export const metadata: Metadata = {
  title: "Suppliers | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Only the search text, the status and the page number are read from the URL. There is no organization parameter: whose
// suppliers are shown is decided on the server from the signed-in administrator's session.
function parseFilters(searchParams: SearchParams): SupplierFilters {
  const status = first(searchParams.status);
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    status: status === "inactive" || status === "all" ? status : "active",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function SuppliersPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin(); // the layout already redirects invalid sessions; this keeps the page safe on its own too
  const filters = parseFilters(searchParams ?? {});
  const list = await listSuppliers(getTenantToken() ?? "", filters);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  return <SupplierManager list={list} filters={filters} />;
}
