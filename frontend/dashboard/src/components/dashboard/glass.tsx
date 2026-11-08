import type { ReactNode } from "react";

// Presentation primitives for the Organization Dashboard (the glass itself is CSS: .ix-glass in globals.css).

export function GlassCard({ children, className = "", small = false, lift = false, ...rest }: { children: ReactNode; className?: string; small?: boolean; lift?: boolean } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section {...rest} className={`ix-glass relative ${small ? "ix-glass-sm" : ""} ${lift ? "ix-glass-lift" : ""} ${className}`}>
      {children}
    </section>
  );
}

export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="truncate text-[15px] font-semibold tracking-tight text-ix-text">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-ix-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/** A calm empty or error state inside a card. */
export function CardNote({ children, tone = "empty" }: { children: ReactNode; tone?: "empty" | "error" }) {
  return (
    <p role={tone === "error" ? "alert" : undefined} className={`rounded-2xl border border-dashed px-4 py-8 text-center text-sm ${tone === "error" ? "border-amber-200/25 bg-amber-100/5 text-amber-100/90" : "border-ix-mist/15 text-ix-muted"}`}>
      {children}
    </p>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "muted" }) {
  const styles = {
    neutral: "border-ix-mist/20 bg-ix-mist/10 text-ix-mist",
    good: "border-ix-butter/30 bg-ix-butter/15 text-ix-butter",
    warn: "border-amber-200/25 bg-amber-100/10 text-amber-100",
    muted: "border-ix-mist/10 bg-ix-deep/30 text-ix-muted",
  } as const;
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${styles[tone]}`}>{children}</span>;
}

export function Footnote({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-[11px] leading-relaxed text-ix-muted/90">{children}</p>;
}
