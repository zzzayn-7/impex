export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading Help & Support">
      <div className="space-y-2">
        <div className="h-6 w-48 animate-pulse rounded bg-slate-800" />
        <div className="h-3 w-80 max-w-full animate-pulse rounded bg-slate-800/70" />
      </div>
      <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/30 p-4">
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-12 animate-pulse rounded bg-slate-800/60" />)}
      </div>
      <span className="sr-only">Loading Help &amp; Support…</span>
    </div>
  );
}
