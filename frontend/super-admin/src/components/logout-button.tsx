"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Tooltip } from "@/components/ui/tooltip";

// `icon` is the header's sign-out: only the red "gateway out" icon (door with an arrow leaving), named "Sign out" for screen readers and by a tooltip.
export default function LogoutButton({ variant = "default" }: { variant?: "default" | "icon" }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function logout() {
    setLoading(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  if (variant === "icon") {
    return (
      <Tooltip label="Sign out" side="bottom">
        <button type="button" onClick={logout} disabled={loading} aria-label={loading ? "Signing out…" : "Sign out"} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-red-400 transition-colors hover:bg-red-400/10 hover:text-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300/50 disabled:opacity-60 motion-reduce:transition-none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
        </button>
      </Tooltip>
    );
  }

  return (
    <button
      type="button"
      onClick={logout}
      disabled={loading}
      className="whitespace-nowrap rounded-xl border border-ix-mist/20 bg-ix-mist/10 px-3.5 py-2 text-xs font-medium text-ix-text transition duration-200 hover:bg-ix-mist/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent-text/60 disabled:opacity-60 motion-reduce:transition-none"
    >
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}
