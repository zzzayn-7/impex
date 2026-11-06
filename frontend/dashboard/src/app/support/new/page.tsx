import type { Metadata } from "next";
import Link from "next/link";

import { isModuleKey, moduleRequestDraft } from "@/lib/modules";
import { requireTenantAdmin } from "@/lib/tenant-session";
import NewTicketForm from "./new-ticket-form";

export const metadata: Metadata = {
  title: "New request | Impex Organization Portal",
};

// `?module=sales` (or `other`) from an access-denied page or the dashboard pre-fills a Change Request with FIXED wording. Nothing in the
// address is ever used as text, and sending it only opens a ticket: no module is enabled by it (only the Super Admin can do that).
export default async function NewTicketPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  await requireTenantAdmin();
  const asked = Array.isArray(searchParams?.module) ? searchParams?.module[0] : searchParams?.module;
  const draft = isModuleKey(asked) || asked === "other" ? { category: "change_request" as const, ...moduleRequestDraft(isModuleKey(asked) ? asked : null) } : undefined;
  return (
    <div className="space-y-5">
      <Link href="/support" className="text-xs text-indigo-300 hover:text-indigo-200">← All requests</Link>
      <div>
        <h2 className="text-xl font-semibold text-white">New request</h2>
        <p className="text-xs text-slate-400">Tell the Impex team what you need. They answer here, and you will receive an email when they do.</p>
      </div>
      <NewTicketForm initial={draft} />
    </div>
  );
}
