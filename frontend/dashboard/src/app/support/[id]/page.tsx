import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getTicket } from "@/lib/support";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import TicketConversation from "./ticket-conversation";

export const metadata: Metadata = {
  title: "Support request | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;

// Opening a ticket marks Impex Support's replies as read. Another organization's ticket answers "not found", exactly like an id that
// does not exist.
export default async function TicketPage({ params, searchParams }: { params: { id: string }; searchParams: SearchParams }) {
  await requireTenantAdmin();
  const back = <Link href="/support" className="text-xs text-indigo-300 hover:text-indigo-200">← All requests</Link>;
  if (!UUID_RE.test(params.id)) return <Missing back={back} />;
  const result = await getTicket(getTenantToken() ?? "", params.id);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    if (result.reason === "not-found") return <Missing back={back} />;
    return (
      <div className="space-y-4">
        {back}
        <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
          {result.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so Help & Support cannot be used. Please contact your platform administrator." : "This request is temporarily unavailable. Nothing was lost; please refresh in a moment."}
        </div>
      </div>
    );
  }
  const sent = (Array.isArray(searchParams?.sent) ? searchParams.sent[0] : searchParams?.sent) === "1";
  return (
    <div className="space-y-5">
      {back}
      <TicketConversation ticket={result.ticket} justSent={sent} />
    </div>
  );
}

function Missing({ back }: { back: React.ReactNode }) {
  return (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">Request not found.</p>
    </div>
  );
}
