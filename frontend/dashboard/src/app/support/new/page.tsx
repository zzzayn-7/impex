import type { Metadata } from "next";
import Link from "next/link";

import { requireTenantAdmin } from "@/lib/tenant-session";
import NewTicketForm from "./new-ticket-form";

export const metadata: Metadata = {
  title: "New request | Impex Organization Portal",
};

export default async function NewTicketPage() {
  await requireTenantAdmin();
  return (
    <div className="space-y-5">
      <Link href="/support" className="text-xs text-indigo-300 hover:text-indigo-200">← All requests</Link>
      <div>
        <h2 className="text-xl font-semibold text-white">New request</h2>
        <p className="text-xs text-slate-400">Tell the Impex team what you need. They answer here, and you will receive an email when they do.</p>
      </div>
      <NewTicketForm />
    </div>
  );
}
