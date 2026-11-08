// Shown while the inbox loads on the server: glass-shaped placeholders in the portal's own atmosphere (the real shell appears with the page).
export default function Loading() {
  return (
    <div className="ix-dash" aria-busy="true">
      <div className="px-4 pt-4 sm:px-6 lg:px-8 lg:pl-[104px]">
        <div className="ix-glass mx-auto h-16 max-w-7xl rounded-2xl" />
      </div>
      <main className="mx-auto w-full max-w-7xl space-y-4 px-4 pb-12 pt-6 sm:px-6 lg:pl-[128px] lg:pr-8">
        <p className="sr-only" role="status">Loading the Support Inbox…</p>
        <div className="ix-skeleton h-8 w-56" />
        <div className="ix-panel space-y-2 p-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="ix-skeleton h-12" />
          ))}
        </div>
      </main>
    </div>
  );
}
