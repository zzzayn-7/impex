"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { EMAIL_RE } from "@/lib/organization-validation";

type OrganizationOption = { id: string; name: string; slug: string };
type Errors = { organizationId?: string; fullName?: string; email?: string };

const inputClass =
  "mt-1.5 block w-full rounded-lg border bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:ring-1 disabled:opacity-60";
const fieldClass = (error?: string) =>
  `${inputClass} ${error ? "border-red-500/60 focus:border-red-500 focus:ring-red-500" : "border-slate-800 focus:border-indigo-500 focus:ring-indigo-500"}`;

// The "Administrators" section header with the "Add Administrator" button and its form.
export default function AdministratorPanel({
  organizations,
  demoMode = false,
}: {
  organizations: OrganizationOption[];
  demoMode?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [organizationId, setOrganizationId] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    setFormError(null);
    setSuccess(null);

    const name = fullName.trim().replace(/\s+/g, " ");
    const address = email.trim().toLowerCase();
    const found: Errors = {};
    if (!organizationId) found.organizationId = "Select an organization.";
    if (name.length < 2) found.fullName = "Enter the administrator's full name (at least 2 characters).";
    if (!EMAIL_RE.test(address)) found.email = "Enter a valid email address.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setLoading(true);
    try {
      const res = await fetch("/api/administrators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, fullName: name, email: address }),
      });
      const data = await res.json().catch(() => null);

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (!res.ok) {
        setFormError(data?.error ?? "Could not send the invitation. Please try again.");
        if (data?.fieldErrors) setErrors(data.fieldErrors);
        return;
      }

      const sent = data.administrator;
      setSuccess(
        sent.status === "active"
          ? `Account created for ${sent.email} (${sent.organization_name}). Sign-in details were emailed to them.`
          : `Invitation emailed to ${sent.email} to administer ${sent.organization_name}.`
      );
      setFullName("");
      setEmail("");
      setErrors({});
      router.refresh(); // reload the administrators table
    } catch {
      setFormError("Unable to reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white">Administrators</h2>
          <p className="text-xs text-slate-400">
            {demoMode
              ? "Add, edit or remove the people who administer an organization. Demo mode: accounts are created immediately."
              : "Invite people to administer an organization. They activate their account from the emailed link."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="add-administrator-form"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950"
        >
          {open ? "Close" : "Add Administrator"}
        </button>
      </div>

      {success && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-400"
        >
          <span>{success}</span>
          <button type="button" onClick={() => setSuccess(null)} aria-label="Dismiss" className="text-emerald-400/70 hover:text-emerald-300">
            ✕
          </button>
        </div>
      )}

      {open && (
        <form
          id="add-administrator-form"
          onSubmit={onSubmit}
          noValidate
          className="space-y-5 rounded-lg border border-slate-800 bg-slate-950/40 p-5"
        >
          {demoMode && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-300">
              <strong className="font-semibold">Demo mode.</strong> The account is created right away with the demo password, and the
              email contains the administrator&apos;s email, that password and the sign-in address. Turn off <code>DEMO_MODE</code> for
              the secure invitation flow.
            </div>
          )}
          {formError && (
            <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
              {formError}
            </div>
          )}

          {organizations.length === 0 ? (
            <p className="text-sm text-slate-400">Register an organization first, then add its administrators here.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label htmlFor="adminOrganization" className="block text-xs font-medium text-slate-400">Organization</label>
                  <select
                    id="adminOrganization"
                    value={organizationId}
                    disabled={loading}
                    onChange={(e) => { setOrganizationId(e.target.value); setErrors((p) => ({ ...p, organizationId: undefined })); }}
                    aria-invalid={errors.organizationId ? true : undefined}
                    aria-describedby={errors.organizationId ? "adminOrganization-error" : undefined}
                    className={fieldClass(errors.organizationId)}
                  >
                    <option value="">Select an organization…</option>
                    {organizations.map((org) => (
                      <option key={org.id} value={org.id}>{org.name} ({org.slug})</option>
                    ))}
                  </select>
                  {errors.organizationId && <p id="adminOrganization-error" className="mt-1.5 text-xs text-red-400">{errors.organizationId}</p>}
                </div>

                <div>
                  <label htmlFor="adminFullName" className="block text-xs font-medium text-slate-400">Administrator full name</label>
                  <input
                    id="adminFullName" type="text" autoComplete="off" disabled={loading} value={fullName} placeholder="Ada Lovelace"
                    onChange={(e) => { setFullName(e.target.value); setErrors((p) => ({ ...p, fullName: undefined })); }}
                    aria-invalid={errors.fullName ? true : undefined} aria-describedby={errors.fullName ? "adminFullName-error" : undefined}
                    className={fieldClass(errors.fullName)}
                  />
                  {errors.fullName && <p id="adminFullName-error" className="mt-1.5 text-xs text-red-400">{errors.fullName}</p>}
                </div>

                <div>
                  <label htmlFor="adminEmail" className="block text-xs font-medium text-slate-400">Administrator email</label>
                  <input
                    id="adminEmail" type="email" autoComplete="off" disabled={loading} value={email} placeholder="ada@company.com"
                    onChange={(e) => { setEmail(e.target.value); setErrors((p) => ({ ...p, email: undefined })); }}
                    aria-invalid={errors.email ? true : undefined} aria-describedby={errors.email ? "adminEmail-error" : undefined}
                    className={fieldClass(errors.email)}
                  />
                  {errors.email && <p id="adminEmail-error" className="mt-1.5 text-xs text-red-400">{errors.email}</p>}
                </div>

                <div>
                  <label htmlFor="adminRole" className="block text-xs font-medium text-slate-400">Role</label>
                  <input id="adminRole" readOnly disabled value="organization-admin" className={`${inputClass} border-slate-800 text-slate-400`} />
                  <p className="mt-1.5 text-xs text-slate-500">Fixed. Administrators can only manage their own organization.</p>
                </div>
              </div>

              <div className="flex items-center justify-between gap-4">
                <p className="text-xs text-slate-500">
                  {demoMode
                    ? "An email with the sign-in details is sent now."
                    : "An email with a one-time activation link (valid 24 hours) and the organization sign-in address is sent now. No password is ever emailed."}
                </p>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex shrink-0 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading && <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-ix-deep/25 border-t-ix-deep motion-reduce:animate-none" />}
                  {loading ? "Sending…" : demoMode ? "Create & email credentials" : "Send invitation"}
                </button>
              </div>
            </>
          )}
        </form>
      )}
    </div>
  );
}
