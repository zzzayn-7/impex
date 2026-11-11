"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { formatDateTime, normalizePreferences } from "@/lib/format";
import type { HistoryData, SettingsData } from "@/lib/settings";
import AppearanceSection from "./appearance-section";
import BrandingSection from "./branding-section";
import CompanySection from "./company-section";
import PreferencesSection from "./preferences-section";
import ProfileSection, { type AdminInfo } from "./profile-section";
import { Card, Notice, linkClass } from "./settings-ui";

const FIELD_LABELS: Record<string, string> = {
  name: "Company display name", contact_email: "Business contact email", contact_phone: "Phone number", address_street: "Street address", address_city: "City",
  address_state: "State / province", address_postal_code: "Postal code", website: "Website", description: "Business description", logo: "Company logo",
  default_currency: "Default currency", timezone: "Time zone", date_format: "Date format", number_format: "Number format",
};

const shorten = (value: string | null) => (value === null ? "empty" : value.length > 60 ? `${value.slice(0, 57)}…` : value);

/** The areas of Organization Settings, each a dropdown that opens its form downwards. The saved values live here (one version for the whole organization); each section keeps its own
 *  draft and saves on its own. A save names the version it was made from, so a change made meanwhile by another administrator is refused and
 *  the current values are shown instead of being overwritten. */
export default function SettingsView({ initial, history: initialHistory, admin, now }: { initial: SettingsData; history: HistoryData; admin: AdminInfo; now: string }) {
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
    <div className="space-y-6 rounded-3xl bg-transparent p-4 text-ix-text sm:p-8" style={{ fontFamily: 'Inter, Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ix-text">Settings</h1>
        <p className="mt-1 text-sm text-ix-muted">Manage your company, your own profile and how Impex shows your business. Changes are saved to your organization and apply for every administrator.</p>
      </div>

      {notice && (
        <div className="sticky top-2 z-10"><Notice kind={notice.kind}>{notice.text}</Notice></div>
      )}
      {dirtyCount > 0 && <p role="note" className="rounded-xl border border-amber-200/25 bg-amber-100/10 px-4 py-2.5 text-sm text-amber-100">You have unsaved changes in {dirtyCount} {dirtyCount === 1 ? "section" : "sections"}. Save them before you leave this page.</p>}

      <CompanySection {...common} />
      <BrandingSection {...common} name={settings.company.name} />
      <ProfileSection admin={admin} organizationName={settings.company.name} setDirty={setDirty} onSaved={(m) => setNotice({ kind: "success", text: m })} />
      <PreferencesSection {...common} now={now} />
      <AppearanceSection />

      <Card id="history" title="Recent changes" description="Every change to your company profile, branding and preferences is recorded permanently: what changed, who changed it and when.">
      {history.items.length === 0 ? (
        <p className="mt-4 text-sm text-ix-muted">No changes yet.</p>
      ) : (
        <ol className="mt-4 divide-y divide-ix-mist/10">
          {history.items.map((item) => (
            <li key={item.id} className="py-3 text-sm">
              <p className="font-medium text-ix-text">{FIELD_LABELS[item.field] ?? item.field}</p>
              <p className="text-ix-muted">
                {item.field === "logo" ? `Logo ${item.new_value ?? "changed"}` : <>{shorten(item.old_value)} → <span className="text-ix-text">{shorten(item.new_value)}</span></>}
              </p>
              <p className="text-xs text-ix-muted">{item.changed_by_name ?? item.changed_by_email ?? "An administrator"} · {formatDateTime(item.created_at, prefs)}</p>
            </li>
          ))}
        </ol>
      )}
      {history.total > history.items.length && <p className="mt-2 text-xs text-ix-muted">Showing the latest {history.items.length} of {history.total}.</p>}
      </Card>

      <p className="text-xs text-ix-muted">Need something changed that you cannot edit here? <a href="/support/new?change=other" className={linkClass}>Ask the Impex team</a>.</p>
    </div>
  );
}
