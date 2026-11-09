import type { IconName } from "@/lib/dashboard-nav";

// A small set of consistent 24x24 line icons (1.7px round strokes), drawn inline: no icon package, no extra request, identical on server and client.
// Decorative by default (aria-hidden); the control that contains an icon carries the accessible name.

const PATHS: Record<IconName | "menu" | "chevronLeft" | "chevronRight" | "close" | "arrowRight" | "alert", string[]> = {
  dashboard: ["M4 4h6.5v8H4z", "M13.5 4H20v5h-6.5z", "M13.5 12H20v8h-6.5z", "M4 15h6.5v5H4z"],
  products: ["M20.5 7.8 12 3 3.5 7.8v8.4L12 21l8.5-4.8z", "M3.5 7.8 12 12.6l8.5-4.8", "M12 12.6V21"],
  stock: ["M12 3.5 21 8.5 12 13.5 3 8.5z", "M3 12.5l9 5 9-5", "M3 16.5l9 5 9-5"],
  scan: ["M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8", "M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8", "M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16", "M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16", "M4 12h16"],
  movements: ["M4 8h14", "M14.5 4.5 18 8l-3.5 3.5", "M20 16H6", "M9.5 12.5 6 16l3.5 3.5"],
  suppliers: ["M3.5 9.5 5 4.5h14l1.5 5", "M4.5 9.5V20h15V9.5", "M3.5 9.5a2.8 2.8 0 0 0 5.5 0 2.8 2.8 0 0 0 6 0 2.8 2.8 0 0 0 5.5 0", "M10 20v-5h4v5"],
  orders: ["M9 4h6v3H9z", "M7 5.5H6A1.5 1.5 0 0 0 4.5 7v12.5A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5V7A1.5 1.5 0 0 0 18 5.5h-1", "M8.5 12h7", "M8.5 16h5"],
  receipts: ["M3.5 13 6.5 5h11l3 8", "M3.5 13v5.5A1.5 1.5 0 0 0 5 20h14a1.5 1.5 0 0 0 1.5-1.5V13", "M3.5 13h5l1 3h5l1-3h5"],
  clients: ["M16 20v-1.2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4V20", "M10 11a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z", "M20 20v-1.2a3.2 3.2 0 0 0-2.4-3.1", "M15.6 4a3.6 3.6 0 0 1 0 6.9"],
  orderPlus: ["M6 3.5h9l3 3V20.5H6z", "M14.5 3.5V7H18", "M12 11v6", "M9 14h6"],
  lists: ["M9 6.5h11", "M9 12h11", "M9 17.5h11", "M3.8 6.5l1.2 1.2 2-2.4", "M3.8 12l1.2 1.2 2-2.4", "M3.8 17.5l1.2 1.2 2-2.4"],
  dispatches: ["M2.5 6.5h11V16h-11z", "M13.5 9.5H18l3 3.2V16h-7.5", "M7 19.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z", "M17 19.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z"],
  invoices: ["M6 3.5h12V21l-3-2-3 2-3-2-3 2z", "M9 8.5h6", "M9 12.5h6"],
  overview: ["M3.5 3.5v17h17", "M7.5 15.5l3.5-4.5 3 3 5-6.5"],
  accounts: ["M5 4.5h11A3 3 0 0 1 19 7.5V20H8a3 3 0 0 1-3-3z", "M5 17a3 3 0 0 1 3-3h11"],
  expenses: ["M3.5 7.5a2 2 0 0 1 2-2H18v3.5", "M3.5 7.5v11a2 2 0 0 0 2 2H19a1 1 0 0 0 1-1V10a1 1 0 0 0-1-1H5.5a2 2 0 0 1-2-1.5z", "M16 14.5h2"],
  journal: ["M6 3.5h12a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6z", "M9.5 3.5v17", "M12.5 8h3.5", "M12.5 12h3.5"],
  support: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M9.6 9.3a2.5 2.5 0 1 1 3.9 2c-.9.6-1.5 1.1-1.5 2.2", "M12 16.8h.01"],
  settings: ["M4 7h9", "M17 7h3", "M4 17h3", "M11 17h9", "M15 9.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z", "M9 19.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  chevronLeft: ["M14.5 6 8.5 12l6 6"],
  chevronRight: ["M9.5 6l6 6-6 6"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  arrowRight: ["M5 12h14", "M13 6l6 6-6 6"],
  alert: ["M12 3.5 21.5 20h-19z", "M12 10v4.5", "M12 17.5h.01"],
};

export type IconKey = keyof typeof PATHS;

export default function Icon({ name, className = "h-5 w-5" }: { name: IconKey; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" focusable="false">
      {PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
