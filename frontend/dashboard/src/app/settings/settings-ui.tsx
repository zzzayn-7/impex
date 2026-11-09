"use client";

import type { ReactNode } from "react";

// Settings uses the portal's shared glass design (the same palette and surfaces as every other page and the first-time setup wizard). The cards
// are level-2 panels: a little more opaque than the dashboard's glass, because these are long forms that must stay highly readable.
export const inputClass =
  "mt-1.5 block w-full rounded-xl border border-ix-mist/15 bg-ix-deep/55 px-3.5 py-2.5 text-sm text-ix-text placeholder-ix-muted/60 outline-none transition duration-200 focus:border-ix-accent focus:ring-2 focus:ring-ix-accent/25 disabled:bg-ix-mist/5 disabled:text-ix-muted motion-reduce:transition-none";
export const primaryButton =
  "inline-flex min-h-10 items-center justify-center rounded-xl bg-ix-butter px-5 py-2 text-sm font-semibold text-ix-on-accent shadow-sm transition duration-200 hover:bg-ix-butter-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
export const quietButton =
  "inline-flex min-h-10 items-center justify-center rounded-xl border border-ix-mist/15 bg-ix-deep/55 px-4 py-2 text-sm font-medium text-ix-text transition duration-200 hover:bg-ix-mist/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/50 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
export const linkClass = "font-medium text-ix-accent-text underline decoration-ix-muted/40 underline-offset-2 hover:text-ix-text";

export function Card({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="ix-panel relative p-5 sm:p-7">
      <header className="mb-5 border-b border-ix-mist/15 pb-4">
        <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight text-ix-text">{title}</h2>
        {description && <p className="mt-1 text-sm text-ix-muted">{description}</p>}
      </header>
      {children}
    </section>
  );
}

export function Field({ id, label, error, hint, children, className = "" }: { id: string; label: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wide text-ix-muted">{label}</label>
      {children}
      {error ? <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs font-medium text-red-300">{error}</p> : hint ? <p id={`${id}-hint`} className="mt-1.5 text-xs text-ix-muted">{hint}</p> : null}
    </div>
  );
}

export function ReadOnly({ label, value, mono = false, action }: { label: string; value: string; mono?: boolean; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-ix-mist/15 bg-ix-mist/10 px-3.5 py-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-ix-muted">{label}</dt>
      <dd className={`mt-1 break-all text-sm text-ix-text ${mono ? "font-mono text-xs" : ""}`}>{value || "—"}</dd>
      {action && <dd className="mt-1.5 text-xs">{action}</dd>}
    </div>
  );
}

export function Notice({ kind, children }: { kind: "success" | "error" | "info"; children: ReactNode }) {
  const style = kind === "success" ? "border-ix-accent-text/40 bg-ix-butter/15 text-ix-accent-text" : kind === "error" ? "border-red-300/30 bg-red-400/10 text-red-200" : "border-ix-mist/15 bg-ix-mist/10 text-ix-text";
  return <p role={kind === "error" ? "alert" : "status"} className={`rounded-xl border px-4 py-2.5 text-sm ${style}`}>{children}</p>;
}

export function SaveBar({ dirty, busy, onSave, onDiscard, label = "Save changes", disabled = false }: { dirty: boolean; busy: boolean; onSave: () => void; onDiscard?: () => void; label?: string; disabled?: boolean }) {
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-ix-mist/15 pt-4">
      <p className={`text-xs ${dirty ? "font-medium text-amber-100" : "text-ix-muted"}`} aria-live="polite">{dirty ? "You have unsaved changes." : "All changes saved."}</p>
      <div className="flex items-center gap-2">
        {onDiscard && dirty && <button type="button" onClick={onDiscard} disabled={busy} className={quietButton}>Discard</button>}
        <button type="button" onClick={onSave} disabled={!dirty || busy || disabled} className={primaryButton}>{busy ? "Saving…" : label}</button>
      </div>
    </div>
  );
}
