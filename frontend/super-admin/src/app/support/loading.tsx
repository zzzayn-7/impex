// Shown while the inbox loads on the server.
export default function Loading() {
  return (
    <div className="flex min-h-screen flex-col" aria-busy="true">
      <div className="h-[73px] border-b border-slate-800 bg-slate-900/60" />
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-4 p-8">
        <p className="sr-only" role="status">Loading the Support Inbox…</p>
        <div className="h-8 w-56 animate-pulse rounded bg-slate-800/60" />
        <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/30 p-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-slate-800/40" />
          ))}
        </div>
      </main>
    </div>
  );
}
