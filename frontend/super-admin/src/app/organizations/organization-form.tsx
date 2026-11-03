"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import {
  FieldErrors,
  OrganizationInput,
  normalizeOrganizationInput,
  validateOrganization,
} from "@/lib/organization-validation";

const EMPTY: OrganizationInput = {
  name: "",
  primaryAdminEmail: "",
  contactEmail: "",
  countryCode: "",
  taxIdentifier: "",
};

const inputClass =
  "mt-1.5 block w-full rounded-lg border bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:ring-1 disabled:opacity-60";

export default function OrganizationForm() {
  const router = useRouter();
  const [values, setValues] = useState<OrganizationInput>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ name: string; slug: string } | null>(null);
  const [loading, setLoading] = useState(false);

  function update(field: keyof OrganizationInput, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    if (fieldErrors[field]) setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    setFormError(null);
    setSuccess(null);

    const input = normalizeOrganizationInput(values);
    const errors = validateOrganization(input);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setLoading(true);
    try {
      const res = await fetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => null);

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (!res.ok) {
        setFormError(data?.error ?? "Could not create the organization. Please try again.");
        if (data?.fieldErrors) setFieldErrors(data.fieldErrors);
        return;
      }

      setSuccess({ name: data.name, slug: data.slug });
      setValues(EMPTY);
      setFieldErrors({});
      document.getElementById("name")?.focus();
      router.refresh(); // re-fetch the organizations table from the database
    } catch {
      setFormError("Unable to reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  function field(
    id: keyof OrganizationInput,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement> & { hint?: string; optional?: boolean }
  ) {
    const { hint, optional, ...inputProps } = props;
    const error = fieldErrors[id];
    return (
      <div>
        <label htmlFor={id} className="block text-xs font-medium text-slate-400">
          {label}
          {optional && <span className="ml-1 text-slate-500">(optional)</span>}
        </label>
        <input
          id={id}
          name={id}
          value={values[id]}
          onChange={(e) => update(id, e.target.value)}
          disabled={loading}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className={`${inputClass} ${
            error
              ? "border-red-500/60 focus:border-red-500 focus:ring-red-500"
              : "border-slate-800 focus:border-indigo-500 focus:ring-indigo-500"
          }`}
          {...inputProps}
        />
        {error ? (
          <p id={`${id}-error`} className="mt-1.5 text-xs text-red-400">
            {error}
          </p>
        ) : (
          hint && (
            <p id={`${id}-hint`} className="mt-1.5 text-xs text-slate-500">
              {hint}
            </p>
          )
        )}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {success && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-400"
        >
          <span>
            Organization <strong className="font-semibold">{success.name}</strong> was created
            <span className="text-emerald-400/70"> (slug: {success.slug})</span>.
          </span>
          <button
            type="button"
            onClick={() => setSuccess(null)}
            aria-label="Dismiss"
            className="text-emerald-400/70 hover:text-emerald-300"
          >
            ✕
          </button>
        </div>
      )}
      {formError && (
        <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
          {formError}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="md:col-span-2">
          {field("name", "Organization name", {
            type: "text",
            placeholder: "Acme Imports Ltd.",
            autoComplete: "off",
          })}
        </div>
        {field("primaryAdminEmail", "Primary administrator email", {
          type: "email",
          placeholder: "admin@acme.com",
          autoComplete: "off",
          hint: "Recorded for the upcoming invitation step. No email is sent yet.",
        })}
        {field("contactEmail", "Contact email", {
          type: "email",
          placeholder: "contact@acme.com",
          autoComplete: "off",
        })}
        {field("countryCode", "Country code", {
          type: "text",
          placeholder: "US",
          maxLength: 2,
          autoComplete: "off",
          hint: "ISO 3166-1 alpha-2, e.g. US, DE, GB.",
          style: { textTransform: "uppercase" },
        })}
        {field("taxIdentifier", "Tax identifier", {
          type: "text",
          placeholder: "e.g. DE123456789",
          autoComplete: "off",
          optional: true,
        })}
      </div>

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-slate-500">A unique slug is generated automatically from the name.</p>
        <button
          type="submit"
          disabled={loading}
          className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading && (
            <span
              aria-hidden="true"
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
            />
          )}
          {loading ? "Creating…" : "Create organization"}
        </button>
      </div>
    </form>
  );
}
