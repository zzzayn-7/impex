"use client";

import { createContext, useContext, type ReactNode } from "react";

import { formatStamp, todayIn } from "@/lib/format";

// The time shown to a person is the time of the country (time zone) the organization chose at its first-time setup - never UTC. The portal frame puts the
// organization's zone here once; every page below reads it (`useStamp()`, `<Stamp />`). The same text is produced on the server and in the browser.
// The same goes for the organization's DEFAULT CURRENCY: whatever it chose in setup or Settings is what every form that asks for a currency starts with
// (`useDefaultCurrency()`), and a form that asks for a date starts with today's date in the organization's zone (`useToday()`), so nobody types them again.

const ZoneContext = createContext<string>("UTC");
const CurrencyContext = createContext<string>("USD");

export function ClockProvider({ timeZone, currency = "USD", children }: { timeZone: string; currency?: string; children: ReactNode }) {
  return (
    <ZoneContext.Provider value={timeZone}>
      <CurrencyContext.Provider value={currency}>{children}</CurrencyContext.Provider>
    </ZoneContext.Provider>
  );
}

export const useTimeZone = () => useContext(ZoneContext);

/** The currency the organization chose (3-letter code): the starting value of every currency box. */
export const useDefaultCurrency = () => useContext(CurrencyContext);

/** A function that gives today's date (YYYY-MM-DD) in the organization's time zone: the starting value of every date box. */
export function useToday(): () => string {
  const timeZone = useTimeZone();
  return () => todayIn(timeZone);
}

/** A function that writes an instant as "11/11/2026 | 03:45 PM" in the organization's time zone ("—" when there is none). */
export function useStamp(): (iso: string | null | undefined) => string {
  const timeZone = useTimeZone();
  return (iso) => (iso ? formatStamp(iso, timeZone) : "—");
}

export function Stamp({ iso }: { iso: string | null | undefined }) {
  const stamp = useStamp();
  return <>{stamp(iso)}</>;
}
