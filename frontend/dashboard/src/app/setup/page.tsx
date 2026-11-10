import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { loadWorkspace, requireTenantAdmin } from "@/lib/tenant-session";
import { startingTimezone } from "@/lib/timezones";
import SetupWizard from "./setup-wizard";

export const metadata: Metadata = {
  title: "Welcome to Impex | Organization Portal",
};

export const dynamic = "force-dynamic";

// First-time setup. Takes no parameters: whose company and whose profile this is comes from the signed-in session, on the server.
//
//   * Everything already set up (company AND this administrator)  -> straight to the dashboard (no loop: the dashboard sends people
//     here only when something is still missing, using the same rule).
//   * Company not set up                                          -> the full wizard: company, you, review.
//   * Company set up, this administrator not yet                  -> only the short "about you" screen: a newly invited administrator
//     of an already configured company never repeats the company-wide setup.
//   * The Organization Service cannot answer                      -> a recoverable error; setup is never assumed complete.
export default async function SetupPage() {
  const admin = await requireTenantAdmin();
  const workspace = await loadWorkspace(admin);

  if (workspace.kind === "ready") redirect("/");

  if (workspace.kind === "unavailable") {
    return (
      <section role="alert" className="mx-auto mt-10 max-w-md rounded-[22px] border border-ix-mist/15 bg-ix-deep/70 p-8 text-center shadow-[0_6px_24px_rgba(35,55,42,0.035)]">
        <h1 className="text-lg font-semibold tracking-tight">We couldn&apos;t load your setup just now</h1>
        <p className="mt-2 text-sm text-ix-muted">Nothing was lost. Please try again in a moment. You can sign out at any time.</p>
        <a href="/setup" className="mt-5 inline-flex rounded-xl bg-ix-butter px-5 py-2.5 text-sm font-medium text-ix-on-accent transition hover:bg-ix-butter-hover">
          Try again
        </a>
      </section>
    );
  }

  const { organization, need } = workspace;
  return (
    <SetupWizard
      mode={need.mode}
      setupStatus={organization.setup_status ?? "pending"}
      initialCompanyName={organization.name}
      hasLogo={Boolean(organization.has_logo)}
      logoVersion={organization.logo_version ?? null}
      initialCurrency={organization.default_currency ?? "USD"}
      initialTimezone={startingTimezone(organization.timezone, organization.country_code)}
      initialFullName={admin.full_name}
      email={admin.email}
    />
  );
}
