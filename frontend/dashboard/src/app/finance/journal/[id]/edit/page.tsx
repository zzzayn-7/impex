import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getEntry, getOverview, listAccounts } from "@/lib/finance";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import { BackLink, Missing, Unavailable } from "../../../ui";
import EntryForm from "../../entry-form";

export const metadata: Metadata = {
  title: "Edit Journal Entry | Impex Organization Portal",
};

// Only a DRAFT can be edited. A posted entry is shown read-only: it is corrected by reversing it.
export default async function EditEntryPage({ params }: { params: { id: string } }) {
  await requireTenantAdmin();
  const back = <BackLink href={`/finance/journal/${params.id}`}>Back to the entry</BackLink>;
  if (!UUID_RE.test(params.id)) return <Missing back={back} what="Journal entry" />;
  const token = getTenantToken() ?? "";
  const [entry, accounts, overview] = await Promise.all([getEntry(token, params.id), listAccounts(token), getOverview(token)]);
  for (const result of [entry, accounts, overview]) if (!result.ok && result.reason === "unauthorized") redirect("/login");
  if (!entry.ok) return entry.reason === "not-found" ? <Missing back={back} what="Journal entry" /> : <div className="space-y-4">{back}<Unavailable reason={entry.reason} what="the journal" /></div>;
  if (entry.entry.status !== "draft") {
    return (
      <div className="space-y-4">
        {back}
        <p role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
          A posted journal entry can never be edited. To correct it, reverse it from its page and post a new entry.
        </p>
      </div>
    );
  }
  if (!accounts.ok || !overview.ok) return <div className="space-y-4">{back}<Unavailable reason="unavailable" what="the journal" /></div>;
  return (
    <div className="space-y-5">
      {back}
      <EntryForm accounts={accounts.accounts} defaultCurrency={overview.overview.default_currency} entry={entry.entry} />
    </div>
  );
}
