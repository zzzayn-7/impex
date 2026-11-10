import type { WidgetIcon } from "@/lib/dashboard-layout";

// The small line icons of the Add Widgets panel (one per widget kind). Self-contained so the layout components are the same in both portals.
// This file is an identical copy in both portals.

const PATHS: Record<WidgetIcon, string[]> = {
  home: ["M3 11.5 12 4l9 7.5", "M5.5 10v9.5h13V10", "M10 19.5v-5h4v5"],
  box: ["M21 8 12 3 3 8v8l9 5 9-5V8z", "M3 8l9 5 9-5", "M12 13v8"],
  cart: ["M3 4h2.5l2 11h10.5l2-8H6.5", "M9.5 20h.01M17 20h.01"],
  receipt: ["M6 3h12v18l-3-2-3 2-3-2-3 2V3z", "M9 8h6M9 12h6"],
  wallet: ["M3 7.5A2.5 2.5 0 0 1 5.5 5H19v14H5.5A2.5 2.5 0 0 1 3 16.5v-9z", "M16 12h3v3h-3a1.5 1.5 0 0 1 0-3z"],
  trend: ["M3 17l6-6 4 4 8-8", "M15 7h6v6"],
  pie: ["M12 3a9 9 0 1 0 9 9h-9V3z", "M15 3.5A9 9 0 0 1 20.5 9H15V3.5z"],
  activity: ["M3 12h4l3-8 4 16 3-8h4"],
  list: ["M8 6h13M8 12h13M8 18h13", "M3.5 6h.01M3.5 12h.01M3.5 18h.01"],
  ledger: ["M5 3h14v18H5z", "M9 8h6M9 12h6M9 16h3"],
  grid: ["M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"],
  bolt: ["M13 2 4 14h7l-1 8 9-12h-7l1-8z"],
  building: ["M5 21V4h9v17", "M14 9h5v12", "M3 21h18", "M8 8h2M8 12h2M8 16h2"],
  users: ["M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20", "M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M17 4.5a3.5 3.5 0 0 1 0 6.5M20 20v-1.5a3.5 3.5 0 0 0-2.5-3.3"],
  gauge: ["M4.5 17a8.5 8.5 0 1 1 15 0", "M12 13l4-4", "M12 13h.01"],
  server: ["M4 4h16v6H4zM4 14h16v6H4z", "M8 7h.01M8 17h.01"],
  terminal: ["M4 5h16v14H4z", "M7.5 10l3 2.5-3 2.5M13 15h4"],
  book: ["M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16z", "M4 19.5A2.5 2.5 0 0 1 6.5 17H20"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  check: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M8 12.5l3 3 5-6"],
};

export default function WidgetIconGlyph({ name, className = "h-[18px] w-[18px]" }: { name: WidgetIcon; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

/** The header button's icon: a 2x2 layout grid. */
export function LayoutGridIcon({ className = "h-[18px] w-[18px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
    </svg>
  );
}
