import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOverview } from "@/lib/finance";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import OverviewView from "./overview-view";
import { Unavailable } from "./ui";

export const metadata: Metadata = {
  title: "Financial Overview | Impex Organization Portal",
};

// Whose books are shown is decided on the server from the signed-in administrator's session: there is no organization parameter anywhere.
export default async function FinanceOverviewPage() {
  await requireTenantAdmin();
  const result = await getOverview(getTenantToken() ?? "");
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    return <Unavailable reason={result.reason} what="the financial overview" />;
  }
  return <OverviewView overview={result.overview} />;
}
