import Link from "next/link";

import { ErrorState } from "@/components/ui/page";
import { buttonClass, fieldClass as sharedFieldClass } from "@/components/ui/controls";
import { Stamp } from "@/components/clock";
import { InsetPanel } from "@/components/ui/glass";
import { ACTION_LABELS } from "@/lib/finance-browser";
import type { AuditLine } from "@/lib/finance";

// Small pieces shared by the Finance pages. The look comes from the portal's shared design system (components/ui/*): the same buttons, fields and
// surfaces as every other section. Colours here carry meaning where they appear on a status (green posted, amber draft, red failed); the section
// accent is decorative only.
export const fieldClass = sharedFieldClass;
export const selectClass = "mt-1.5 block max-w-[14rem] rounded-xl border border-ix-mist/15 bg-ix-deep/50 px-3 py-2 text-sm text-ix-text outline-none focus:border-ix-accent/70 focus:ring-2 focus:ring-ix-accent/20";
export const primaryButton = buttonClass.primary;
export const secondaryButton = buttonClass.secondary;
export const dangerButton = buttonClass.destructive;

export function Pill({ children, style }: { children: React.ReactNode; style: string }) {
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}>{children}</span>;
}

export function InfoNotice({ children }: { children: React.ReactNode }) {
  return <InsetPanel className="px-4 py-3 text-xs leading-relaxed text-ix-muted">{children}</InsetPanel>;
}

export function Unavailable({ reason, what }: { reason: "unauthorized" | "forbidden" | "not-found" | "unavailable"; what: string }) {
  return (
    <ErrorState>
      {reason === "forbidden"
        ? `Your organization is currently inactive or unavailable, so ${what} cannot be used. Please contact your platform administrator.`
        : `${what[0].toUpperCase()}${what.slice(1)} are temporarily unavailable. Please refresh in a moment.`}
    </ErrorState>
  );
}

export function Missing({ back, what }: { back: React.ReactNode; what: string }) {
  return (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-2xl border border-dashed border-ix-mist/15 px-4 py-10 text-center text-sm text-ix-muted">{what} not found.</p>
    </div>
  );
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="print:hidden text-xs text-indigo-300 hover:text-indigo-200">← {children}</Link>;
}


/** The audit trail of one record: who (a person, or the Sales/Purchasing synchronisation) did what, and when. */
export function History({ items }: { items: AuditLine[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-label="History" className="ix-panel space-y-2 p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-ix-text">History</h3>
      <ol className="space-y-1.5 text-xs text-slate-300">
        {items.map((h) => (
          <li key={h.seq} className="flex flex-wrap gap-x-2">
            <span className="font-medium text-slate-100">{ACTION_LABELS[h.action] ?? h.action}</span>
            <span className="text-slate-400">by {h.source === "sync" ? "automatic synchronisation" : h.actor_email ?? "an administrator"}</span>
            <span className="text-slate-500"><Stamp iso={h.created_at} /></span>
            {h.detail && <span className="w-full text-slate-500">{h.detail}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
