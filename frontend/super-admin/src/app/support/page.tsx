import type { Metadata } from "next";
import { redirect } from "next/navigation";

import PortalShell from "@/components/portal-shell";
import { getSessionToken, requireSuperAdmin } from "@/lib/auth";
import { listInbox } from "@/lib/support";
import { parseFilters } from "@/lib/support-filters";
import SupportInbox from "./support-inbox";

export const metadata: Metadata = {
  title: "Support Inbox | Impex Super Admin",
};
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function SupportInboxPage({ searchParams }: { searchParams: SearchParams }) {
  // Redirects to /login unless the session belongs to an active Super Admin
  const user = await requireSuperAdmin();
  const filters = parseFilters(searchParams ?? {});
  const list = await listInbox(getSessionToken() ?? "", filters);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");

  return (
    <PortalShell user={user} current="support" supportUnread={list.ok ? list.unread : 0}>
      <SupportInbox list={list} filters={filters} />
    </PortalShell>
  );
}
