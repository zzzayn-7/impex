import Link from "next/link";

import LogoutButton from "@/components/logout-button";

// First-time setup frame: the portal's dark slate-teal atmosphere with the Impex identity kept discreet at the top, and Sign out available the whole
// time. The session and the setup state are checked by the page itself, on the server (see page.tsx). The wizard's own panels are slightly more
// opaque glass so the forms stay highly readable.
export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="ix-dash text-ix-text" style={{ fontFamily: 'Inter, Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-6 sm:px-8">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-ix-butter text-sm font-bold text-ix-on-accent">IX</div>
          <span className="text-sm font-medium tracking-tight text-ix-muted">IMPEX</span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/support"
            className="rounded-xl border border-ix-mist/20 bg-ix-mist/10 px-3.5 py-2 text-xs font-medium text-ix-text transition duration-200 hover:bg-ix-mist/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/50 motion-reduce:transition-none"
          >
            Need help? Contact support
          </Link>
          <LogoutButton variant="glass" />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-5 pb-16 sm:px-8">{children}</main>
    </div>
  );
}
