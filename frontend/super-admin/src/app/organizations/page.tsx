import type { Metadata } from "next";
import { redirect } from "next/navigation";

import PortalHeader from "@/components/portal-header";
import { getSessionToken, requireSuperAdmin } from "@/lib/auth";
import { listAdministrators, type AdministratorStatus } from "@/lib/administrators";
import { listOrganizations } from "@/lib/organizations";
import { getUnreadCount } from "@/lib/support";
import AdministratorPanel from "./administrator-panel";
import OrganizationForm from "./organization-form";
import AdministratorActions from "./administrator-actions";

export const metadata: Metadata = {
  title: "Organizations | Impex Super Admin",
};

// Deterministic (server-side) formatting avoids hydration/locale differences.
function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const STATUS_STYLES: Record<AdministratorStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-amber-500/10 text-amber-400 border border-amber-500/20" },
  active: { label: "Active", className: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" },
  expired: { label: "Expired", className: "bg-red-500/10 text-red-400 border border-red-500/20" },
};

export default async function OrganizationsPage() {
  // Redirects to /login unless the session belongs to an active super-admin
  const user = await requireSuperAdmin();
  const token = getSessionToken() ?? "";
  const [result, adminsResult, supportUnread] = await Promise.all([listOrganizations(token), listAdministrators(token), getUnreadCount(token)]);
  if ((!result.ok && result.reason === "unauthorized") || (!adminsResult.ok && adminsResult.reason === "unauthorized")) {
    redirect("/login");
  }
  // DEMO MODE (server-side setting): accounts are created at once and the sign-in details are emailed.
  const demoMode = process.env.DEMO_MODE === "true";
  const organizationOptions = result.ok
    ? result.organizations.filter((org) => org.is_active).map(({ id, name, slug }) => ({ id, name, slug }))
    : [];

  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader user={user} current="organizations" supportUnread={supportUnread ?? 0} />

      <main className="flex-1 p-8 max-w-7xl mx-auto w-full space-y-8">
        <section className="rounded-xl border border-slate-800 bg-slate-900/30 p-6 space-y-5">
          <div>
            <h2 className="text-base font-semibold text-white">Register Organization</h2>
            <p className="text-xs text-slate-400">Create a new tenant organization on the platform.</p>
          </div>
          <OrganizationForm demoMode={demoMode} />
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

        <section className="rounded-xl border border-slate-800 bg-slate-900/30 p-6 space-y-5">
          <AdministratorPanel organizations={organizationOptions} demoMode={demoMode} />

          {!adminsResult.ok ? (
            <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
              {adminsResult.reason === "forbidden"
                ? "You do not have permission to view administrators."
                : "The organization service is unavailable. Refresh in a moment."}
            </div>
          ) : adminsResult.administrators.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">
              No administrators yet. Use <span className="text-slate-300">Add Administrator</span> to invite the first one.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="bg-slate-900/80 text-xs uppercase text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Name</th>
                    <th className="px-4 py-3 font-semibold">Email</th>
                    <th className="px-4 py-3 font-semibold">Organization</th>
                    <th className="px-4 py-3 font-semibold">Role</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Invitation</th>
                    <th className="px-4 py-3 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {adminsResult.administrators.map((admin) => {
                    const style = STATUS_STYLES[admin.status] ?? STATUS_STYLES.pending;
                    return (
                      <tr key={admin.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="px-4 py-3 font-medium text-white">
                          {admin.full_name ?? <span className="text-slate-500">—</span>}
                        </td>
                        <td className="px-4 py-3 text-xs">{admin.email}</td>
                        <td className="px-4 py-3 text-xs">
                          {admin.organization_name}
                          <span className="ml-1 font-mono text-indigo-300">({admin.organization_slug})</span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-400">{admin.role}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${style.className}`}>
                            {style.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">
                          {admin.status === "active" && admin.activated_at
                            ? `Activated ${formatDate(admin.activated_at)}`
                            : admin.status === "expired"
                              ? `Expired ${formatDate(admin.expires_at)}`
                              : `Expires ${formatDate(admin.expires_at)}`}
                        </td>
                        <td className="px-4 py-3">
                          <AdministratorActions
                            demoMode={demoMode}
                            admin={{
                              id: admin.id,
                              organizationId: admin.organization_id,
                              email: admin.email,
                              fullName: admin.full_name,
                              status: admin.status,
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
