import Link from "next/link";

// Shown instead of every page except Settings and Help & Support while the Impex team has LOCKED the organization (usually because a payment is overdue).
// The page itself is never rendered (so nothing of it is fetched or sent), and every service behind it refuses the same requests on its own: a locked
// organization has no usable module. Nothing has been deleted.
export function LockedNotice() {
  return (
    <div role="alert" data-organization-locked="true" className="mx-auto max-w-xl space-y-4 rounded-xl border border-amber-300/25 bg-amber-100/5 p-6 text-center">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">Access restricted</p>
      <h2 className="text-lg font-semibold text-ix-text">Your organization&apos;s access is locked</h2>
      <p className="text-sm text-ix-muted">
        The Impex team has restricted your organization&apos;s access, usually because a payment is overdue. Every module is switched off for now; you can still sign in, use Settings
        and write to the Impex team in Help &amp; Support. Nothing has been deleted: once access is restored, everything is exactly as you left it.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
        <Link href="/support/new" className="inline-flex min-h-10 items-center rounded-lg bg-ix-butter px-4 py-2 text-sm font-semibold text-ix-on-accent hover:bg-ix-butter-hover">Contact the Impex team</Link>
        <Link href="/settings" className="text-sm font-medium text-ix-accent-text hover:underline">Open Settings</Link>
      </div>
    </div>
  );
}

// The reminder above Settings and Help & Support while locked.
export function LockedBanner() {
  return (
    <p role="note" data-organization-locked="banner" className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-200/25 bg-amber-100/10 px-4 py-3 text-sm text-amber-100">
      <span>Your organization&apos;s access is locked: only Settings and Help &amp; Support are available. Contact the Impex team to have it restored.</span>
      <Link href="/support/new" className="font-medium text-amber-50 underline hover:text-white">Contact the Impex team</Link>
    </p>
  );
}
