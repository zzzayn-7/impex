import type { Metadata } from "next";
import { redirect } from "next/navigation";

import PortalHeader from "@/components/portal-header";
import { getSessionToken, requireSuperAdmin } from "@/lib/auth";
import { listOrganizations } from "@/lib/organizations";
import OrganizationForm from "./organization-form";

export const metadata: Metadata = {
  title: "Organizations | Impex Super Admin",
};

// Deterministic (server-side) formatting avoids hydration/locale differences.
function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export default async function OrganizationsPage() {
  // Redirects to /login unless the session belongs to an active super-admin
  const user = await requireSuperAdmin();
  const result = await listOrganizations(getSessionToken() ?? "");
  if (!result.ok && result.reason === "unauthorized") redirect("/login");

  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader user={user} current="organizations" />

      <main className="flex-1 p-8 max-w-7xl mx-auto w-full space-y-8">
        <section className="rounded-xl border border-slate-800 bg-slate-900/30 p-6 space-y-5">
          <div>
            <h2 className="text-base font-semibold text-white">Register Organization</h2>
            <p className="text-xs text-slate-400">Create a new tenant organization on the platform.</p>
          </div>
          <OrganizationForm />
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/30 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-white">Organizations</h2>
              <p className="text-xs text-slate-400">Stored in PostgreSQL by the Organization Service</p>
            </div>
            {result.ok && (
              <span className="text-xs text-slate-400">
                {result.organizations.length} {result.organizations.length === 1 ? "organization" : "organizations"}
              </span>
            )}
          </div>

          {!result.ok ? (
            <div
              role="alert"
              className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400"
            >
              {result.reason === "forbidden"
                ? "You do not have permission to view organizations."
                : "The organization service is unavailable. Refresh in a moment."}
            </div>
          ) : result.organizations.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">
              No organizations yet. Create the first one above.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="bg-slate-900/80 text-xs uppercase text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Name</th>
                    <th className="px-4 py-3 font-semibold">Slug</th>
                    <th className="px-4 py-3 font-semibold">Country</th>
                    <th className="px-4 py-3 font-semibold">Primary Admin</th>
                    <th className="px-4 py-3 font-semibold">Contact</th>
                    <th className="px-4 py-3 font-semibold">Tax ID</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {result.organizations.map((org) => (
                    <tr key={org.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-3 font-medium text-white">{org.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-indigo-300">{org.slug}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-400">{org.country_code}</td>
                      <td className="px-4 py-3 text-xs">
                        {org.primary_admin_email ?? <span className="text-slate-500">—</span>}
                      </td>
                      <td className="px-4 py-3 text-xs">{org.contact_email}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-400">
                        {org.tax_identifier ?? <span className="text-slate-500">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            org.is_active
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                              : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                          }`}
                        >
                          {org.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">{formatDate(org.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
