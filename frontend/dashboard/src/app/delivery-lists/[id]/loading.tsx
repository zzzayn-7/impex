// Shown by Next.js while the page loads on the server. The header and page frame come from the delivery-lists layout.
export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading delivery list">
      <div className="h-3 w-32 animate-pulse rounded bg-slate-800/70" />
      <div className="space-y-2">
        <div className="h-7 w-48 animate-pulse rounded bg-slate-800" />
        <div className="h-3 w-72 max-w-full animate-pulse rounded bg-slate-800/70" />
      </div>
      <div className="h-48 animate-pulse rounded-xl bg-slate-900/60" />
      <span className="sr-only">Loading delivery list…</span>
    </div>
  );
}
