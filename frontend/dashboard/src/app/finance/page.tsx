import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getFinanceHistory, getFinanceSummary, listAccounts } from "@/lib/finance";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import FinanceView from "./finance-view";
import { Unavailable } from "./ui";

export const metadata: Metadata = {
  title: "Finance | Impex Organization Portal",
};

// Capital, Investment and Profit & Loss. Whose books are shown is decided on the server from the signed-in administrator's session: there is no organization
// parameter anywhere. The page opens on the last month; the period, the filters and the paging are then fetched by the browser from the portal's own routes.
export default async function FinancePage() {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const [summary, history, accounts] = await Promise.all([getFinanceSummary(token, "1m"), getFinanceHistory(token, "1m"), listAccounts(token, { type: "expense", active: "true" })]);
  if (!summary.ok || !history.ok) {
    if ((!summary.ok && summary.reason === "unauthorized") || (!history.ok && history.reason === "unauthorized")) redirect("/login");
    const reason = !summary.ok ? summary.reason : !history.ok ? history.reason : "unavailable";
    return <Unavailable reason={reason} what="finance" />;
  }
  return <FinanceView initialSummary={summary.summary} initialHistory={history.history} expenseCategories={accounts.ok ? accounts.accounts : []} />;
}
