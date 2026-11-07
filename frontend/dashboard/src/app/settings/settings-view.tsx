"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { formatDateTime, normalizePreferences } from "@/lib/format";
import type { HistoryData, SettingsData } from "@/lib/settings";
import BrandingSection from "./branding-section";
import CompanySection from "./company-section";
import ModulesSection from "./modules-section";
import PreferencesSection from "./preferences-section";
import ProfileSection, { type AdminInfo } from "./profile-section";
import { Notice, linkClass } from "./settings-ui";

const SECTIONS = [
  { id: "company", label: "Company profile" },
  { id: "branding", label: "Branding" },
  { id: "profile", label: "Administrator" },
  { id: "preferences", label: "Preferences" },
  { id: "modules", label: "Modules" },
];

const FIELD_LABELS: Record<string, string> = {
  name: "Company display name", contact_email: "Business contact email", contact_phone: "Phone number", address_street: "Street address", address_city: "City",
  address_state: "State / province", address_postal_code: "Postal code", website: "Website", description: "Business description", logo: "Company logo",
  default_currency: "Default currency", timezone: "Time zone", date_format: "Date format", number_format: "Number format",
};

const shorten = (value: string | null) => (value === null ? "empty" : value.length > 60 ? `${value.slice(0, 57)}…` : value);

/** The five sections of Organization Settings. The saved values live here (one version for the whole organization); each section keeps its own
 *  draft and saves on its own. A save names the version it was made from, so a change made meanwhile by another administrator is refused and
 *  the current values are shown instead of being overwritten. */
export default function SettingsView({ initial, history: initialHistory, admin, modules, now }: { initial: SettingsData; history: HistoryData; admin: AdminInfo; modules: unknown; now: string }) {
  const [settings, setSettings] = useState(initial);
  const [history, setHistory] = useState(initialHistory);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [syncKey, setSyncKey] = useState(0);
  const dirtyRef = useRef<Record<string, boolean>>({});
  const [dirtyCount, setDirtyCount] = useState(0);

  const setDirty = useCallback((key: string, dirty: boolean) => {
    if (Boolean(dirtyRef.current[key]) === dirty) return;
    dirtyRef.current = { ...dirtyRef.current, [key]: dirty };
    setDirtyCount(Object.values(dirtyRef.current).filter(Boolean).length);
  }, []);

  // leaving or reloading the page with unsaved changes asks first
  useEffect(() => {
    if (dirtyCount === 0) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirtyCount]);

  async function refreshHistory() {
    try {
      const res = await fetch("/api/settings/history", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.items)) setHistory(data);
      }
    } catch { /* the page still works without the list */ }
  }

  const onSaved = useCallback((next: SettingsData, message: string) => {
    setSettings(next);
    setNotice({ kind: "success", text: message });
    void refreshHistory();
  }, []);
  const onConflict = useCallback((current: SettingsData, message: string) => {
    setSettings(current);
    setSyncKey((k) => k + 1); // every form starts again from the current saved values
    setNotice({ kind: "error", text: message });
  }, []);

  const prefs = normalizePreferences(settings.preferences);
  const common = { settings, onSaved, onConflict, setDirty, syncKey };

  return (
    <div className="space-y-6 rounded-3xl bg-[#EEEDE8] p-4 text-[#1B211D] sm:p-8" style={{ fontFamily: 'Inter, Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[#1B211D]">Settings</h1>
        <p className="mt-1 text-sm text-[#777F79]">Manage your company, your own profile and how Impex shows your business. Changes are saved to your organization and apply for every administrator.</p>
      </div>

      <nav aria-label="Settings sections" className="flex flex-wrap gap-2">
        {SECTIONS.map((s) => <a key={s.id} href={`#${s.id}`} className="rounded-full border border-[#E4E8E2] bg-white px-3.5 py-1.5 text-xs font-medium text-[#426B58] transition hover:bg-[#EAF2ED] motion-reduce:transition-none">{s.label}</a>)}
      </nav>

      {notice && (
        <div className="sticky top-2 z-10"><Notice kind={notice.kind}>{notice.text}</Notice></div>
      )}
      {dirtyCount > 0 && <p role="note" className="rounded-xl border border-[#E7D9A8] bg-[#FBF5DF] px-4 py-2.5 text-sm text-[#6B5410]">You have unsaved changes in {dirtyCount} {dirtyCount === 1 ? "section" : "sections"}. Save them before you leave this page.</p>}

      <CompanySection {...common} />
      <BrandingSection {...common} name={settings.company.name} />
      <ProfileSection admin={admin} organizationName={settings.company.name} setDirty={setDirty} onSaved={(m) => setNotice({ kind: "success", text: m })} />
      <PreferencesSection {...common} now={now} />
      <ModulesSection modules={modules} />

      <section aria-labelledby="history-title" className="rounded-2xl border border-[#E4E8E2] bg-white p-5 sm:p-7">
        <details>
          <summary id="history-title" className="cursor-pointer text-lg font-semibold tracking-tight text-[#1B211D]">Recent changes</summary>
          <p className="mt-2 text-xs text-[#777F79]">Every change to your company profile, branding and preferences is recorded permanently: what changed, who changed it and when.</p>
          {history.items.length === 0 ? (
            <p className="mt-4 text-sm text-[#777F79]">No changes yet.</p>
          ) : (
            <ol className="mt-4 divide-y divide-[#E4E8E2]">
              {history.items.map((item) => (
                <li key={item.id} className="py-3 text-sm">
                  <p className="font-medium text-[#1B211D]">{FIELD_LABELS[item.field] ?? item.field}</p>
                  <p className="text-[#777F79]">
                    {item.field === "logo" ? `Logo ${item.new_value ?? "changed"}` : <>{shorten(item.old_value)} → <span className="text-[#1B211D]">{shorten(item.new_value)}</span></>}
                  </p>
                  <p className="text-xs text-[#777F79]">{item.changed_by_name ?? item.changed_by_email ?? "An administrator"} · {formatDateTime(item.created_at, prefs)}</p>
                </li>
              ))}
            </ol>
          )}
          {history.total > history.items.length && <p className="mt-2 text-xs text-[#777F79]">Showing the latest {history.items.length} of {history.total}.</p>}
        </details>
      </section>

      <p className="text-xs text-[#777F79]">Need something changed that you cannot edit here? <a href="/support/new?change=other" className={linkClass}>Ask the Impex team</a>.</p>
    </div>
  );
}
