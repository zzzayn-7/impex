"use client";

import type { ReactNode } from "react";

// The Settings page has its own warm look (ivory canvas, white cards, sage green), scoped to this page and the components below. It is the
// same palette as the first-time setup wizard. Nothing here changes the portal header or any other page.
export const inputClass =
  "mt-1.5 block w-full rounded-xl border border-[#E4E8E2] bg-white px-3.5 py-2.5 text-sm text-[#1B211D] placeholder-[#777F79]/70 outline-none transition duration-200 focus:border-[#658675] focus:ring-2 focus:ring-[#658675]/25 disabled:bg-[#F6F6F2] disabled:text-[#777F79] motion-reduce:transition-none";
export const primaryButton =
  "inline-flex min-h-10 items-center justify-center rounded-xl bg-[#426B58] px-5 py-2 text-sm font-semibold text-white shadow-sm transition duration-200 hover:bg-[#385c4b] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#658675] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
export const quietButton =
  "inline-flex min-h-10 items-center justify-center rounded-xl border border-[#E4E8E2] bg-white px-4 py-2 text-sm font-medium text-[#1B211D] transition duration-200 hover:bg-[#F3F5F1] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#658675]/40 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
export const linkClass = "font-medium text-[#426B58] underline decoration-[#658675]/40 underline-offset-2 hover:text-[#1B211D]";

export function Card({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="rounded-2xl border border-[#E4E8E2] bg-white p-5 shadow-[0_1px_2px_rgba(27,33,29,0.04)] sm:p-7">
      <header className="mb-5 border-b border-[#E4E8E2] pb-4">
        <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight text-[#1B211D]">{title}</h2>
        {description && <p className="mt-1 text-sm text-[#777F79]">{description}</p>}
      </header>
      {children}
    </section>
  );
}

export function Field({ id, label, error, hint, children, className = "" }: { id: string; label: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wide text-[#777F79]">{label}</label>
      {children}
      {error ? <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs font-medium text-[#B3402A]">{error}</p> : hint ? <p id={`${id}-hint`} className="mt-1.5 text-xs text-[#777F79]">{hint}</p> : null}
    </div>
  );
}

export function ReadOnly({ label, value, mono = false, action }: { label: string; value: string; mono?: boolean; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-[#E4E8E2] bg-[#F8F8F4] px-3.5 py-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-[#777F79]">{label}</dt>
      <dd className={`mt-1 break-all text-sm text-[#1B211D] ${mono ? "font-mono text-xs" : ""}`}>{value || "—"}</dd>
      {action && <dd className="mt-1.5 text-xs">{action}</dd>}
    </div>
  );
}

export function Notice({ kind, children }: { kind: "success" | "error" | "info"; children: ReactNode }) {
  const style = kind === "success" ? "border-[#658675]/40 bg-[#EAF2ED] text-[#2F5443]" : kind === "error" ? "border-[#B3402A]/30 bg-[#FBEDE9] text-[#8A2F1D]" : "border-[#E4E8E2] bg-[#F3F5F1] text-[#1B211D]";
  return <p role={kind === "error" ? "alert" : "status"} className={`rounded-xl border px-4 py-2.5 text-sm ${style}`}>{children}</p>;
}

export function SaveBar({ dirty, busy, onSave, onDiscard, label = "Save changes", disabled = false }: { dirty: boolean; busy: boolean; onSave: () => void; onDiscard?: () => void; label?: string; disabled?: boolean }) {
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[#E4E8E2] pt-4">
      <p className={`text-xs ${dirty ? "font-medium text-[#8A6A12]" : "text-[#777F79]"}`} aria-live="polite">{dirty ? "You have unsaved changes." : "All changes saved."}</p>
      <div className="flex items-center gap-2">
        {onDiscard && dirty && <button type="button" onClick={onDiscard} disabled={busy} className={quietButton}>Discard</button>}
        <button type="button" onClick={onSave} disabled={!dirty || busy || disabled} className={primaryButton}>{busy ? "Saving…" : label}</button>
      </div>
    </div>
  );
}
