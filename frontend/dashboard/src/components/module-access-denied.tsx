import Link from "next/link";

import { MODULE_LABELS, type ModuleKey } from "@/lib/modules";

// Shown instead of a page whose module is not enabled for the organization. The page itself is never rendered (so nothing of it is
// fetched or sent), and the services behind it refuse the same requests on their own.
export default function ModuleAccessDenied({ module }: { module: ModuleKey }) {
  const name = MODULE_LABELS[module];
  return (
    <div role="alert" data-module-denied={module} className="mx-auto max-w-xl space-y-4 rounded-xl border border-slate-700 bg-slate-900/50 p-6 text-center">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">Access denied</p>
      <h2 className="text-lg font-semibold text-white">{name} is not enabled for your organization</h2>
      <p className="text-sm text-slate-400">
        The Impex team decides which modules each organization can use. Nothing has been lost: if {name} is enabled later, everything in it is
        exactly as you left it.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
        <Link href={`/support/new?module=${module}`} className="inline-flex min-h-10 items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
          Request access from the Impex team
        </Link>
        <Link href="/" className="text-sm text-indigo-300 hover:text-indigo-200">Back to the dashboard</Link>
      </div>
    </div>
  );
}
