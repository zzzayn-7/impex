import type { Metadata } from "next";
import { redirect } from "next/navigation";

import PortalHeader from "@/components/portal-header";
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
    <div className="flex min-h-screen flex-col">
      <PortalHeader user={user} current="support" supportUnread={list.ok ? list.unread : 0} />
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 p-8">
        <SupportInbox list={list} filters={filters} />
      </main>
    </div>
  );
}
