"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LogoutButton() {
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
      className="whitespace-nowrap rounded-xl border border-ix-mist/20 bg-ix-mist/10 px-3.5 py-2 text-xs font-medium text-ix-text transition duration-200 hover:bg-ix-mist/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-ix-butter/60 disabled:opacity-60 motion-reduce:transition-none"
    >
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}
