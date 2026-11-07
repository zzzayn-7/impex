// The dashboard's loading state: the same glass cards, in the same places, as quiet placeholders (no spinner, no layout jump when the data arrives).
const card = "ix-glass p-5";

export default function Loading() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading your dashboard">
      <div className={`${card} space-y-3 p-7`}>
        <div className="ix-skeleton h-3 w-24" />
        <div className="ix-skeleton h-7 w-72 max-w-full" />
        <div className="ix-skeleton h-3 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr))]">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={`${card} ix-glass-sm space-y-4`}>
            <div className="ix-skeleton h-3 w-28" />
            <div className="ix-skeleton h-8 w-36" />
            <div className="ix-skeleton h-3 w-40 max-w-full" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,26rem),1fr))]">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className={`${card} space-y-4 p-6`}>
            <div className="ix-skeleton h-4 w-44" />
            <div className="ix-skeleton h-44 w-full rounded-2xl" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading your dashboard…</span>
    </div>
  );
}
