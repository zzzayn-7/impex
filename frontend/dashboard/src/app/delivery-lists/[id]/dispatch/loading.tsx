export default function Loading() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading">
      <div className="h-6 w-56 animate-pulse rounded bg-slate-800" />
      <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/30 p-4">
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-10 animate-pulse rounded bg-slate-800/60" />)}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
