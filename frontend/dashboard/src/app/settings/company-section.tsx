"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { api, jsonBody } from "@/lib/sales-browser";
import type { CompanyData, SettingsData } from "@/lib/settings";
import { changeRequestHref, type ChangeKey } from "@/lib/settings-requests";
import { COMPANY_FIELDS, checkCompany, companyChanges, type CompanyValues, type FieldErrors } from "@/lib/settings-validation";
import { Card, Field, linkClass, Notice, ReadOnly, SaveBar, inputClass } from "./settings-ui";

export type SectionProps = {
  settings: SettingsData;
  onSaved: (settings: SettingsData, message: string) => void;
  onConflict: (current: SettingsData, message: string) => void;
  setDirty: (key: string, dirty: boolean) => void;
  syncKey: number; // changes when the saved values were replaced by newer ones (a conflict): the form starts again from them
};

const toValues = (c: CompanyData): CompanyValues => ({
  name: c.name, contact_email: c.contact_email, contact_phone: c.contact_phone ?? "", address_street: c.address_street ?? "", address_city: c.address_city ?? "",
  address_state: c.address_state ?? "", address_postal_code: c.address_postal_code ?? "", website: c.website ?? "", description: c.description ?? "",
});

const RESTRICTED: { label: string; value: (s: SettingsData) => string; mono?: boolean; request?: ChangeKey }[] = [
  { label: "Organization ID", value: (s) => s.restricted.id, mono: true },
  { label: "Organization identifier (slug)", value: (s) => s.restricted.slug, mono: true, request: "slug" },
  { label: "Registered country", value: (s) => s.restricted.country_code, request: "country" },
  { label: "Tax registration number", value: (s) => s.restricted.tax_identifier ?? "", request: "tax_id" },
  { label: "Organization owner", value: (s) => s.restricted.owner_email ?? "", request: "ownership" },
  { label: "Organization status", value: (s) => s.restricted.status, request: "status" },
];

export default function CompanySection({ settings, onSaved, onConflict, setDirty, syncKey }: SectionProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<CompanyValues>(() => toValues(settings.company));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const saved = toValues(settings.company);
  const dirty = COMPANY_FIELDS.some((f) => draft[f] !== saved[f]);
  const checked = checkCompany(draft);
  const live: FieldErrors = checked.ok ? {} : checked.errors;

  useEffect(() => { setDirty("company", dirty); }, [dirty, setDirty]);
  // newer values arrived (after a conflict, or another section's save): an untouched form simply follows them; after a conflict it restarts
  useEffect(() => { setDraft(toValues(settings.company)); setErrors({}); setTouched({}); setError(null); }, [syncKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (field: keyof CompanyValues) => (e: { target: { value: string } }) => { setDraft((d) => ({ ...d, [field]: e.target.value })); setErrors((x) => ({ ...x, [field]: undefined })); setError(null); };
  const shown = (field: string) => errors[field] ?? (touched[field] ? live[field] : undefined);
  const aria = (field: string) => ({ "aria-invalid": Boolean(shown(field)), "aria-describedby": shown(field) ? `company-${field}-error` : undefined, onBlur: () => setTouched((t) => ({ ...t, [field]: true })) });

  async function save() {
    if (busyRef.current) return; // a double click sends once
    setError(null);
    if (!checked.ok) {
      setTouched(Object.fromEntries(COMPANY_FIELDS.map((f) => [f, true])));
      return setErrors(checked.errors);
    }
    const changes = companyChanges(saved, checked.value);
    if (Object.keys(changes).length === 0) return;
    busyRef.current = true;
    setBusy(true);
    const r = await api("/api/settings/company", { method: "PATCH", ...jsonBody({ expected_version: settings.version, ...changes }) });
    busyRef.current = false;
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      if (r.status === 409 && r.code === "version_conflict" && r.data?.current) return onConflict(r.data.current, r.error);
      const fieldErrors = (r.data?.fieldErrors ?? {}) as FieldErrors;
      if (Object.keys(fieldErrors).length > 0) { setErrors(fieldErrors); setTouched(Object.fromEntries(Object.keys(fieldErrors).map((f) => [f, true]))); }
      return setError(r.error);
    }
    const nameChanged = "name" in changes;
    setDraft(toValues(r.data.settings.company)); // the normalized values the service stored
    onSaved(r.data.settings, "Company profile saved.");
    if (nameChanged) router.refresh(); // the header shows the new name on the next render, without a full page load
  }

  return (
    <Card id="company" title="Company profile" description="How your company is named and reached. The display name appears in the portal header and on the documents you issue from now on.">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="company-name" label="Company display name" error={shown("name")} className="sm:col-span-2">
          <input id="company-name" value={draft.name} onChange={set("name")} maxLength={120} autoComplete="organization" className={inputClass} {...aria("name")} />
        </Field>
        <Field id="company-contact_email" label="Business contact email" error={shown("contact_email")}>
          <input id="company-contact_email" type="email" value={draft.contact_email} onChange={set("contact_email")} maxLength={320} autoComplete="email" className={inputClass} {...aria("contact_email")} />
        </Field>
        <Field id="company-contact_phone" label="Phone number" error={shown("contact_phone")} hint="Optional">
          <input id="company-contact_phone" type="tel" value={draft.contact_phone} onChange={set("contact_phone")} maxLength={40} autoComplete="tel" className={inputClass} {...aria("contact_phone")} />
        </Field>
        <Field id="company-address_street" label="Street address" error={shown("address_street")} hint="Optional" className="sm:col-span-2">
          <input id="company-address_street" value={draft.address_street} onChange={set("address_street")} maxLength={255} autoComplete="street-address" className={inputClass} {...aria("address_street")} />
        </Field>
        <Field id="company-address_city" label="City" error={shown("address_city")}>
          <input id="company-address_city" value={draft.address_city} onChange={set("address_city")} maxLength={120} autoComplete="address-level2" className={inputClass} {...aria("address_city")} />
        </Field>
        <Field id="company-address_state" label="State / province" error={shown("address_state")}>
          <input id="company-address_state" value={draft.address_state} onChange={set("address_state")} maxLength={120} autoComplete="address-level1" className={inputClass} {...aria("address_state")} />
        </Field>
        <Field id="company-address_postal_code" label="Postal code" error={shown("address_postal_code")}>
          <input id="company-address_postal_code" value={draft.address_postal_code} onChange={set("address_postal_code")} maxLength={30} autoComplete="postal-code" className={inputClass} {...aria("address_postal_code")} />
        </Field>
        <Field id="company-website" label="Company website" error={shown("website")} hint="For example https://www.yourcompany.com">
          <input id="company-website" type="url" inputMode="url" value={draft.website} onChange={set("website")} maxLength={255} autoComplete="url" className={inputClass} {...aria("website")} />
        </Field>
        <Field id="company-description" label="Business description" error={shown("description")} hint={`Optional. ${draft.description.length} / 1000`} className="sm:col-span-2">
          <textarea id="company-description" value={draft.description} onChange={set("description")} rows={4} maxLength={1100} className={`${inputClass} resize-y`} {...aria("description")} />
        </Field>
      </div>
      {error && <div className="mt-4"><Notice kind="error">{error}</Notice></div>}
      <SaveBar dirty={dirty} busy={busy} onSave={() => void save()} onDiscard={() => { setDraft(saved); setErrors({}); setTouched({}); setError(null); }} />

      <div className="mt-8" aria-label="Registered company information">
        <h3 className="text-sm font-semibold text-ix-text">Registered information</h3>
        <p className="mt-1 text-xs text-ix-muted">These belong to your organization&apos;s registration and cannot be edited here. If one needs to change, ask the Impex team: you will get a request that is already filled in.</p>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          {RESTRICTED.map((item) => (
            <ReadOnly key={item.label} label={item.label} value={item.value(settings)} mono={item.mono}
              action={item.request ? <Link href={changeRequestHref(item.request)} className={linkClass}>Request change</Link> : undefined} />
          ))}
        </dl>
      </div>
    </Card>
  );
}
