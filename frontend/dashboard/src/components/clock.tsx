"use client";

import { createContext, useContext, type ReactNode } from "react";

import { formatStamp } from "@/lib/format";

// The time shown to a person is the time of the country (time zone) the organization chose at its first-time setup - never UTC. The portal frame puts the
// organization's zone here once; every page below reads it (`useStamp()`, `<Stamp />`). The same text is produced on the server and in the browser.

const ZoneContext = createContext<string>("UTC");

export function ClockProvider({ timeZone, children }: { timeZone: string; children: ReactNode }) {
  return <ZoneContext.Provider value={timeZone}>{children}</ZoneContext.Provider>;
}

export const useTimeZone = () => useContext(ZoneContext);

/** A function that writes an instant as "11/11/2026 | 03:45 PM" in the organization's time zone ("—" when there is none). */
export function useStamp(): (iso: string | null | undefined) => string {
  const timeZone = useTimeZone();
  return (iso) => (iso ? formatStamp(iso, timeZone) : "—");
}

export function Stamp({ iso }: { iso: string | null | undefined }) {
  const stamp = useStamp();
  return <>{stamp(iso)}</>;
}
