"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { DATE_FORMAT_OPTIONS, NUMBER_FORMAT_OPTIONS, formatDateTime, formatDecimal, type DateFormat, type NumberFormat, type Preferences } from "@/lib/format";
import { api, jsonBody } from "@/lib/sales-browser";
import { currencyLabel } from "@/lib/currencies";
import { currencyOptions, timezoneOptions } from "@/lib/timezones";
import { Card, Field, Notice, SaveBar, inputClass } from "./settings-ui";
import type { SectionProps } from "./company-section";

type Draft = Preferences;
const from = (s: SectionProps["settings"]): Draft => ({ default_currency: s.preferences.default_currency, timezone: s.preferences.timezone, date_format: s.preferences.date_format, number_format: s.preferences.number_format });

export default function PreferencesSection({ settings, onSaved, onConflict, setDirty, syncKey, now }: SectionProps & { now: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => from(settings));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const saved = from(settings);
  const keys = Object.keys(saved) as (keyof Draft)[];
  const dirty = keys.some((k) => draft[k] !== saved[k]);
  useEffect(() => { setDirty("preferences", dirty); }, [dirty, setDirty]);
  useEffect(() => { setDraft(from(settings)); setErrors({}); setError(null); }, [syncKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => { setDraft((d) => ({ ...d, [key]: value })); setErrors((e) => ({ ...e, [key]: "" })); setError(null); };

  async function save() {
    if (busyRef.current) return;
    const changes: Partial<Draft> = {};
    for (const k of keys) if (draft[k] !== saved[k]) (changes as Record<string, string>)[k] = draft[k];
    if (Object.keys(changes).length === 0) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const r = await api("/api/settings/preferences", { method: "PATCH", ...jsonBody({ expected_version: settings.version, ...changes }) });
    busyRef.current = false;
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      if (r.status === 409 && r.code === "version_conflict" && r.data?.current) return onConflict(r.data.current, r.error);
      const fe = (r.data?.fieldErrors ?? {}) as Record<string, string>;
      if (Object.keys(fe).length > 0) setErrors(fe);
      return setError(r.error);
    }
    setDraft(from(r.data.settings));
    onSaved(r.data.settings, "Business preferences saved.");
    router.refresh();
  }

  const previewPrefs: Preferences = draft;
  return (
    <Card id="preferences" title="Business preferences" description="Defaults and display settings for your organization.">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="pref-currency" label="Default currency" error={errors.default_currency} hint="Used to start new invoices and purchase orders. You can still pick another currency on any document.">
          <select id="pref-currency" value={draft.default_currency} onChange={(e) => set("default_currency", e.target.value)} className={inputClass}>
            {currencyOptions(saved.default_currency).map((c) => <option key={c} value={c}>{currencyLabel(c)}</option>)}
          </select>
        </Field>
        <Field id="pref-timezone" label="Time zone" error={errors.timezone} hint="How dates and times are written on screen. Stored times stay in UTC.">
          <select id="pref-timezone" value={draft.timezone} onChange={(e) => set("timezone", e.target.value)} className={inputClass}>
            {timezoneOptions(saved.timezone).map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
          </select>
        </Field>
        <Field id="pref-date" label="Date format" error={errors.date_format}>
          <select id="pref-date" value={draft.date_format} onChange={(e) => set("date_format", e.target.value as DateFormat)} className={inputClass}>
            {DATE_FORMAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field id="pref-number" label="Number format" error={errors.number_format}>
          <select id="pref-number" value={draft.number_format} onChange={(e) => set("number_format", e.target.value as NumberFormat)} className={inputClass}>
            {NUMBER_FORMAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </div>

      <div className="mt-5 rounded-xl border border-ix-mist/15 bg-ix-mist/10 px-4 py-3" aria-label="Preview">
        <p className="text-xs font-semibold uppercase tracking-wide text-ix-muted">Preview</p>
        <p className="mt-1.5 text-sm text-ix-text">Now: <span className="font-medium">{formatDateTime(now, previewPrefs)}</span> · Amount: <span className="font-medium">{formatDecimal("1234567.89", previewPrefs, 2)} {draft.default_currency}</span></p>
      </div>
      <p className="mt-3 text-xs text-ix-muted">
        These are defaults and display settings only. Changing them never converts or rewrites anything already recorded: issued invoices, purchase orders, payments, stock quantities and stored times keep exactly the values and the currency they were made with.
      </p>

      {error && <div className="mt-4"><Notice kind="error">{error}</Notice></div>}
      <SaveBar dirty={dirty} busy={busy} onSave={() => void save()} onDiscard={() => { setDraft(saved); setErrors({}); setError(null); }} />
    </Card>
  );
}
