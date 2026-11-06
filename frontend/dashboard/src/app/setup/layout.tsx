import Link from "next/link";

import LogoutButton from "@/components/logout-button";

// First-time setup frame: warm ivory canvas, the Impex identity kept discreet at the top, and Sign out available the whole time.
// The theme is local to /setup (arbitrary-value classes): no other page changes. The session and the setup state are checked by the
// page itself, on the server (see page.tsx).
export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen bg-[#EEEDE8] text-[#1B211D]"
      style={{ fontFamily: 'Inter, Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}
    >
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-6 sm:px-8">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#426B58] text-sm font-semibold text-white">IX</div>
          <span className="text-sm font-medium tracking-tight text-[#777F79]">IMPEX</span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/support"
            className="rounded-xl border border-[#E4E8E2] bg-white px-3.5 py-2 text-xs font-medium text-[#426B58] transition duration-200 hover:bg-[#E8F0EA] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#658675]/40 motion-reduce:transition-none"
          >
            Need help? Contact support
          </Link>
          <LogoutButton variant="light" />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-5 pb-16 sm:px-8">{children}</main>
    </div>
  );
}
