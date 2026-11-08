"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LogoutButton({ variant = "dark" }: { variant?: "dark" | "light" | "glass" }) {
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

  return (
    <button
      type="button"
      onClick={logout}
      disabled={loading}
      className={
        variant === "glass"
          ? "whitespace-nowrap rounded-xl border border-ix-mist/20 bg-ix-mist/10 px-3.5 py-2 text-xs font-medium text-ix-text transition duration-200 hover:bg-ix-mist/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-ix-muted/60 disabled:opacity-60 motion-reduce:transition-none"
          : variant === "light"
          ? "rounded-xl border border-[#E4E8E2] bg-white px-3.5 py-2 text-xs font-medium text-[#426B58] transition duration-200 hover:bg-[#E8F0EA] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#658675]/40 disabled:opacity-60 motion-reduce:transition-none"
          : "rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-60"
      }
    >
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}
