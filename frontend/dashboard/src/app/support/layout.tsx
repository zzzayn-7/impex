import Link from "next/link";

import PortalHeader from "@/components/portal-header";
import { loadWorkspace, requireTenantAdmin } from "@/lib/tenant-session";

// Help & Support has its OWN layout instead of the shared PortalFrame, on purpose: PortalFrame sends an administrator whose first-time
// setup is unfinished to /setup, but a newly invited administrator with an onboarding problem must be able to ask for help WITHOUT
// finishing setup first. Authentication is unchanged (a signed-in, active organization administrator is required, checked here before the
// page streams) and the Support Service re-checks the caller and their organization on every request.
export default async function SupportLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireTenantAdmin();
  const workspace = await loadWorkspace(admin);
  const organization = workspace.kind === "unavailable" ? null : workspace.organization;
  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader admin={admin} current="support" organization={organization} />
      <main className="flex-1 p-4 sm:p-8 max-w-5xl mx-auto w-full space-y-5">
        {workspace.kind === "setup" && (
          <p role="note" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <span>Your organization setup is not finished yet. You can contact the Impex team from here at any time.</span>
            <Link href="/setup" className="font-medium text-amber-100 underline hover:text-white">Back to setup</Link>
          </p>
        )}
        {children}
      </main>
    </div>
  );
}
