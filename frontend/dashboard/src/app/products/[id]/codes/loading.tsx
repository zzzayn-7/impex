// Shown by Next.js while the page loads on the server. The header and page frame come from the products layout.
export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading codes">
      <div className="h-3 w-32 animate-pulse rounded bg-slate-800/70" />
      <div className="space-y-2">
        <div className="h-6 w-56 animate-pulse rounded bg-slate-800" />
        <div className="h-3 w-72 max-w-full animate-pulse rounded bg-slate-800/70" />
      </div>
      <div className="h-56 animate-pulse rounded-xl bg-slate-900/60" />
      <span className="sr-only">Loading codes…</span>
    </div>
  );
}
