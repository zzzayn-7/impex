"use client";

import { ACCENTS, BACKGROUNDS, accentOf, backgroundOf } from "@/lib/theme";
import { useTheme } from "./theme-provider";

// THE theme customizer: two independent choices (a background and an accent), a live preview, and Apply Theme / Cancel / Reset to Default.
// One component, shown in the header popover and in Settings (and anywhere else it is needed): they share the provider's state, so they always agree.
// Only colours are customisable here: nothing about layout, type, spacing or motion. This file is an identical copy in both portals.

const check = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
);

const heading = "text-xs font-semibold uppercase tracking-wide text-ix-muted";

export default function ThemeCustomizer({ variant = "popover" }: { variant?: "popover" | "inline" }) {
  const { draft, dirty, busy, error, preview, apply, cancel, reset } = useTheme();
  const background = backgroundOf(draft.background), accent = accentOf(draft.accent);

  return (
    <div className="space-y-5" data-theme-customizer={variant}>
      <fieldset>
        <legend className={heading}>Background</legend>
        <div role="radiogroup" aria-label="Background" className={`mt-2 grid gap-2 ${variant === "inline" ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6" : "grid-cols-2 sm:grid-cols-3"}`}>
          {BACKGROUNDS.map((option) => {
            const selected = option.id === draft.background;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${option.name} ${option.hex}`}
                onClick={() => preview({ background: option.id })}
                className={`group rounded-2xl border p-1.5 text-left transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60 ${selected ? "border-ix-accent-text bg-ix-accent-text/10" : "border-ix-mist/15 bg-ix-mist/5 hover:border-ix-mist/30 hover:bg-ix-mist/10"}`}
              >
                <span className="relative block h-11 rounded-xl border border-ix-mist/25" style={{ background: option.hex }}>
                  {selected && <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-ix-butter text-ix-on-accent shadow">{check}</span>}
                </span>
                <span className="mt-1.5 block truncate px-0.5 text-xs font-medium text-ix-text">{option.name}</span>
                <span className="block px-0.5 font-mono text-[10px] text-ix-muted">{option.hex}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className={heading}>Accent</legend>
        <div role="radiogroup" aria-label="Accent" className={`mt-2 grid gap-x-2 gap-y-3 ${variant === "inline" ? "grid-cols-4 sm:grid-cols-8" : "grid-cols-4"}`}>
          {ACCENTS.map((option) => {
            const selected = option.id === draft.accent;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${option.name} ${option.hex}`}
                onClick={() => preview({ accent: option.id })}
                className="group flex flex-col items-center gap-1.5 rounded-2xl p-1 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60"
              >
                <span
                  className={`relative grid h-10 w-10 place-items-center rounded-full border transition duration-150 group-hover:scale-110 ${selected ? "border-ix-text ring-2 ring-ix-accent-text ring-offset-2 ring-offset-slate-950" : "border-ix-mist/30"}`}
                  style={{ background: option.hex }}
                >
                  {selected && <span className="text-black/70">{check}</span>}
                </span>
                <span className={`text-[11px] leading-tight ${selected ? "font-semibold text-ix-text" : "text-ix-muted group-hover:text-ix-text"}`}>{option.name}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div>
        <p className={heading}>Preview</p>
        {/* A miniature of the interface, drawn with the real classes: it shows exactly what the chosen pair does to a glass card, a selected item, a button and text. */}
        <div aria-hidden="true" data-theme-preview className="ix-inset pointer-events-none mt-2 p-3">
          <div className="ix-glass relative flex items-center gap-3 p-3">
            <div className="relative flex h-9 shrink-0 items-center rounded-xl bg-ix-accent-text/10 pl-3 pr-3 text-xs font-medium text-ix-text shadow-[inset_0_0_0_1px_rgb(var(--ix-accent-text-rgb)/0.3)]">
              <span className="absolute -left-1 top-1.5 h-6 w-1 rounded-full bg-ix-accent-text" />
              <span className="mr-2 inline-block h-3 w-3 rounded-sm bg-ix-accent-text/70" />
              Dashboard
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ix-text">Welcome back</p>
              <p className="truncate text-xs text-ix-muted">{background.name} · {accent.name}</p>
            </div>
            <span className="ml-auto inline-flex h-8 shrink-0 items-center rounded-xl bg-ix-butter px-3 text-xs font-semibold text-ix-on-accent">Primary</span>
          </div>
        </div>
      </div>

      {error && <p role="alert" className="rounded-xl border border-red-300/30 bg-red-400/10 px-3 py-2 text-xs font-medium text-red-300">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void apply()} disabled={busy} className="inline-flex min-h-10 items-center justify-center rounded-xl bg-ix-butter px-4 py-2 text-sm font-semibold text-ix-on-accent transition duration-150 hover:bg-ix-butter-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60 disabled:cursor-not-allowed disabled:opacity-60">
          {busy ? "Saving…" : "Apply Theme"}
        </button>
        <button type="button" onClick={cancel} disabled={busy} className="inline-flex min-h-10 items-center justify-center rounded-xl border border-ix-mist/20 bg-ix-mist/5 px-4 py-2 text-sm font-medium text-ix-text transition duration-150 hover:bg-ix-mist/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60 disabled:opacity-60">
          Cancel
        </button>
        <button type="button" onClick={reset} disabled={busy} className="ml-auto inline-flex min-h-10 items-center justify-center rounded-xl px-3 py-2 text-sm font-medium text-ix-muted transition duration-150 hover:text-ix-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60 disabled:opacity-60">
          Reset to Default
        </button>
      </div>
      {dirty && <p className="text-[11px] text-ix-muted">Previewing on every page. It is saved only when you press Apply Theme.</p>}
    </div>
  );
}
