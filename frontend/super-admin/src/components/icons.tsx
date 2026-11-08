// A small set of consistent 24x24 line icons (1.7px round strokes), drawn inline: no icon package, no extra request, identical on server and
// client. Decorative by default (aria-hidden); the control that contains an icon carries the accessible name. Same drawing style as the
// Organization Portal's icons.

const PATHS = {
  dashboard: ["M4 4h6.5v8H4z", "M13.5 4H20v5h-6.5z", "M13.5 12H20v8h-6.5z", "M4 15h6.5v5H4z"],
  organizations: ["M4 21V5.5A1.5 1.5 0 0 1 5.5 4H13v17", "M13 9h5.5A1.5 1.5 0 0 1 20 10.5V21", "M3 21h18", "M8 8h2", "M8 12h2", "M8 16h2"],
  support: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M9.6 9.3a2.5 2.5 0 1 1 3.9 2c-.9.6-1.5 1.1-1.5 2.2", "M12 16.8h.01"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  chevronLeft: ["M14.5 6 8.5 12l6 6"],
  chevronRight: ["M9.5 6l6 6-6 6"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  arrowRight: ["M5 12h14", "M13 6l6 6-6 6"],
} as const;

export type IconKey = keyof typeof PATHS;

export default function Icon({ name, className = "h-5 w-5" }: { name: IconKey; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" focusable="false">
      {PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
