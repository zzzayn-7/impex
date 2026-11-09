import Link from "next/link";
import type { ReactNode } from "react";

import { GlassPanel } from "./glass";

// Page furniture shared by every section: headers, empty and error states, status badges, loading placeholders and tabs.

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-ix-text">{title}</h2>
        {subtitle && <p className="mt-1 text-xs leading-relaxed text-ix-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold tracking-tight text-ix-text">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-ix-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl border border-dashed border-ix-mist/15 px-4 py-10 text-center text-sm text-ix-muted">{children}</p>;
}

/** A recoverable error: announced to assistive technology, calm in tone. */
export function ErrorState({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded-2xl border border-amber-200/25 bg-amber-100/10 px-4 py-3 text-sm text-amber-100">{children}</div>;
}

// Status colours carry MEANING and are separate from the decorative section accents.
const TONES = {
  success: "border-emerald-300/30 bg-emerald-400/10 text-emerald-200",
  warning: "border-amber-200/30 bg-amber-300/10 text-amber-100",
  danger: "border-red-300/30 bg-red-400/10 text-red-200",
  info: "border-sky-200/30 bg-sky-300/10 text-sky-100",
  pending: "border-violet-200/25 bg-violet-300/10 text-violet-100",
  neutral: "border-ix-mist/20 bg-ix-mist/10 text-ix-mist",
  muted: "border-ix-mist/10 bg-ix-deep/30 text-ix-muted",
} as const;

export type Tone = keyof typeof TONES;

export function StatusBadge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

/** Loading placeholder with the same shapes as the content (no spinner, no layout jump). */
export function LoadingSkeleton({ rows = 6, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-5" role="status" aria-label={label}>
      <div className="space-y-2">
        <div className="ix-skeleton h-6 w-44" />
        <div className="ix-skeleton h-3 w-72 max-w-full" />
      </div>
      <GlassPanel className="space-y-2 p-4">
        {Array.from({ length: rows }).map((_, i) => <div key={i} className="ix-skeleton h-10" />)}
      </GlassPanel>
      <span className="sr-only">{label}…</span>
    </div>
  );
}

/** Section tabs: real links, the current one marked with aria-current. The caller decides which is current. */
export function TabNavigation({ label, tabs, current }: { label: string; tabs: { href: string; label: string }[]; current: string }) {
  return (
    <nav aria-label={label} className="print:hidden mb-6 flex flex-wrap gap-1 rounded-2xl border border-ix-mist/10 bg-ix-deep/30 p-1">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.href === current ? "page" : undefined}
          className={`rounded-xl px-3.5 py-2 text-sm font-medium transition-colors ${tab.href === current ? "bg-ix-accent/15 text-ix-accent-text shadow-[inset_0_0_0_1px_rgb(var(--ix-accent-text-rgb)/0.3)]" : "text-ix-muted hover:bg-ix-mist/10 hover:text-ix-text"}`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
