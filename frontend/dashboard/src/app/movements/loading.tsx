// Shown by Next.js while the page loads on the server. The header and page frame come from layout.tsx.
export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading movements">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-6 w-32 animate-pulse rounded bg-slate-800" />
          <div className="h-3 w-64 animate-pulse rounded bg-slate-800/70" />
        </div>
        <div className="h-10 w-32 animate-pulse rounded-lg bg-slate-800" />
      </div>
      <div className="h-12 animate-pulse rounded-xl bg-slate-900/60" />
      <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/30 p-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-slate-800/60" />
        ))}
      </div>
      <span className="sr-only">Loading movements…</span>
    </div>
  );
}
