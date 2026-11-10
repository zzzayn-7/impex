"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The Finance module is ONE destination (the Finance page). The accounting pages that used to be tabs - the accounting overview, Accounts, Expenses and
// Journal Entries - still exist, with all their records and APIs, and are reached from the links at the bottom of the Finance page. On those pages this is
// the way back; on the Finance page itself it shows nothing.
export default function FinanceTabs() {
  const pathname = usePathname() ?? "/finance";
  if (pathname === "/finance") return null;
  return (
    <nav aria-label="Finance" className="mb-4 print:hidden">
      <Link href="/finance" className="text-xs text-ix-accent hover:underline">← Finance</Link>
    </nav>
  );
}
