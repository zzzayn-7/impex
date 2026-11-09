import { redirect } from "next/navigation";

import { SALES_INVOICES_HREF, SALES_LIST_PARAMS, SUPPLIER_INVOICES_HREF, forwardQuery } from "@/lib/invoices-nav";
import { usableModules } from "@/lib/modules";
import { loadWorkspace, requireTenantAdmin } from "@/lib/tenant-session";

// /invoices used to be the sales invoice list. It is now the Invoices module's address: it forwards to the first tab the organization may use (Sales Invoice
// when it has Sales, with the old search and filters intact; otherwise Suppliers Invoice). The destination's own layout checks the session and the module,
// so nothing is shown here that the tab would not show.
export default async function InvoicesIndexPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const admin = await requireTenantAdmin();
  const workspace = await loadWorkspace(admin);
  const modules = workspace.kind === "unavailable" || !workspace.organization ? null : usableModules(workspace.organization.modules);
  if (modules && !modules.includes("sales") && modules.includes("purchasing")) redirect(SUPPLIER_INVOICES_HREF);
  redirect(`${SALES_INVOICES_HREF}${forwardQuery(searchParams, SALES_LIST_PARAMS)}`);
}
