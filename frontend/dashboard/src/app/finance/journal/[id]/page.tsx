import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getEntry } from "@/lib/finance";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import { BackLink, Missing, Unavailable } from "../../ui";
import EntryDetailView from "./entry-detail";

export const metadata: Metadata = {
  title: "Journal Entry | Impex Organization Portal",
};

// Another organization's entry answers "not found", exactly like an id that does not exist.
export default async function EntryPage({ params }: { params: { id: string } }) {
  await requireTenantAdmin();
  const back = <BackLink href="/finance/journal">All journal entries</BackLink>;
  if (!UUID_RE.test(params.id)) return <Missing back={back} what="Journal entry" />;
  const result = await getEntry(getTenantToken() ?? "", params.id);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    if (result.reason === "not-found") return <Missing back={back} what="Journal entry" />;
    return <div className="space-y-4">{back}<Unavailable reason={result.reason} what="the journal" /></div>;
  }
  return (
    <div className="space-y-5">
      {back}
      <EntryDetailView entry={result.entry} />
    </div>
  );
}
