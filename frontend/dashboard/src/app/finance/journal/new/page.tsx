import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOverview, listAccounts } from "@/lib/finance";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import { BackLink, Unavailable } from "../../ui";
import EntryForm from "../entry-form";

export const metadata: Metadata = {
  title: "New Journal Entry | Impex Organization Portal",
};

export default async function NewEntryPage() {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const [accounts, overview] = await Promise.all([listAccounts(token, { active: "true" }), getOverview(token)]);
  for (const result of [accounts, overview]) if (!result.ok && result.reason === "unauthorized") redirect("/login");
  return (
    <div className="space-y-5">
      <BackLink href="/finance/journal">All journal entries</BackLink>
      {!accounts.ok || !overview.ok ? (
        <Unavailable reason={!accounts.ok ? accounts.reason : "unavailable"} what="the journal" />
      ) : (
        <EntryForm accounts={accounts.accounts} defaultCurrency={overview.overview.default_currency} />
      )}
    </div>
  );
}
