export default function Loading() {
  return (
    <div className="space-y-6 rounded-3xl bg-[#EEEDE8] p-4 sm:p-8" role="status" aria-label="Loading Settings">
      <div className="space-y-2">
        <div className="h-7 w-40 animate-pulse rounded bg-[#DDE1D8]" />
        <div className="h-3 w-96 max-w-full animate-pulse rounded bg-[#DDE1D8]/70" />
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-2xl border border-[#E4E8E2] bg-white p-6">
          <div className="h-5 w-48 animate-pulse rounded bg-[#E9ECE6]" />
          <div className="grid gap-3 sm:grid-cols-2">{Array.from({ length: 4 }).map((__, j) => <div key={j} className="h-10 animate-pulse rounded-xl bg-[#F1F3EE]" />)}</div>
        </div>
      ))}
      <span className="sr-only">Loading Settings…</span>
    </div>
  );
}
