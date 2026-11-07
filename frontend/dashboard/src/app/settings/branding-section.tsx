"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { LOGO_ACCEPT, checkLogoFile, monogram } from "@/lib/setup-validation";
import { Card, Notice, primaryButton, quietButton } from "./settings-ui";
import type { SectionProps } from "./company-section";

type Result = { ok: boolean; status: number; data: any; error: string; code?: string };

// (A file upload cannot go through the JSON helper: the browser must set the multipart boundary itself.)
async function send(url: string, init: RequestInit): Promise<Result> {
  try {
    const res = await fetch(url, { ...init, cache: "no-store" });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data, error: res.ok ? "" : typeof data?.error === "string" ? data.error : "That did not work. Please try again.", code: data?.code };
  } catch {
    return { ok: false, status: 0, data: null, error: "Unable to reach the server. Please try again." };
  }
}

/** What the portal header will look like: the logo (or the monogram) and the company name, exactly as the header draws them. */
export function HeaderPreview({ name, logoSrc }: { name: string; logoSrc: string | null }) {
  return (
    <div aria-label="Header preview" className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 shadow-sm">
      <div className="flex items-center gap-3">
        {logoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoSrc} alt="" className="h-9 w-9 rounded-lg bg-white object-contain p-0.5" />
        ) : (
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-lg font-bold text-white">{monogram(name)}</div>
        )}
        <div>
          <p className="text-lg font-bold leading-tight tracking-tight text-white">{name}</p>
          <p className="text-xs text-slate-400">Admin Portal</p>
        </div>
      </div>
    </div>
  );
}

export default function BrandingSection({ settings, onSaved, onConflict, setDirty, syncKey, name }: SectionProps & { name: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasLogo = settings.branding.has_logo;
  const currentSrc = hasLogo ? `/api/organization/logo?v=${encodeURIComponent(settings.branding.logo_version ?? "")}` : null;
  const dirty = file !== null;

  useEffect(() => { setDirty("branding", dirty); }, [dirty, setDirty]);
  useEffect(() => { clear(); }, [syncKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function clear() {
    setFile(null);
    setPreview(null);
    setError(null);
    setConfirmRemove(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  function choose(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    setError(null);
    if (!picked) return clear();
    const problem = checkLogoFile(picked);
    if (problem) {
      clear();
      return setError(problem);
    }
    setFile(picked);
    setPreview(URL.createObjectURL(picked)); // a preview of the file as chosen: nothing is saved until Save logo
  }

  async function run(request: () => Promise<Result>, success: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const r = await request();
    busyRef.current = false;
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      if (r.status === 409 && r.code === "version_conflict" && r.data?.current) return onConflict(r.data.current, r.error);
      return setError(r.error);
    }
    clear();
    onSaved(r.data.settings, success);
    router.refresh(); // the header picks up the new logo (its address carries the new version, so no stale copy is shown)
  }

  const upload = () => {
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    form.set("expected_version", String(settings.version));
    void run(() => send("/api/settings/logo", { method: "PUT", body: form }), hasLogo ? "Logo replaced." : "Logo saved.");
  };
  const remove = () => void run(() => send(`/api/settings/logo?expected_version=${settings.version}`, { method: "DELETE" }), "Logo removed. Your company monogram is shown instead.");

  return (
    <Card id="branding" title="Company branding" description="Your logo appears in the portal header. PNG, JPEG or WebP, up to 2 MB.">
      <div className="grid gap-6 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#777F79]">{preview ? "Selected logo" : "Current logo"}</p>
          <div className="flex h-44 items-center justify-center rounded-2xl border border-dashed border-[#CBD3C9] bg-[#F8F8F4] p-4">
            {preview || currentSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview ?? currentSrc ?? ""} alt={preview ? "Selected logo preview" : "Current company logo"} className="max-h-full max-w-full rounded-lg object-contain" />
            ) : (
              <div className="text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[#426B58] text-2xl font-bold text-white">{monogram(name)}</div>
                <p className="mt-2 text-xs text-[#777F79]">No logo: the monogram is shown</p>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="logo-file" className="block text-xs font-semibold uppercase tracking-wide text-[#777F79]">{hasLogo ? "Replace logo" : "Upload logo"}</label>
            <input ref={inputRef} id="logo-file" type="file" accept={LOGO_ACCEPT} onChange={choose} disabled={busy}
              className="mt-1.5 block w-full text-sm text-[#1B211D] file:mr-3 file:rounded-xl file:border file:border-[#E4E8E2] file:bg-white file:px-4 file:py-2 file:text-sm file:font-medium file:text-[#1B211D] hover:file:bg-[#F3F5F1]" />
            <p className="mt-1.5 text-xs text-[#777F79]">The picture is checked and re-encoded on the server. Choose a square or wide logo of at least 64 × 64 pixels.</p>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[#777F79]">How it will look in your header</p>
            <HeaderPreview name={name} logoSrc={preview ?? currentSrc} />
          </div>

          {error && <Notice kind="error">{error}</Notice>}

          {confirmRemove ? (
            <div role="alertdialog" aria-label="Remove the company logo" className="space-y-3 rounded-xl border border-[#B3402A]/30 bg-[#FBEDE9] p-4">
              <p className="text-sm text-[#8A2F1D]">Remove your logo? The header will show your company monogram instead. Invoices that were already issued keep the branding they were issued with.</p>
              <div className="flex gap-2">
                <button type="button" onClick={remove} disabled={busy} className="inline-flex min-h-10 items-center rounded-xl bg-[#B3402A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#9a3622] disabled:opacity-50">{busy ? "Removing…" : "Yes, remove logo"}</button>
                <button type="button" onClick={() => setConfirmRemove(false)} disabled={busy} className={quietButton}>Keep it</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className={`text-xs ${dirty ? "font-medium text-[#8A6A12]" : "text-[#777F79]"}`} aria-live="polite">{dirty ? "You have an unsaved logo." : "All changes saved."}</p>
              <div className="flex gap-2">
                {dirty && <button type="button" onClick={clear} disabled={busy} className={quietButton}>Discard</button>}
                {!dirty && hasLogo && <button type="button" onClick={() => setConfirmRemove(true)} disabled={busy} className={quietButton}>Remove logo</button>}
                <button type="button" onClick={upload} disabled={!dirty || busy} className={primaryButton}>{busy ? "Saving…" : hasLogo ? "Replace logo" : "Save logo"}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
