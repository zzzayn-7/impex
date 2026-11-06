import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import PortalHeader from "@/components/portal-header";
import { getSessionToken, requireSuperAdmin } from "@/lib/auth";
import { listOrganizations } from "@/lib/organizations";
import { getTicket, UUID_RE } from "@/lib/support";
import TicketPanel, { type OrganizationInfo } from "./ticket-panel";

export const metadata: Metadata = {
  title: "Support ticket | Impex Super Admin",
};
export const dynamic = "force-dynamic";

export default async function TicketPage({ params }: { params: { id: string } }) {
  // Redirects to /login unless the session belongs to an active Super Admin
  const user = await requireSuperAdmin();
  const token = getSessionToken() ?? "";
  const back = <Link href="/support" className="text-xs text-indigo-300 hover:text-indigo-200">← Support Inbox</Link>;
  const frame = (content: React.ReactNode, unread = 0) => (
    <div className="flex min-h-screen flex-col">
      <PortalHeader user={user} current="support" supportUnread={unread} />
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-5 p-8">{back}{content}</main>
    </div>
  );

  if (!UUID_RE.test(params.id)) return frame(<Notice>Ticket not found.</Notice>);
  // Opening the ticket marks the customer's messages as read.
  const result = await getTicket(token, params.id);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    if (result.reason === "not-found") return frame(<Notice>Ticket not found.</Notice>);
    return frame(<Notice>{result.reason === "forbidden" ? "Only a Super Admin can use the Support Inbox." : "This ticket is temporarily unavailable. Nothing was lost; please refresh in a moment."}</Notice>);
  }

  // Who the organization is, for the Super Admin: best effort (the ticket itself carries the name and the requester snapshot).
  let organization: OrganizationInfo | null = null;
  const orgs = await listOrganizations(token);
  if (orgs.ok && result.ticket.organization_id) {
    const found = orgs.organizations.find((o) => o.id === result.ticket.organization_id);
    if (found) organization = { id: found.id, name: found.name, slug: found.slug, isActive: found.is_active, contactEmail: found.contact_email, country: found.country_code };
  }

  return frame(<TicketPanel initial={result.ticket} organization={organization} />);
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">{children}</p>;
}
